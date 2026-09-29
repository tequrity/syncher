// SSH wire-format helpers (RFC 4251 §5).

const te = new TextEncoder();
const td = new TextDecoder();

export function utf8(s: string): Uint8Array {
	return te.encode(s);
}

export function fromUtf8(b: Uint8Array): string {
	return td.decode(b);
}

export function concat(...parts: Uint8Array[]): Uint8Array {
	let len = 0;
	for (const p of parts) len += p.length;
	const out = new Uint8Array(len);
	let off = 0;
	for (const p of parts) {
		out.set(p, off);
		off += p.length;
	}
	return out;
}

export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
	return diff === 0;
}

export function bytesToBigInt(b: Uint8Array): bigint {
	let hex = '';
	for (const x of b) hex += x.toString(16).padStart(2, '0');
	return hex ? BigInt('0x' + hex) : 0n;
}

export function bigIntToBytes(n: bigint, len?: number): Uint8Array {
	let hex = n.toString(16);
	if (hex.length % 2) hex = '0' + hex;
	const raw = new Uint8Array(hex.length / 2);
	for (let i = 0; i < raw.length; i++) raw[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
	if (len === undefined || raw.length === len) return raw;
	if (raw.length > len) throw new Error('bigint too large');
	const out = new Uint8Array(len);
	out.set(raw, len - raw.length);
	return out;
}

export function toBase64(b: Uint8Array): string {
	let s = '';
	for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
	return btoa(s);
}

export function fromBase64(s: string): Uint8Array {
	const bin = atob(s.replace(/\s+/g, ''));
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out;
}

export function toHex(b: Uint8Array): string {
	let s = '';
	for (const x of b) s += x.toString(16).padStart(2, '0');
	return s;
}

export class Writer {
	private buf: Uint8Array;
	private len = 0;

	constructor(initial = 256) {
		this.buf = new Uint8Array(initial);
	}

	private ensure(n: number): void {
		if (this.len + n <= this.buf.length) return;
		let size = this.buf.length * 2;
		while (size < this.len + n) size *= 2;
		const nb = new Uint8Array(size);
		nb.set(this.buf.subarray(0, this.len));
		this.buf = nb;
	}

	byte(v: number): this {
		this.ensure(1);
		this.buf[this.len++] = v & 0xff;
		return this;
	}

	bool(v: boolean): this {
		return this.byte(v ? 1 : 0);
	}

	u32(v: number): this {
		this.ensure(4);
		this.buf[this.len++] = (v >>> 24) & 0xff;
		this.buf[this.len++] = (v >>> 16) & 0xff;
		this.buf[this.len++] = (v >>> 8) & 0xff;
		this.buf[this.len++] = v & 0xff;
		return this;
	}

	u64(v: number): this {
		const hi = Math.floor(v / 0x100000000);
		this.u32(hi);
		return this.u32(v >>> 0);
	}

	raw(b: Uint8Array): this {
		this.ensure(b.length);
		this.buf.set(b, this.len);
		this.len += b.length;
		return this;
	}

	string(v: Uint8Array | string): this {
		const b = typeof v === 'string' ? utf8(v) : v;
		this.u32(b.length);
		return this.raw(b);
	}

	mpint(v: Uint8Array | bigint): this {
		let b = typeof v === 'bigint' ? bigIntToBytes(v) : v;
		let i = 0;
		while (i < b.length && b[i] === 0) i++;
		b = b.subarray(i);
		if (b.length && b[0] & 0x80) b = concat(new Uint8Array([0]), b);
		return this.string(b);
	}

	nameList(names: string[]): this {
		return this.string(names.join(','));
	}

	get length(): number {
		return this.len;
	}

	bytes(): Uint8Array {
		return this.buf.slice(0, this.len);
	}
}

export class Reader {
	pos = 0;

	constructor(readonly buf: Uint8Array) {}

	private need(n: number): void {
		if (this.pos + n > this.buf.length) throw new Error('SSH: truncated message');
	}

	byte(): number {
		this.need(1);
		return this.buf[this.pos++];
	}

	bool(): boolean {
		return this.byte() !== 0;
	}

	u32(): number {
		this.need(4);
		const b = this.buf;
		const p = this.pos;
		this.pos += 4;
		return ((b[p] << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3]) >>> 0;
	}

	u64(): number {
		const hi = this.u32();
		const lo = this.u32();
		return hi * 0x100000000 + lo;
	}

	raw(n: number): Uint8Array {
		this.need(n);
		const out = this.buf.subarray(this.pos, this.pos + n);
		this.pos += n;
		return out;
	}

	string(): Uint8Array {
		return this.raw(this.u32());
	}

	text(): string {
		return fromUtf8(this.string());
	}

	mpint(): bigint {
		return bytesToBigInt(this.string());
	}

	nameList(): string[] {
		const s = this.text();
		return s ? s.split(',') : [];
	}

	rest(): Uint8Array {
		const out = this.buf.subarray(this.pos);
		this.pos = this.buf.length;
		return out;
	}

	get remaining(): number {
		return this.buf.length - this.pos;
	}
}
