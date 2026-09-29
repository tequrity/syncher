// SSH binary packet protection (RFC 4253 §6, RFC 5647, PROTOCOL.chacha20poly1305,
// encrypt-then-MAC variants from OpenSSH).

import { chacha20orig } from '@noble/ciphers/chacha.js';
import { poly1305 } from '@noble/ciphers/_poly1305.js';
import { ctr, gcm } from '@noble/ciphers/aes.js';
import { hmac } from '@noble/hashes/hmac.js';
import { sha256, sha512 } from '@noble/hashes/sha2.js';
import type { CHash } from '@noble/hashes/utils.js';
import { concat, equalBytes } from './buffer';

export const CIPHER_ALGS = [
	'chacha20-poly1305@openssh.com',
	'aes256-gcm@openssh.com',
	'aes128-gcm@openssh.com',
	'aes256-ctr',
	'aes192-ctr',
	'aes128-ctr',
];

export const MAC_ALGS = [
	'hmac-sha2-256-etm@openssh.com',
	'hmac-sha2-512-etm@openssh.com',
	'hmac-sha2-256',
	'hmac-sha2-512',
];

interface CipherInfo {
	keyLen: number;
	ivLen: number;
	blockSize: number;
	aead: boolean;
}

export const CIPHER_INFO: Record<string, CipherInfo> = {
	'chacha20-poly1305@openssh.com': { keyLen: 64, ivLen: 0, blockSize: 8, aead: true },
	'aes256-gcm@openssh.com': { keyLen: 32, ivLen: 12, blockSize: 16, aead: true },
	'aes128-gcm@openssh.com': { keyLen: 16, ivLen: 12, blockSize: 16, aead: true },
	'aes256-ctr': { keyLen: 32, ivLen: 16, blockSize: 16, aead: false },
	'aes192-ctr': { keyLen: 24, ivLen: 16, blockSize: 16, aead: false },
	'aes128-ctr': { keyLen: 16, ivLen: 16, blockSize: 16, aead: false },
};

export const MAC_INFO: Record<string, { keyLen: number; etm: boolean; hash: CHash }> = {
	'hmac-sha2-256-etm@openssh.com': { keyLen: 32, etm: true, hash: sha256 },
	'hmac-sha2-512-etm@openssh.com': { keyLen: 64, etm: true, hash: sha512 },
	'hmac-sha2-256': { keyLen: 32, etm: false, hash: sha256 },
	'hmac-sha2-512': { keyLen: 64, etm: false, hash: sha512 },
};

function randomBytes(n: number): Uint8Array {
	const b = new Uint8Array(n);
	crypto.getRandomValues(b);
	return b;
}

function u32be(v: number): Uint8Array {
	return new Uint8Array([(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff]);
}

function readU32(b: Uint8Array, off = 0): number {
	return ((b[off] << 24) | (b[off + 1] << 16) | (b[off + 2] << 8) | b[off + 3]) >>> 0;
}

function seqNonce(seq: number): Uint8Array {
	const n = new Uint8Array(8);
	n.set(u32be(seq), 4);
	return n;
}

/** Streaming AES-CTR over a 128-bit big-endian counter. */
class CtrStream {
	private iv: Uint8Array;
	constructor(
		private key: Uint8Array,
		iv: Uint8Array,
	) {
		this.iv = iv.slice();
	}
	process(data: Uint8Array): Uint8Array {
		if (data.length % 16) throw new Error('CTR: unaligned');
		const out = ctr(this.key, this.iv).encrypt(data);
		let blocks = data.length / 16;
		for (let i = 15; i >= 0 && blocks > 0; i--) {
			const sum = this.iv[i] + (blocks & 0xff);
			this.iv[i] = sum & 0xff;
			blocks = Math.floor(blocks / 256) + (sum >> 8);
		}
		return out;
	}
}

class GcmNonce {
	private n: Uint8Array;
	constructor(iv: Uint8Array) {
		this.n = iv.slice();
	}
	next(): Uint8Array {
		const cur = this.n.slice();
		for (let i = 11; i >= 4; i--) {
			this.n[i] = (this.n[i] + 1) & 0xff;
			if (this.n[i] !== 0) break;
		}
		return cur;
	}
}

export interface DirectionKeys {
	cipher: string;
	mac: string; // ignored for AEAD
	key: Uint8Array;
	iv: Uint8Array;
	macKey: Uint8Array;
}

/** Outgoing packet builder. */
export class PacketEncoder {
	private blockSize = 8;
	private mode: 'none' | 'chacha' | 'gcm' | 'ctr' = 'none';
	private ctrStream?: CtrStream;
	private gcmNonce?: GcmNonce;
	private key: Uint8Array = new Uint8Array(0);
	private macKey: Uint8Array = new Uint8Array(0);
	private macHash?: CHash;
	private etm = false;
	seq = 0;

	setKeys(k: DirectionKeys): void {
		const info = CIPHER_INFO[k.cipher];
		this.blockSize = info.blockSize;
		this.key = k.key;
		if (k.cipher.startsWith('chacha20')) this.mode = 'chacha';
		else if (k.cipher.includes('gcm')) {
			this.mode = 'gcm';
			this.gcmNonce = new GcmNonce(k.iv);
		} else {
			this.mode = 'ctr';
			this.ctrStream = new CtrStream(k.key, k.iv);
			const m = MAC_INFO[k.mac];
			this.macHash = m.hash;
			this.macKey = k.macKey;
			this.etm = m.etm;
		}
	}

	encode(payload: Uint8Array): Uint8Array {
		const seq = this.seq;
		this.seq = (this.seq + 1) >>> 0;
		const bs = this.blockSize;
		const aadLen = this.mode === 'none' || (this.mode === 'ctr' && !this.etm) ? 0 : 4;
		let pad = bs - ((4 + 1 + payload.length - aadLen) % bs);
		if (pad < 4) pad += bs;
		const packetLen = 1 + payload.length + pad;
		const plain = new Uint8Array(4 + packetLen);
		plain.set(u32be(packetLen), 0);
		plain[4] = pad;
		plain.set(payload, 5);
		plain.set(randomBytes(pad), 5 + payload.length);

		switch (this.mode) {
			case 'none':
				return plain;
			case 'chacha': {
				const k2 = this.key.subarray(0, 32);
				const k1 = this.key.subarray(32, 64);
				const nonce = seqNonce(seq);
				const encLen = chacha20orig(k1, nonce, plain.subarray(0, 4));
				const polyKey = chacha20orig(k2, nonce, new Uint8Array(32));
				const encBody = chacha20orig(k2, nonce, plain.subarray(4), undefined, 1);
				const ct = concat(encLen, encBody);
				return concat(ct, poly1305(ct, polyKey));
			}
			case 'gcm': {
				const nonce = this.gcmNonce!.next();
				const aad = plain.subarray(0, 4);
				const sealed = gcm(this.key, nonce, aad).encrypt(plain.subarray(4));
				return concat(aad, sealed);
			}
			case 'ctr': {
				if (this.etm) {
					const enc = concat(plain.subarray(0, 4), this.ctrStream!.process(plain.subarray(4)));
					const mac = hmac(this.macHash!, this.macKey, concat(u32be(seq), enc));
					return concat(enc, mac);
				}
				const mac = hmac(this.macHash!, this.macKey, concat(u32be(seq), plain));
				return concat(this.ctrStream!.process(plain), mac);
			}
		}
	}
}

/** Incoming packet parser. Feed bytes, pull decrypted payloads. */
export class PacketDecoder {
	private blockSize = 8;
	private mode: 'none' | 'chacha' | 'gcm' | 'ctr' = 'none';
	private ctrStream?: CtrStream;
	private gcmNonce?: GcmNonce;
	private key: Uint8Array = new Uint8Array(0);
	private macKey: Uint8Array = new Uint8Array(0);
	private macHash?: CHash;
	private macLen = 0;
	private etm = false;
	private firstBlock?: Uint8Array; // decrypted first block (ctr non-etm)
	private chunks: Uint8Array[] = [];
	private total = 0;
	seq = 0;

	setKeys(k: DirectionKeys): void {
		const info = CIPHER_INFO[k.cipher];
		this.blockSize = info.blockSize;
		this.key = k.key;
		this.firstBlock = undefined;
		if (k.cipher.startsWith('chacha20')) this.mode = 'chacha';
		else if (k.cipher.includes('gcm')) {
			this.mode = 'gcm';
			this.gcmNonce = new GcmNonce(k.iv);
		} else {
			this.mode = 'ctr';
			this.ctrStream = new CtrStream(k.key, k.iv);
			const m = MAC_INFO[k.mac];
			this.macHash = m.hash;
			this.macKey = k.macKey;
			this.macLen = m.hash.outputLen;
			this.etm = m.etm;
		}
	}

	push(data: Uint8Array): void {
		if (!data.length) return;
		this.chunks.push(data);
		this.total += data.length;
	}

	private peek(n: number): Uint8Array {
		if (this.chunks[0].length >= n) return this.chunks[0].subarray(0, n);
		const all = concat(...this.chunks);
		this.chunks = [all];
		return all.subarray(0, n);
	}

	private take(n: number): Uint8Array {
		const out = this.peek(n).slice();
		let left = n;
		while (left > 0) {
			const c = this.chunks[0];
			if (c.length <= left) {
				left -= c.length;
				this.chunks.shift();
			} else {
				this.chunks[0] = c.subarray(left);
				left = 0;
			}
		}
		this.total -= n;
		return out;
	}

	/** Returns the next payload, or null if more bytes are needed. Throws on integrity failure. */
	next(): Uint8Array | null {
		const seq = this.seq;
		let packetLen: number;
		let body: Uint8Array; // padding_length || payload || padding

		switch (this.mode) {
			case 'none': {
				if (this.total < 4) return null;
				packetLen = readU32(this.peek(4));
				this.checkLen(packetLen);
				if (this.total < 4 + packetLen) return null;
				body = this.take(4 + packetLen).subarray(4);
				break;
			}
			case 'chacha': {
				if (this.total < 4) return null;
				const k2 = this.key.subarray(0, 32);
				const k1 = this.key.subarray(32, 64);
				const nonce = seqNonce(seq);
				packetLen = readU32(chacha20orig(k1, nonce, this.peek(4).slice()));
				this.checkLen(packetLen);
				if (this.total < 4 + packetLen + 16) return null;
				const pkt = this.take(4 + packetLen + 16);
				const ct = pkt.subarray(0, 4 + packetLen);
				const tag = pkt.subarray(4 + packetLen);
				const polyKey = chacha20orig(k2, nonce, new Uint8Array(32));
				if (!equalBytes(poly1305(ct, polyKey), tag)) throw new Error('SSH: MAC verification failed');
				body = chacha20orig(k2, nonce, ct.subarray(4), undefined, 1);
				break;
			}
			case 'gcm': {
				if (this.total < 4) return null;
				packetLen = readU32(this.peek(4));
				this.checkLen(packetLen);
				if (this.total < 4 + packetLen + 16) return null;
				const pkt = this.take(4 + packetLen + 16);
				try {
					body = gcm(this.key, this.gcmNonce!.next(), pkt.subarray(0, 4)).decrypt(pkt.subarray(4));
				} catch {
					throw new Error('SSH: MAC verification failed');
				}
				break;
			}
			case 'ctr': {
				if (this.etm) {
					if (this.total < 4) return null;
					packetLen = readU32(this.peek(4));
					this.checkLen(packetLen);
					if (this.total < 4 + packetLen + this.macLen) return null;
					const pkt = this.take(4 + packetLen + this.macLen);
					const enc = pkt.subarray(0, 4 + packetLen);
					const mac = hmac(this.macHash!, this.macKey, concat(u32be(seq), enc));
					if (!equalBytes(mac, pkt.subarray(4 + packetLen))) throw new Error('SSH: MAC verification failed');
					body = this.ctrStream!.process(enc.subarray(4));
				} else {
					const bs = this.blockSize;
					if (!this.firstBlock) {
						if (this.total < bs) return null;
						this.firstBlock = this.ctrStream!.process(this.take(bs));
					}
					packetLen = readU32(this.firstBlock);
					this.checkLen(packetLen);
					const rest = 4 + packetLen - bs;
					if (this.total < rest + this.macLen) return null;
					const plain = concat(this.firstBlock, this.ctrStream!.process(this.take(rest)));
					this.firstBlock = undefined;
					const mac = hmac(this.macHash!, this.macKey, concat(u32be(seq), plain));
					if (!equalBytes(mac, this.take(this.macLen))) throw new Error('SSH: MAC verification failed');
					body = plain.subarray(4);
				}
				break;
			}
		}
		this.seq = (this.seq + 1) >>> 0;
		const padLen = body[0];
		return body.subarray(1, body.length - padLen);
	}

	private checkLen(n: number): void {
		if (n < 5 || n > 256 * 1024) throw new Error(`SSH: bad packet length ${n}`);
	}
}
