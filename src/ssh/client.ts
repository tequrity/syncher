// Minimal, dependency-light SSH-2 client: transport (RFC 4253), user auth
// (RFC 4252/4256) and session channels (RFC 4254). Enough to run SFTP.
// Pure TypeScript on top of @noble crypto so the same code runs on
// Electron (Windows/Linux) and on Obsidian mobile (Android WebView).

import { x25519 } from '@noble/curves/ed25519.js';
import { p256, p384, p521 } from '@noble/curves/nist.js';
import { sha256, sha384, sha512 } from '@noble/hashes/sha2.js';
import { Reader, Writer, concat, fromUtf8, utf8 } from './buffer';
import { CIPHER_ALGS, CIPHER_INFO, MAC_ALGS, MAC_INFO, PacketDecoder, PacketEncoder, DirectionKeys } from './cipher';
import { PrivateKey, fingerprint, publicKeyType, verifyHostSignature } from './keys';
import { Duplex } from './socket';

export const MSG = {
	DISCONNECT: 1,
	IGNORE: 2,
	UNIMPLEMENTED: 3,
	DEBUG: 4,
	SERVICE_REQUEST: 5,
	SERVICE_ACCEPT: 6,
	EXT_INFO: 7,
	KEXINIT: 20,
	NEWKEYS: 21,
	KEX_ECDH_INIT: 30,
	KEX_ECDH_REPLY: 31,
	USERAUTH_REQUEST: 50,
	USERAUTH_FAILURE: 51,
	USERAUTH_SUCCESS: 52,
	USERAUTH_BANNER: 53,
	USERAUTH_60: 60,
	USERAUTH_INFO_RESPONSE: 61,
	GLOBAL_REQUEST: 80,
	REQUEST_SUCCESS: 81,
	REQUEST_FAILURE: 82,
	CHANNEL_OPEN: 90,
	CHANNEL_OPEN_CONFIRMATION: 91,
	CHANNEL_OPEN_FAILURE: 92,
	CHANNEL_WINDOW_ADJUST: 93,
	CHANNEL_DATA: 94,
	CHANNEL_EXTENDED_DATA: 95,
	CHANNEL_EOF: 96,
	CHANNEL_CLOSE: 97,
	CHANNEL_REQUEST: 98,
	CHANNEL_SUCCESS: 99,
	CHANNEL_FAILURE: 100,
} as const;

const KEX_ALGS = [
	'curve25519-sha256',
	'curve25519-sha256@libssh.org',
	'ecdh-sha2-nistp256',
	'ecdh-sha2-nistp384',
	'ecdh-sha2-nistp521',
];
const HOSTKEY_ALGS = [
	'ssh-ed25519',
	'ecdsa-sha2-nistp256',
	'ecdsa-sha2-nistp384',
	'ecdsa-sha2-nistp521',
	'rsa-sha2-512',
	'rsa-sha2-256',
];

const CLIENT_VERSION = 'SSH-2.0-Obsyncher_1.0';

export interface HostKeyInfo {
	type: string;
	fingerprint: string;
	blob: Uint8Array;
}

export interface SshOptions {
	username: string;
	password?: string;
	privateKey?: PrivateKey;
	/** Return true to trust the host key. Called once per connection (first KEX). */
	verifyHostKey: (info: HostKeyInfo) => boolean;
	timeoutMs?: number;
	keepaliveMs?: number;
	onBanner?: (text: string) => void;
	/** Algorithm preference overrides (tests / exotic servers). */
	algorithms?: { kex?: string[]; hostKey?: string[]; cipher?: string[]; mac?: string[] };
}

export class SshAuthError extends Error {
	constructor(msg: string) {
		super(msg);
		this.name = 'SshAuthError';
	}
}

export class HostKeyMismatchError extends Error {
	constructor(readonly info: HostKeyInfo) {
		super(`Host key rejected: ${info.type} ${info.fingerprint}`);
		this.name = 'HostKeyMismatchError';
	}
}

type Waiter = { resolve: (p: Uint8Array) => void; reject: (e: Error) => void };

interface KexAlgs {
	kex: string;
	hostKey: string;
	cipherCS: string;
	cipherSC: string;
	macCS: string;
	macSC: string;
	strict: boolean;
}

function negotiate(client: string[], server: string[], what: string): string {
	for (const a of client) if (server.includes(a)) return a;
	throw new Error(`SSH: no common ${what} algorithm (server offers: ${server.join(',')})`);
}

export class Channel {
	remoteId = 0;
	remoteWindow = 0;
	remoteMaxPacket = 32768;
	localWindow: number;
	private outQueue: Uint8Array[] = [];
	closed = false;
	onData: (d: Uint8Array) => void = () => undefined;
	/** Called once; `err` is set when the whole SSH connection died. */
	onClose: (err?: Error) => void = () => undefined;
	openWaiter?: { resolve: () => void; reject: (e: Error) => void };
	requestWaiters: { resolve: (ok: boolean) => void }[] = [];

	constructor(
		readonly client: SshClient,
		readonly localId: number,
		readonly initialWindow: number,
	) {
		this.localWindow = initialWindow;
	}

	write(data: Uint8Array): void {
		if (this.closed) throw new Error('SSH channel closed');
		this.outQueue.push(data);
		this.flush();
	}

	flush(): void {
		while (this.outQueue.length && this.remoteWindow > 0) {
			const head = this.outQueue[0];
			const n = Math.min(head.length, this.remoteWindow, this.remoteMaxPacket);
			const chunk = head.subarray(0, n);
			if (n === head.length) this.outQueue.shift();
			else this.outQueue[0] = head.subarray(n);
			this.remoteWindow -= n;
			this.client.send(new Writer().byte(MSG.CHANNEL_DATA).u32(this.remoteId).string(chunk).bytes());
		}
	}

	request(type: string, wantReply: boolean, extra?: Uint8Array): Promise<boolean> {
		const w = new Writer().byte(MSG.CHANNEL_REQUEST).u32(this.remoteId).string(type).bool(wantReply);
		if (extra) w.raw(extra);
		this.client.send(w.bytes());
		if (!wantReply) return Promise.resolve(true);
		return new Promise((resolve) => this.requestWaiters.push({ resolve }));
	}

	consumed(n: number): void {
		this.localWindow -= n;
		if (this.localWindow < this.initialWindow / 2) {
			const add = this.initialWindow - this.localWindow;
			this.localWindow += add;
			this.client.send(new Writer().byte(MSG.CHANNEL_WINDOW_ADJUST).u32(this.remoteId).u32(add).bytes());
		}
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		try {
			this.client.send(new Writer().byte(MSG.CHANNEL_CLOSE).u32(this.remoteId).bytes());
		} catch {
			/* connection gone */
		}
	}
}

export class SshClient {
	private enc = new PacketEncoder();
	private dec = new PacketDecoder();
	private versionBuf: Uint8Array = new Uint8Array(0);
	private gotVersion = false;
	private serverVersion = '';
	private sessionId?: Uint8Array;
	private hostKeyBlob?: Uint8Array;
	private clientKexInit?: Uint8Array;
	private serverKexInit?: Uint8Array;
	private kexAlgs?: KexAlgs;
	private kexActive = false;
	private kexSentInit = false;
	private kexPriv?: Uint8Array;
	private kexPub?: Uint8Array;
	private pendingKeysIn?: DirectionKeys;
	private firstKex = true;
	private strictKex = false;
	private queued: Uint8Array[] = [];
	private inbox: Uint8Array[] = [];
	private inboxWaiters: Waiter[] = [];
	private kexDone?: { resolve: () => void; reject: (e: Error) => void };
	private channels = new Map<number, Channel>();
	private nextChannelId = 0;
	private authenticated = false;
	private globalWaiters: ((ok: boolean) => void)[] = [];
	private keepaliveTimer?: number;
	private missedKeepalives = 0;
	private closedErr?: Error;
	serverSigAlgs?: string[];
	hostKey?: HostKeyInfo;
	onClose: (err?: Error) => void = () => undefined;

	private readonly kexList: string[];
	private readonly hostKeyList: string[];
	private readonly cipherList: string[];
	private readonly macList: string[];

	private constructor(
		private sock: Duplex,
		private opts: SshOptions,
	) {
		const a = opts.algorithms ?? {};
		this.kexList = a.kex ?? KEX_ALGS;
		this.hostKeyList = a.hostKey ?? HOSTKEY_ALGS;
		this.cipherList = a.cipher ?? CIPHER_ALGS;
		this.macList = a.mac ?? MAC_ALGS;
	}

	get closed(): boolean {
		return !!this.closedErr;
	}

	static async connect(sock: Duplex, opts: SshOptions): Promise<SshClient> {
		const c = new SshClient(sock, opts);
		const timeout = opts.timeoutMs ?? 20000;
		let timer: number | undefined;
		try {
			await Promise.race([
				c.handshake(),
				new Promise<never>((_, rej) => {
					timer = window.setTimeout(() => rej(new Error('SSH handshake timeout')), timeout);
				}),
			]);
		} catch (e) {
			c.shutdown(e as Error);
			throw e;
		} finally {
			window.clearTimeout(timer);
		}
		c.startKeepalive();
		return c;
	}

	private async handshake(): Promise<void> {
		this.sock.onData = (d) => this.onBytes(d);
		this.sock.onClose = (e) => this.shutdown(e ?? new Error('Connection closed'));
		const kexDone = new Promise<void>((resolve, reject) => (this.kexDone = { resolve, reject }));
		this.sock.write(utf8(CLIENT_VERSION + '\r\n'));
		this.sendKexInit();
		await kexDone;
		this.send(new Writer().byte(MSG.SERVICE_REQUEST).string('ssh-userauth').bytes());
		let msg = await this.recv();
		// EXT_INFO may precede SERVICE_ACCEPT
		while (msg[0] !== MSG.SERVICE_ACCEPT) {
			if (msg[0] !== MSG.EXT_INFO) throw new Error(`SSH: unexpected message ${msg[0]} awaiting service accept`);
			msg = await this.recv();
		}
		await this.authenticate();
	}

	// ---------------- low-level I/O ----------------

	private onBytes(data: Uint8Array): void {
		if (this.closedErr) return;
		try {
			if (!this.gotVersion) {
				this.versionBuf = concat(this.versionBuf, data);
				for (;;) {
					const nl = this.versionBuf.indexOf(10);
					if (nl < 0) {
						if (this.versionBuf.length > 8192) throw new Error('SSH: no version banner');
						return;
					}
					const line = fromUtf8(this.versionBuf.subarray(0, nl)).replace(/\r$/, '');
					this.versionBuf = this.versionBuf.subarray(nl + 1);
					if (line.startsWith('SSH-')) {
						if (!line.startsWith('SSH-2.0-') && !line.startsWith('SSH-1.99-'))
							throw new Error(`SSH: unsupported protocol ${line}`);
						this.serverVersion = line;
						this.gotVersion = true;
						data = this.versionBuf;
						this.versionBuf = new Uint8Array(0);
						break;
					}
				}
			}
			this.dec.push(data);
			for (;;) {
				const payload = this.dec.next();
				if (!payload) break;
				this.onPacket(payload);
				if (this.closedErr) return;
			}
		} catch (e) {
			this.shutdown(e as Error);
		}
	}

	send(payload: Uint8Array): void {
		if (this.closedErr) throw this.closedErr;
		const t = payload[0];
		if (this.kexActive && !(t <= 4 || (t >= 20 && t <= 49))) {
			this.queued.push(payload);
			return;
		}
		this.sock.write(this.enc.encode(payload));
	}

	private recv(): Promise<Uint8Array> {
		const m = this.inbox.shift();
		if (m) return Promise.resolve(m);
		if (this.closedErr) return Promise.reject(this.closedErr);
		return new Promise((resolve, reject) => this.inboxWaiters.push({ resolve, reject }));
	}

	private deliver(payload: Uint8Array): void {
		const w = this.inboxWaiters.shift();
		if (w) w.resolve(payload);
		else this.inbox.push(payload);
	}

	shutdown(err?: Error): void {
		if (this.closedErr) return;
		this.closedErr = err ?? new Error('SSH connection closed');
		if (this.keepaliveTimer) window.clearInterval(this.keepaliveTimer);
		try {
			this.sock.close();
		} catch {
			/* ignore */
		}
		for (const w of this.inboxWaiters) w.reject(this.closedErr);
		this.inboxWaiters = [];
		this.kexDone?.reject(this.closedErr);
		for (const g of this.globalWaiters) g(false);
		this.globalWaiters = [];
		for (const ch of this.channels.values()) {
			ch.closed = true;
			ch.openWaiter?.reject(this.closedErr);
			for (const r of ch.requestWaiters) r.resolve(false);
			ch.onClose(this.closedErr);
		}
		this.channels.clear();
		this.onClose(err);
	}

	close(): void {
		if (this.closedErr) return;
		try {
			this.send(new Writer().byte(MSG.DISCONNECT).u32(11).string('bye').string('').bytes());
		} catch {
			/* ignore */
		}
		this.shutdown();
	}

	private startKeepalive(): void {
		const every = this.opts.keepaliveMs ?? 15000;
		if (every <= 0) return;
		this.keepaliveTimer = window.setInterval(() => {
			if (this.missedKeepalives >= 3) {
				this.shutdown(new Error('SSH keepalive timeout'));
				return;
			}
			this.missedKeepalives++;
			void this.globalRequest('keepalive@openssh.com').then(() => (this.missedKeepalives = 0));
		}, every);
	}

	globalRequest(name: string): Promise<boolean> {
		try {
			this.send(new Writer().byte(MSG.GLOBAL_REQUEST).string(name).bool(true).bytes());
		} catch {
			return Promise.resolve(false);
		}
		return new Promise((resolve) => this.globalWaiters.push(resolve));
	}

	// ---------------- dispatch ----------------

	private onPacket(p: Uint8Array): void {
		const t = p[0];
		if (this.firstKex && this.strictKex && this.kexActive && !(t >= 20 && t <= 49))
			throw new Error(`SSH: unexpected message ${t} during strict KEX`);
		switch (t) {
			case MSG.DISCONNECT: {
				const r = new Reader(p.subarray(1));
				const code = r.u32();
				const text = r.text();
				this.shutdown(new Error(`SSH: server disconnected (${code}): ${text}`));
				return;
			}
			case MSG.IGNORE:
			case MSG.DEBUG:
			case MSG.UNIMPLEMENTED:
				return;
			case MSG.KEXINIT:
				this.onKexInit(p);
				return;
			case MSG.KEX_ECDH_REPLY:
				this.onKexReply(p);
				return;
			case MSG.NEWKEYS:
				this.onNewKeys();
				return;
			case MSG.EXT_INFO:
				this.onExtInfo(p);
				if (this.authenticated) return;
				break;
			case MSG.GLOBAL_REQUEST: {
				const r = new Reader(p.subarray(1));
				r.text();
				if (r.bool()) this.send(new Uint8Array([MSG.REQUEST_FAILURE]));
				return;
			}
			case MSG.REQUEST_SUCCESS:
			case MSG.REQUEST_FAILURE:
				this.globalWaiters.shift()?.(t === MSG.REQUEST_SUCCESS);
				return;
		}
		if (t >= MSG.CHANNEL_OPEN && t <= MSG.CHANNEL_FAILURE && this.authenticated) {
			this.onChannelMessage(p);
			return;
		}
		if (t === MSG.USERAUTH_BANNER) {
			const r = new Reader(p.subarray(1));
			this.opts.onBanner?.(r.text());
			return;
		}
		this.deliver(p);
	}

	private onExtInfo(p: Uint8Array): void {
		const r = new Reader(p.subarray(1));
		const n = r.u32();
		for (let i = 0; i < n; i++) {
			const name = r.text();
			const value = r.text();
			if (name === 'server-sig-algs') this.serverSigAlgs = value.split(',');
		}
	}

	// ---------------- key exchange ----------------

	private sendKexInit(): void {
		const cookie = new Uint8Array(16);
		crypto.getRandomValues(cookie);
		const kex = [...this.kexList];
		if (this.firstKex) kex.push('ext-info-c', 'kex-strict-c-v00@openssh.com');
		const w = new Writer()
			.byte(MSG.KEXINIT)
			.raw(cookie)
			.nameList(kex)
			.nameList(this.hostKeyList)
			.nameList(this.cipherList)
			.nameList(this.cipherList)
			.nameList(this.macList)
			.nameList(this.macList)
			.nameList(['none'])
			.nameList(['none'])
			.nameList([])
			.nameList([])
			.bool(false)
			.u32(0);
		this.clientKexInit = w.bytes();
		this.kexActive = true;
		this.kexSentInit = true;
		this.send(this.clientKexInit);
	}

	private onKexInit(p: Uint8Array): void {
		this.serverKexInit = p.slice();
		if (!this.kexSentInit) this.sendKexInit();
		const r = new Reader(p.subarray(17));
		const kex = r.nameList();
		const hostKey = r.nameList();
		const cCS = r.nameList();
		const cSC = r.nameList();
		const mCS = r.nameList();
		const mSC = r.nameList();
		const compCS = r.nameList();
		const compSC = r.nameList();
		if (!compCS.includes('none') || !compSC.includes('none')) throw new Error('SSH: server requires compression');
		if (this.firstKex) this.strictKex = kex.includes('kex-strict-s-v00@openssh.com');
		const algs: KexAlgs = {
			kex: negotiate(this.kexList, kex, 'kex'),
			hostKey: negotiate(this.hostKeyList, hostKey, 'host key'),
			cipherCS: negotiate(this.cipherList, cCS, 'cipher'),
			cipherSC: negotiate(this.cipherList, cSC, 'cipher'),
			macCS: '',
			macSC: '',
			strict: this.strictKex,
		};
		if (!CIPHER_INFO[algs.cipherCS].aead) algs.macCS = negotiate(this.macList, mCS, 'MAC');
		if (!CIPHER_INFO[algs.cipherSC].aead) algs.macSC = negotiate(this.macList, mSC, 'MAC');
		this.kexAlgs = algs;
		if (algs.kex.startsWith('curve25519')) {
			this.kexPriv = x25519.utils.randomSecretKey();
			this.kexPub = x25519.getPublicKey(this.kexPriv);
		} else {
			const c = this.ecdhCurve(algs.kex);
			this.kexPriv = c.utils.randomSecretKey();
			this.kexPub = c.getPublicKey(this.kexPriv, false);
		}
		this.send(new Writer().byte(MSG.KEX_ECDH_INIT).string(this.kexPub).bytes());
	}

	private ecdhCurve(kex: string) {
		if (kex.endsWith('nistp256')) return p256;
		if (kex.endsWith('nistp384')) return p384;
		return p521;
	}

	private kexHash(kex: string): (m: Uint8Array) => Uint8Array {
		if (kex.endsWith('nistp384')) return sha384;
		if (kex.endsWith('nistp521')) return sha512;
		return sha256;
	}

	private onKexReply(p: Uint8Array): void {
		const algs = this.kexAlgs;
		if (!algs || !this.kexPriv || !this.kexPub) throw new Error('SSH: unexpected KEX reply');
		const r = new Reader(p.subarray(1));
		const hostKey = r.string().slice();
		const serverPub = r.string();
		const sig = r.string();
		let secret: Uint8Array;
		if (algs.kex.startsWith('curve25519')) {
			secret = x25519.getSharedSecret(this.kexPriv, serverPub);
			if (secret.every((b) => b === 0)) throw new Error('SSH: invalid curve25519 shared secret');
		} else {
			secret = this.ecdhCurve(algs.kex).getSharedSecret(this.kexPriv, serverPub, true).subarray(1);
		}
		const K = new Writer().mpint(secret).bytes();
		const hash = this.kexHash(algs.kex);
		const H = hash(
			new Writer()
				.string(CLIENT_VERSION)
				.string(this.serverVersion)
				.string(this.clientKexInit!)
				.string(this.serverKexInit!)
				.string(hostKey)
				.string(this.kexPub)
				.string(serverPub)
				.raw(K)
				.bytes(),
		);
		if (!verifyHostSignature(hostKey, sig, H)) throw new Error('SSH: host key signature verification failed');
		const sigAlg = new Reader(sig).text();
		if (sigAlg !== algs.hostKey) throw new Error('SSH: host key algorithm mismatch');

		if (!this.hostKeyBlob) {
			const info: HostKeyInfo = { type: publicKeyType(hostKey), fingerprint: fingerprint(hostKey), blob: hostKey };
			this.hostKey = info;
			if (!this.opts.verifyHostKey(info)) throw new HostKeyMismatchError(info);
			this.hostKeyBlob = hostKey;
		} else if (fingerprint(hostKey) !== fingerprint(this.hostKeyBlob)) {
			throw new Error('SSH: host key changed during re-key');
		}
		if (!this.sessionId) this.sessionId = H;
		const sid = this.sessionId;
		const derive = (letter: string, len: number): Uint8Array => {
			if (len === 0) return new Uint8Array(0);
			let out = hash(concat(K, H, utf8(letter), sid));
			while (out.length < len) out = concat(out, hash(concat(K, H, out)));
			return out.slice(0, len);
		};
		const ciCS = CIPHER_INFO[algs.cipherCS];
		const ciSC = CIPHER_INFO[algs.cipherSC];
		const keysOut: DirectionKeys = {
			cipher: algs.cipherCS,
			mac: algs.macCS,
			iv: derive('A', ciCS.ivLen),
			key: derive('C', ciCS.keyLen),
			macKey: algs.macCS ? derive('E', MAC_INFO[algs.macCS].keyLen) : new Uint8Array(0),
		};
		this.pendingKeysIn = {
			cipher: algs.cipherSC,
			mac: algs.macSC,
			iv: derive('B', ciSC.ivLen),
			key: derive('D', ciSC.keyLen),
			macKey: algs.macSC ? derive('F', MAC_INFO[algs.macSC].keyLen) : new Uint8Array(0),
		};
		this.send(new Uint8Array([MSG.NEWKEYS]));
		this.enc.setKeys(keysOut);
		if (this.strictKex) this.enc.seq = 0;
		this.kexPriv = undefined;
	}

	private onNewKeys(): void {
		if (!this.pendingKeysIn) throw new Error('SSH: unexpected NEWKEYS');
		this.dec.setKeys(this.pendingKeysIn);
		if (this.strictKex) this.dec.seq = 0;
		this.pendingKeysIn = undefined;
		this.kexActive = false;
		this.kexSentInit = false;
		this.firstKex = false;
		const q = this.queued;
		this.queued = [];
		for (const m of q) this.send(m);
		if (this.kexDone) {
			const d = this.kexDone;
			this.kexDone = undefined;
			d.resolve();
		}
	}

	// ---------------- authentication ----------------

	private authRequest(method: string): Writer {
		return new Writer()
			.byte(MSG.USERAUTH_REQUEST)
			.string(this.opts.username)
			.string('ssh-connection')
			.string(method);
	}

	private async authResult(): Promise<{ ok: boolean; methods: string[]; msg?: Uint8Array }> {
		for (;;) {
			const m = await this.recv();
			if (m[0] === MSG.USERAUTH_SUCCESS) return { ok: true, methods: [] };
			if (m[0] === MSG.USERAUTH_FAILURE) {
				const r = new Reader(m.subarray(1));
				return { ok: false, methods: r.nameList() };
			}
			if (m[0] === MSG.USERAUTH_60) return { ok: false, methods: [], msg: m };
			if (m[0] === MSG.EXT_INFO) continue;
			throw new Error(`SSH: unexpected auth message ${m[0]}`);
		}
	}

	private async authenticate(): Promise<void> {
		const { privateKey, password } = this.opts;
		const tried: string[] = [];
		let methods = ['publickey', 'password', 'keyboard-interactive'];

		if (privateKey) {
			for (const alg of privateKey.algorithms(this.serverSigAlgs)) {
				if (!methods.includes('publickey')) break;
				const w = this.authRequest('publickey').bool(true).string(alg).string(privateKey.publicBlob);
				const signed = new Writer().string(this.sessionId!).raw(w.bytes()).bytes();
				w.string(privateKey.sign(alg, signed));
				this.send(w.bytes());
				const res = await this.authResult();
				if (res.ok) return this.authOk();
				methods = res.methods;
			}
			tried.push('publickey');
		}

		if (password !== undefined && password !== '') {
			if (methods.includes('password')) {
				this.send(this.authRequest('password').bool(false).string(password).bytes());
				const res = await this.authResult();
				if (res.ok) return this.authOk();
				if (res.msg) throw new SshAuthError('SSH: server requires a password change');
				methods = res.methods;
				tried.push('password');
			}
			if (methods.includes('keyboard-interactive')) {
				this.send(this.authRequest('keyboard-interactive').string('').string('').bytes());
				for (;;) {
					const res = await this.authResult();
					if (res.ok) return this.authOk();
					if (!res.msg) {
						methods = res.methods;
						break;
					}
					const r = new Reader(res.msg.subarray(1));
					r.text(); // name
					r.text(); // instruction
					r.text(); // lang
					const n = r.u32();
					const w = new Writer().byte(MSG.USERAUTH_INFO_RESPONSE).u32(n);
					for (let i = 0; i < n; i++) {
						r.text();
						r.bool();
						w.string(password);
					}
					this.send(w.bytes());
				}
				tried.push('keyboard-interactive');
			}
		}
		throw new SshAuthError(
			`SSH authentication failed (tried: ${tried.join(', ') || 'nothing'}; server allows: ${methods.join(', ')})`,
		);
	}

	private authOk(): void {
		this.authenticated = true;
		// Anything that arrived after USERAUTH_SUCCESS belongs to the connection layer.
		const pending = this.inbox;
		this.inbox = [];
		for (const p of pending) this.onPacket(p);
	}

	// ---------------- channels ----------------

	async openSession(): Promise<Channel> {
		const id = this.nextChannelId++;
		const window = 2 * 1024 * 1024;
		const ch = new Channel(this, id, window);
		this.channels.set(id, ch);
		const opened = new Promise<void>((resolve, reject) => (ch.openWaiter = { resolve, reject }));
		this.send(new Writer().byte(MSG.CHANNEL_OPEN).string('session').u32(id).u32(window).u32(32768).bytes());
		await opened;
		return ch;
	}

	private onChannelMessage(p: Uint8Array): void {
		const t = p[0];
		const r = new Reader(p.subarray(1));
		if (t === MSG.CHANNEL_OPEN) {
			const type = r.text();
			const sender = r.u32();
			this.send(
				new Writer().byte(MSG.CHANNEL_OPEN_FAILURE).u32(sender).u32(1).string(`${type} not allowed`).string('').bytes(),
			);
			return;
		}
		const ch = this.channels.get(r.u32());
		if (!ch) return;
		switch (t) {
			case MSG.CHANNEL_OPEN_CONFIRMATION:
				ch.remoteId = r.u32();
				ch.remoteWindow = r.u32();
				ch.remoteMaxPacket = Math.min(r.u32(), 32768);
				ch.openWaiter?.resolve();
				ch.openWaiter = undefined;
				break;
			case MSG.CHANNEL_OPEN_FAILURE: {
				const code = r.u32();
				const desc = r.text();
				this.channels.delete(ch.localId);
				ch.openWaiter?.reject(new Error(`SSH: channel open failed (${code}) ${desc}`));
				break;
			}
			case MSG.CHANNEL_WINDOW_ADJUST:
				ch.remoteWindow += r.u32();
				ch.flush();
				break;
			case MSG.CHANNEL_DATA: {
				const d = r.string();
				ch.consumed(d.length);
				ch.onData(d);
				break;
			}
			case MSG.CHANNEL_EXTENDED_DATA: {
				r.u32();
				ch.consumed(r.string().length);
				break;
			}
			case MSG.CHANNEL_EOF:
				break;
			case MSG.CHANNEL_CLOSE:
				if (!ch.closed) ch.close();
				ch.closed = true;
				this.channels.delete(ch.localId);
				ch.onClose();
				break;
			case MSG.CHANNEL_REQUEST: {
				r.text();
				if (r.bool()) this.send(new Writer().byte(MSG.CHANNEL_FAILURE).u32(ch.remoteId).bytes());
				break;
			}
			case MSG.CHANNEL_SUCCESS:
			case MSG.CHANNEL_FAILURE:
				ch.requestWaiters.shift()?.resolve(t === MSG.CHANNEL_SUCCESS);
				break;
		}
	}
}
