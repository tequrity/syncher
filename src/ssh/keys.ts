// SSH key handling: private-key parsing (OpenSSH, PKCS#1, PKCS#8, SEC1),
// user-auth signatures and host-key signature verification.

import { ed25519 } from '@noble/curves/ed25519.js';
import { p256, p384, p521 } from '@noble/curves/nist.js';
import { sha1, md5 } from '@noble/hashes/legacy.js';
import { sha256, sha512, sha384 } from '@noble/hashes/sha2.js';
import { cbc, ctr, gcm } from '@noble/ciphers/aes.js';
import { Reader, Writer, bytesToBigInt, bigIntToBytes, concat, fromBase64, toBase64, fromUtf8, utf8 } from './buffer';

import bcryptPbkdf from 'bcrypt-pbkdf';

export class KeyPassphraseError extends Error {
	constructor(msg: string) {
		super(msg);
		this.name = 'KeyPassphraseError';
	}
}

type Curve = 'nistp256' | 'nistp384' | 'nistp521';

const CURVES = {
	nistp256: { impl: p256, size: 32, hash: sha256 },
	nistp384: { impl: p384, size: 48, hash: sha384 },
	nistp521: { impl: p521, size: 66, hash: sha512 },
} as const;

export interface PrivateKey {
	type: 'ssh-ed25519' | 'ssh-rsa' | `ecdsa-sha2-${Curve}`;
	publicBlob: Uint8Array;
	/** Algorithms usable for signing, in preference order. */
	algorithms(serverSigAlgs?: string[]): string[];
	sign(alg: string, data: Uint8Array): Uint8Array; // returns signature blob
}

// ---------- RSA ----------

function modPow(base: bigint, exp: bigint, mod: bigint): bigint {
	let result = 1n;
	base %= mod;
	while (exp > 0n) {
		if (exp & 1n) result = (result * base) % mod;
		exp >>= 1n;
		base = (base * base) % mod;
	}
	return result;
}

function modInv(a: bigint, m: bigint): bigint {
	let [oldR, r] = [((a % m) + m) % m, m];
	let [oldS, s] = [1n, 0n];
	while (r !== 0n) {
		const q = oldR / r;
		[oldR, r] = [r, oldR - q * r];
		[oldS, s] = [s, oldS - q * s];
	}
	return ((oldS % m) + m) % m;
}

const DIGEST_INFO: Record<string, { prefix: string; hash: (m: Uint8Array) => Uint8Array }> = {
	'rsa-sha2-512': { prefix: '3051300d060960864801650304020305000440', hash: sha512 },
	'rsa-sha2-256': { prefix: '3031300d060960864801650304020105000420', hash: sha256 },
	'ssh-rsa': { prefix: '3021300906052b0e03021a05000414', hash: sha1 },
};

function hexBytes(h: string): Uint8Array {
	const o = new Uint8Array(h.length / 2);
	for (let i = 0; i < o.length; i++) o[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
	return o;
}

function emsaPkcs1(alg: string, data: Uint8Array, k: number): Uint8Array {
	const d = DIGEST_INFO[alg];
	if (!d) throw new Error(`Unsupported RSA signature algorithm ${alg}`);
	const t = concat(hexBytes(d.prefix), d.hash(data));
	if (k < t.length + 11) throw new Error('RSA key too short');
	const em = new Uint8Array(k);
	em[1] = 1;
	em.fill(0xff, 2, k - t.length - 1);
	em[k - t.length - 1] = 0;
	em.set(t, k - t.length);
	return em;
}

function rsaKey(n: bigint, e: bigint, d: bigint, p: bigint, q: bigint, iqmp?: bigint): PrivateKey {
	const k = Math.ceil(n.toString(16).length / 2);
	const dp = d % (p - 1n);
	const dq = d % (q - 1n);
	const qi = iqmp ?? modInv(q, p);
	const publicBlob = new Writer().string('ssh-rsa').mpint(e).mpint(n).bytes();
	return {
		type: 'ssh-rsa',
		publicBlob,
		algorithms(serverSigAlgs) {
			const pref = ['rsa-sha2-512', 'rsa-sha2-256'];
			if (!serverSigAlgs) return [...pref, 'ssh-rsa'];
			const ok = pref.filter((a) => serverSigAlgs.includes(a));
			return ok.length ? ok : ['ssh-rsa'];
		},
		sign(alg, data) {
			const m = bytesToBigInt(emsaPkcs1(alg, data, k));
			const m1 = modPow(m, dp, p);
			const m2 = modPow(m, dq, q);
			const h = (qi * (((m1 - m2) % p) + p)) % p;
			const s = m2 + h * q;
			return new Writer().string(alg).string(bigIntToBytes(s, k)).bytes();
		},
	};
}

function rsaVerify(alg: string, e: bigint, n: bigint, sig: Uint8Array, data: Uint8Array): boolean {
	const k = Math.ceil(n.toString(16).length / 2);
	if (sig.length > k) return false;
	const m = modPow(bytesToBigInt(sig), e, n);
	const em = emsaPkcs1(alg, data, k);
	const got = bigIntToBytes(m, k);
	let diff = 0;
	for (let i = 0; i < k; i++) diff |= got[i] ^ em[i];
	return diff === 0;
}

// ---------- ed25519 / ecdsa ----------

function ed25519Key(seed: Uint8Array, pub?: Uint8Array): PrivateKey {
	const pk = pub ?? ed25519.getPublicKey(seed);
	const publicBlob = new Writer().string('ssh-ed25519').string(pk).bytes();
	return {
		type: 'ssh-ed25519',
		publicBlob,
		algorithms: () => ['ssh-ed25519'],
		sign(alg, data) {
			return new Writer().string(alg).string(ed25519.sign(data, seed)).bytes();
		},
	};
}

function ecdsaKey(curve: Curve, d: Uint8Array, q?: Uint8Array): PrivateKey {
	const c = CURVES[curve];
	const priv = new Uint8Array(c.size);
	const dd = d.length > c.size ? d.subarray(d.length - c.size) : d;
	priv.set(dd, c.size - dd.length);
	const pub = q ?? c.impl.getPublicKey(priv, false);
	const name = `ecdsa-sha2-${curve}` as const;
	const publicBlob = new Writer().string(name).string(curve).string(pub).bytes();
	return {
		type: name,
		publicBlob,
		algorithms: () => [name],
		sign(alg, data) {
			const sig = c.impl.sign(c.hash(data), priv, { prehash: false });
			const r = bytesToBigInt(sig.subarray(0, c.size));
			const s = bytesToBigInt(sig.subarray(c.size));
			const inner = new Writer().mpint(r).mpint(s).bytes();
			return new Writer().string(alg).string(inner).bytes();
		},
	};
}

// ---------- host key verification ----------

export function verifyHostSignature(hostKeyBlob: Uint8Array, sigBlob: Uint8Array, data: Uint8Array): boolean {
	const kr = new Reader(hostKeyBlob);
	const ktype = kr.text();
	const sr = new Reader(sigBlob);
	const salg = sr.text();
	const sig = sr.string();
	if (ktype === 'ssh-ed25519') {
		if (salg !== 'ssh-ed25519') return false;
		return ed25519.verify(sig, data, kr.string());
	}
	if (ktype === 'ssh-rsa') {
		if (!DIGEST_INFO[salg]) return false;
		const e = kr.mpint();
		const n = kr.mpint();
		return rsaVerify(salg, e, n, sig, data);
	}
	if (ktype.startsWith('ecdsa-sha2-')) {
		const curve = kr.text() as Curve;
		const c = CURVES[curve];
		if (!c || salg !== ktype) return false;
		const q = kr.string();
		const ir = new Reader(sig);
		const r = ir.mpint();
		const s = ir.mpint();
		const compact = concat(bigIntToBytes(r, c.size), bigIntToBytes(s, c.size));
		return c.impl.verify(compact, c.hash(data), q, { prehash: false, lowS: false });
	}
	return false;
}

export function fingerprint(blob: Uint8Array): string {
	return 'SHA256:' + toBase64(sha256(blob)).replace(/=+$/, '');
}

export function publicKeyType(blob: Uint8Array): string {
	return new Reader(blob).text();
}

// ---------- private key parsing ----------

function pemBody(text: string): { label: string; headers: Record<string, string>; der: Uint8Array } {
	const m = /-----BEGIN ([A-Z0-9 ]+)-----([\s\S]*?)-----END \1-----/.exec(text);
	if (!m) throw new Error('Not a PEM/OpenSSH private key');
	const headers: Record<string, string> = {};
	const lines = m[2].split(/\r?\n/);
	const body: string[] = [];
	for (const line of lines) {
		const h = /^([A-Za-z-]+):\s*(.*)$/.exec(line.trim());
		if (h) headers[h[1]] = h[2];
		else body.push(line.trim());
	}
	return { label: m[1], headers, der: fromBase64(body.join('')) };
}

const CIPHERS: Record<string, { keyLen: number; ivLen: number; mode: 'ctr' | 'cbc' | 'gcm' }> = {
	'aes128-ctr': { keyLen: 16, ivLen: 16, mode: 'ctr' },
	'aes192-ctr': { keyLen: 24, ivLen: 16, mode: 'ctr' },
	'aes256-ctr': { keyLen: 32, ivLen: 16, mode: 'ctr' },
	'aes128-cbc': { keyLen: 16, ivLen: 16, mode: 'cbc' },
	'aes192-cbc': { keyLen: 24, ivLen: 16, mode: 'cbc' },
	'aes256-cbc': { keyLen: 32, ivLen: 16, mode: 'cbc' },
	'aes256-gcm@openssh.com': { keyLen: 32, ivLen: 12, mode: 'gcm' },
};

function parseOpenSsh(data: Uint8Array, passphrase: string | undefined): PrivateKey {
	const magic = 'openssh-key-v1\0';
	if (fromUtf8(data.subarray(0, magic.length)) !== magic) throw new Error('Bad OpenSSH key magic');
	const r = new Reader(data.subarray(magic.length));
	const cipherName = r.text();
	const kdfName = r.text();
	const kdfOpts = r.string();
	const nkeys = r.u32();
	if (nkeys !== 1) throw new Error('Multi-key files are not supported');
	r.string(); // public key
	let priv = r.string();
	const tagRest = r.rest();
	if (cipherName !== 'none') {
		if (!passphrase) throw new KeyPassphraseError('Key is encrypted: passphrase required');
		const c = CIPHERS[cipherName];
		if (!c) throw new Error(`Unsupported key cipher ${cipherName}`);
		if (kdfName !== 'bcrypt') throw new Error(`Unsupported key KDF ${kdfName}`);
		const kr = new Reader(kdfOpts);
		const salt = kr.string();
		const rounds = kr.u32();
		const pass = utf8(passphrase);
		const out = new Uint8Array(c.keyLen + c.ivLen);
		if (bcryptPbkdf.pbkdf(pass, pass.length, salt, salt.length, out, out.length, rounds) !== 0)
			throw new Error('bcrypt_pbkdf failed');
		const key = out.subarray(0, c.keyLen);
		const iv = out.subarray(c.keyLen);
		if (c.mode === 'ctr') priv = ctr(key, iv).decrypt(priv);
		else if (c.mode === 'cbc') priv = cbc(key, iv, { disablePadding: true }).decrypt(priv);
		else {
			try {
				priv = gcm(key, iv).decrypt(concat(priv, tagRest.subarray(0, 16)));
			} catch {
				throw new KeyPassphraseError('Wrong key passphrase');
			}
		}
	}
	const pr = new Reader(priv);
	const check1 = pr.u32();
	const check2 = pr.u32();
	if (check1 !== check2) throw new KeyPassphraseError('Wrong key passphrase');
	const type = pr.text();
	if (type === 'ssh-ed25519') {
		const pk = pr.string();
		const sk = pr.string();
		return ed25519Key(sk.slice(0, 32), pk.slice());
	}
	if (type === 'ssh-rsa') {
		const n = pr.mpint();
		const e = pr.mpint();
		const d = pr.mpint();
		const iqmp = pr.mpint();
		const p = pr.mpint();
		const q = pr.mpint();
		return rsaKey(n, e, d, p, q, iqmp);
	}
	if (type.startsWith('ecdsa-sha2-')) {
		const curve = pr.text() as Curve;
		if (!CURVES[curve]) throw new Error(`Unsupported curve ${curve}`);
		const q = pr.string();
		const d = pr.string();
		return ecdsaKey(curve, d.slice(), q.slice());
	}
	throw new Error(`Unsupported key type ${type}`);
}

// Minimal DER reader for PKCS#1 / PKCS#8 / SEC1.
interface Der {
	tag: number;
	body: Uint8Array;
}

function derRead(buf: Uint8Array, pos: number): { node: Der; next: number } {
	const tag = buf[pos++];
	let len = buf[pos++];
	if (len & 0x80) {
		const n = len & 0x7f;
		len = 0;
		for (let i = 0; i < n; i++) len = len * 256 + buf[pos++];
	}
	return { node: { tag, body: buf.subarray(pos, pos + len) }, next: pos + len };
}

function derChildren(buf: Uint8Array): Der[] {
	const out: Der[] = [];
	let pos = 0;
	while (pos < buf.length) {
		const { node, next } = derRead(buf, pos);
		out.push(node);
		pos = next;
	}
	return out;
}

function derSeq(buf: Uint8Array): Der[] {
	return derChildren(derRead(buf, 0).node.body);
}

const OID_RSA = '2a864886f70d010101';
const OID_EC = '2a8648ce3d0201';
const OID_ED25519 = '2b6570';
const EC_OIDS: Record<string, Curve> = {
	'2a8648ce3d030107': 'nistp256',
	'2b81040022': 'nistp384',
	'2b81040023': 'nistp521',
};

function hex(b: Uint8Array): string {
	let s = '';
	for (const x of b) s += x.toString(16).padStart(2, '0');
	return s;
}

function parsePkcs1Rsa(der: Uint8Array): PrivateKey {
	const f = derSeq(der).map((x) => bytesToBigInt(x.body));
	// version, n, e, d, p, q, dp, dq, qi
	return rsaKey(f[1], f[2], f[3], f[4], f[5], f[8]);
}

function parseSec1(der: Uint8Array, curveHint?: Curve): PrivateKey {
	const f = derSeq(der);
	const d = f[1].body;
	let curve = curveHint;
	for (const x of f.slice(2)) {
		if (x.tag === 0xa0) curve = EC_OIDS[hex(derRead(x.body, 0).node.body)];
	}
	if (!curve) throw new Error('Unsupported EC curve');
	return ecdsaKey(curve, d);
}

function parsePkcs8(der: Uint8Array): PrivateKey {
	const f = derSeq(der);
	const alg = derChildren(f[1].body);
	const oid = hex(alg[0].body);
	const inner = f[2].body;
	if (oid === OID_RSA) return parsePkcs1Rsa(inner);
	if (oid === OID_ED25519) return ed25519Key(derRead(inner, 0).node.body.slice(0, 32));
	if (oid === OID_EC) return parseSec1(inner, EC_OIDS[hex(alg[1].body)]);
	throw new Error('Unsupported PKCS#8 key algorithm');
}

function evpBytesToKey(pass: Uint8Array, salt: Uint8Array, keyLen: number): Uint8Array {
	let out: Uint8Array = new Uint8Array(0);
	let prev: Uint8Array = new Uint8Array(0);
	while (out.length < keyLen) {
		prev = md5(concat(prev, pass, salt));
		out = concat(out, prev);
	}
	return out.subarray(0, keyLen);
}

export function parsePrivateKey(text: string, passphrase?: string): PrivateKey {
	const { label, headers, der } = pemBody(text);
	if (label === 'OPENSSH PRIVATE KEY') return parseOpenSsh(der, passphrase);
	if (label === 'ENCRYPTED PRIVATE KEY')
		throw new Error('Encrypted PKCS#8 keys are not supported; convert with: ssh-keygen -p -f <key>');
	let body = der;
	if (headers['Proc-Type']?.includes('ENCRYPTED')) {
		if (!passphrase) throw new KeyPassphraseError('Key is encrypted: passphrase required');
		const [algo, ivHex] = (headers['DEK-Info'] ?? '').split(',');
		const keyLen = { 'AES-128-CBC': 16, 'AES-192-CBC': 24, 'AES-256-CBC': 32 }[algo];
		if (!keyLen) throw new Error(`Unsupported PEM encryption ${algo}; convert with: ssh-keygen -p -f <key>`);
		const iv = hexBytes(ivHex);
		const key = evpBytesToKey(utf8(passphrase), iv.subarray(0, 8), keyLen);
		try {
			body = cbc(key, iv).decrypt(der);
		} catch {
			throw new KeyPassphraseError('Wrong key passphrase');
		}
	}
	try {
		if (label === 'RSA PRIVATE KEY') return parsePkcs1Rsa(body);
		if (label === 'EC PRIVATE KEY') return parseSec1(body);
		if (label === 'PRIVATE KEY') return parsePkcs8(body);
	} catch (e) {
		if (headers['Proc-Type']) throw new KeyPassphraseError('Wrong key passphrase');
		throw e;
	}
	throw new Error(`Unsupported key format: ${label}`);
}
