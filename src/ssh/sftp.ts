// SFTP version 3 client (draft-ietf-secsh-filexfer-02) over an SSH session channel,
// plus the posix-rename@openssh.com and fsync@openssh.com extensions.

import { Reader, Writer, concat, fromUtf8 } from './buffer';
import { Channel, SshClient } from './client';

const FXP = {
	INIT: 1,
	VERSION: 2,
	OPEN: 3,
	CLOSE: 4,
	READ: 5,
	WRITE: 6,
	LSTAT: 7,
	FSTAT: 8,
	SETSTAT: 9,
	FSETSTAT: 10,
	OPENDIR: 11,
	READDIR: 12,
	REMOVE: 13,
	MKDIR: 14,
	RMDIR: 15,
	REALPATH: 16,
	STAT: 17,
	RENAME: 18,
	STATUS: 101,
	HANDLE: 102,
	DATA: 103,
	NAME: 104,
	ATTRS: 105,
	EXTENDED: 200,
} as const;

export const OPEN = { READ: 1, WRITE: 2, APPEND: 4, CREAT: 8, TRUNC: 16, EXCL: 32 } as const;

const ATTR = { SIZE: 1, UIDGID: 2, PERMISSIONS: 4, ACMODTIME: 8, EXTENDED: 0x80000000 } as const;

export const STATUS = { OK: 0, EOF: 1, NO_SUCH_FILE: 2, PERMISSION_DENIED: 3, FAILURE: 4 } as const;

export interface Attrs {
	size?: number;
	uid?: number;
	gid?: number;
	permissions?: number;
	atime?: number;
	mtime?: number;
}

export interface DirEntry {
	name: string;
	attrs: Attrs;
}

export function isDir(a: Attrs): boolean {
	return a.permissions !== undefined && (a.permissions & 0o170000) === 0o040000;
}

export function isFile(a: Attrs): boolean {
	return a.permissions !== undefined && (a.permissions & 0o170000) === 0o100000;
}

export class SftpError extends Error {
	constructor(
		readonly code: number,
		msg: string,
		readonly path?: string,
	) {
		super(`SFTP ${code}: ${msg}${path ? ` (${path})` : ''}`);
		this.name = 'SftpError';
	}
}

export function isNoSuchFile(e: unknown): boolean {
	return e instanceof SftpError && e.code === STATUS.NO_SUCH_FILE;
}

function readAttrs(r: Reader): Attrs {
	const flags = r.u32();
	const a: Attrs = {};
	if (flags & ATTR.SIZE) a.size = r.u64();
	if (flags & ATTR.UIDGID) {
		a.uid = r.u32();
		a.gid = r.u32();
	}
	if (flags & ATTR.PERMISSIONS) a.permissions = r.u32();
	if (flags & ATTR.ACMODTIME) {
		a.atime = r.u32();
		a.mtime = r.u32();
	}
	if (flags & ATTR.EXTENDED) {
		const n = r.u32();
		for (let i = 0; i < n; i++) {
			r.string();
			r.string();
		}
	}
	return a;
}

function writeAttrs(w: Writer, a: Attrs): void {
	let flags = 0;
	if (a.size !== undefined) flags |= ATTR.SIZE;
	if (a.permissions !== undefined) flags |= ATTR.PERMISSIONS;
	if (a.mtime !== undefined) flags |= ATTR.ACMODTIME;
	w.u32(flags);
	if (a.size !== undefined) w.u64(a.size);
	if (a.permissions !== undefined) w.u32(a.permissions);
	if (a.mtime !== undefined) {
		w.u32(Math.floor(a.atime ?? a.mtime));
		w.u32(Math.floor(a.mtime));
	}
}

type Pending = { resolve: (r: { type: number; r: Reader }) => void; reject: (e: Error) => void };

export class Sftp {
	private reqId = 1;
	private pending = new Map<number, Pending>();
	private buf: Uint8Array = new Uint8Array(0);
	private extensions = new Map<string, string>();
	private closedErr?: Error;
	private readonly chunk = 32 * 1024;
	private readonly inflight = 32;

	private constructor(private ch: Channel) {}

	static async open(client: SshClient): Promise<Sftp> {
		const ch = await client.openSession();
		const ok = await ch.request('subsystem', true, new Writer().string('sftp').bytes());
		if (!ok) {
			ch.close();
			throw new Error('SSH: server refused the sftp subsystem');
		}
		const s = new Sftp(ch);
		ch.onData = (d) => s.onData(d);
		ch.onClose = (err) => s.fail(new Error(err ? `SFTP channel closed: ${err.message}` : 'SFTP channel closed by the server'));
		const version = new Promise<Reader>((resolve, reject) => {
			s.pending.set(0, { resolve: ({ r }) => resolve(r), reject });
		});
		ch.write(s.frame(new Writer().byte(FXP.INIT).u32(3).bytes()));
		const r = await version;
		r.u32(); // version
		while (r.remaining > 0) s.extensions.set(r.text(), r.text());
		return s;
	}

	get closed(): boolean {
		return !!this.closedErr;
	}

	hasExtension(name: string): boolean {
		return this.extensions.has(name);
	}

	close(): void {
		this.ch.close();
		this.fail(new Error('SFTP closed'));
	}

	private fail(e: Error): void {
		if (this.closedErr) return;
		this.closedErr = e;
		for (const p of this.pending.values()) p.reject(e);
		this.pending.clear();
	}

	private frame(body: Uint8Array): Uint8Array {
		return new Writer(body.length + 4).string(body).bytes();
	}

	private onData(d: Uint8Array): void {
		this.buf = this.buf.length ? concat(this.buf, d) : d;
		while (this.buf.length >= 4) {
			const len = ((this.buf[0] << 24) | (this.buf[1] << 16) | (this.buf[2] << 8) | this.buf[3]) >>> 0;
			if (this.buf.length < 4 + len) break;
			const msg = this.buf.subarray(4, 4 + len);
			this.buf = this.buf.subarray(4 + len);
			const r = new Reader(msg);
			const type = r.byte();
			const id = type === FXP.VERSION ? 0 : r.u32();
			const p = this.pending.get(id);
			if (!p) continue;
			this.pending.delete(id);
			p.resolve({ type, r });
		}
	}

	private request(type: number, build: (w: Writer) => void): Promise<{ type: number; r: Reader }> {
		if (this.closedErr) return Promise.reject(this.closedErr);
		const id = this.reqId;
		this.reqId = (this.reqId % 0x7fffffff) + 1;
		const w = new Writer().byte(type).u32(id);
		build(w);
		return new Promise((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
			try {
				this.ch.write(this.frame(w.bytes()));
			} catch (e) {
				this.pending.delete(id);
				reject(e instanceof Error ? e : new Error(String(e)));
			}
		});
	}

	private statusError(r: Reader, path?: string): SftpError {
		const code = r.u32();
		let msg = '';
		try {
			msg = r.text();
		} catch {
			/* optional */
		}
		return new SftpError(code, msg || 'failure', path);
	}

	private async expectStatus(p: Promise<{ type: number; r: Reader }>, path?: string): Promise<void> {
		const { type, r } = await p;
		if (type !== FXP.STATUS) throw new Error(`SFTP: unexpected reply ${type}`);
		const e = this.statusError(r, path);
		if (e.code !== STATUS.OK) throw e;
	}

	private async expectHandle(p: Promise<{ type: number; r: Reader }>, path?: string): Promise<Uint8Array> {
		const { type, r } = await p;
		if (type === FXP.HANDLE) return r.string().slice();
		if (type === FXP.STATUS) throw this.statusError(r, path);
		throw new Error(`SFTP: unexpected reply ${type}`);
	}

	private async expectAttrs(p: Promise<{ type: number; r: Reader }>, path?: string): Promise<Attrs> {
		const { type, r } = await p;
		if (type === FXP.ATTRS) return readAttrs(r);
		if (type === FXP.STATUS) throw this.statusError(r, path);
		throw new Error(`SFTP: unexpected reply ${type}`);
	}

	// ---------------- primitive operations ----------------

	openFile(path: string, flags: number, attrs: Attrs = {}): Promise<Uint8Array> {
		return this.expectHandle(
			this.request(FXP.OPEN, (w) => {
				w.string(path).u32(flags);
				writeAttrs(w, attrs);
			}),
			path,
		);
	}

	closeHandle(h: Uint8Array): Promise<void> {
		return this.expectStatus(this.request(FXP.CLOSE, (w) => w.string(h)));
	}

	async readChunk(h: Uint8Array, offset: number, len: number): Promise<Uint8Array | null> {
		const { type, r } = await this.request(FXP.READ, (w) => w.string(h).u64(offset).u32(len));
		if (type === FXP.DATA) return r.string();
		if (type === FXP.STATUS) {
			const e = this.statusError(r);
			if (e.code === STATUS.EOF) return null;
			throw e;
		}
		throw new Error(`SFTP: unexpected reply ${type}`);
	}

	writeChunk(h: Uint8Array, offset: number, data: Uint8Array): Promise<void> {
		return this.expectStatus(this.request(FXP.WRITE, (w) => w.string(h).u64(offset).string(data)));
	}

	stat(path: string): Promise<Attrs> {
		return this.expectAttrs(this.request(FXP.STAT, (w) => w.string(path)), path);
	}

	lstat(path: string): Promise<Attrs> {
		return this.expectAttrs(this.request(FXP.LSTAT, (w) => w.string(path)), path);
	}

	fstat(h: Uint8Array): Promise<Attrs> {
		return this.expectAttrs(this.request(FXP.FSTAT, (w) => w.string(h)));
	}

	setstat(path: string, attrs: Attrs): Promise<void> {
		return this.expectStatus(
			this.request(FXP.SETSTAT, (w) => {
				w.string(path);
				writeAttrs(w, attrs);
			}),
			path,
		);
	}

	fsetstat(h: Uint8Array, attrs: Attrs): Promise<void> {
		return this.expectStatus(
			this.request(FXP.FSETSTAT, (w) => {
				w.string(h);
				writeAttrs(w, attrs);
			}),
		);
	}

	async readdir(path: string): Promise<DirEntry[]> {
		const h = await this.expectHandle(this.request(FXP.OPENDIR, (w) => w.string(path)), path);
		const out: DirEntry[] = [];
		try {
			for (;;) {
				const { type, r } = await this.request(FXP.READDIR, (w) => w.string(h));
				if (type === FXP.STATUS) {
					const e = this.statusError(r, path);
					if (e.code === STATUS.EOF) break;
					throw e;
				}
				if (type !== FXP.NAME) throw new Error(`SFTP: unexpected reply ${type}`);
				const n = r.u32();
				for (let i = 0; i < n; i++) {
					const name = r.text();
					r.string(); // longname
					const attrs = readAttrs(r);
					if (name !== '.' && name !== '..') out.push({ name, attrs });
				}
			}
		} finally {
			await this.closeHandle(h).catch(() => undefined);
		}
		return out;
	}

	remove(path: string): Promise<void> {
		return this.expectStatus(this.request(FXP.REMOVE, (w) => w.string(path)), path);
	}

	mkdir(path: string, attrs: Attrs = {}): Promise<void> {
		return this.expectStatus(
			this.request(FXP.MKDIR, (w) => {
				w.string(path);
				writeAttrs(w, attrs);
			}),
			path,
		);
	}

	rmdir(path: string): Promise<void> {
		return this.expectStatus(this.request(FXP.RMDIR, (w) => w.string(path)), path);
	}

	async realpath(path: string): Promise<string> {
		const { type, r } = await this.request(FXP.REALPATH, (w) => w.string(path));
		if (type === FXP.STATUS) throw this.statusError(r, path);
		if (type !== FXP.NAME) throw new Error(`SFTP: unexpected reply ${type}`);
		r.u32();
		return fromUtf8(r.string());
	}

	/** Rename; overwrites the target atomically when the server supports posix-rename. */
	async rename(from: string, to: string, overwrite = true): Promise<void> {
		if (overwrite && this.extensions.has('posix-rename@openssh.com')) {
			return this.expectStatus(
				this.request(FXP.EXTENDED, (w) => w.string('posix-rename@openssh.com').string(from).string(to)),
				from,
			);
		}
		try {
			await this.expectStatus(this.request(FXP.RENAME, (w) => w.string(from).string(to)), from);
		} catch (e) {
			if (!overwrite) throw e;
			await this.remove(to).catch(() => undefined);
			await this.expectStatus(this.request(FXP.RENAME, (w) => w.string(from).string(to)), from);
		}
	}

	async fsync(h: Uint8Array): Promise<void> {
		if (!this.extensions.has('fsync@openssh.com')) return;
		await this.expectStatus(this.request(FXP.EXTENDED, (w) => w.string('fsync@openssh.com').string(h)));
	}

	// ---------------- high-level helpers ----------------

	async exists(path: string): Promise<Attrs | null> {
		try {
			return await this.stat(path);
		} catch (e) {
			if (isNoSuchFile(e)) return null;
			throw e;
		}
	}

	async readFile(path: string): Promise<{ data: Uint8Array; attrs: Attrs }> {
		const h = await this.openFile(path, OPEN.READ);
		try {
			const attrs = await this.fstat(h);
			const data = await this.readFromHandle(h, 0, attrs.size);
			return { data, attrs };
		} finally {
			await this.closeHandle(h).catch(() => undefined);
		}
	}

	/** Reads [offset, offset+length) (or to EOF) with pipelined requests. */
	async readRange(path: string, offset: number, length?: number): Promise<Uint8Array> {
		const h = await this.openFile(path, OPEN.READ);
		try {
			return await this.readFromHandle(h, offset, length === undefined ? undefined : offset + length);
		} finally {
			await this.closeHandle(h).catch(() => undefined);
		}
	}

	private async readFromHandle(h: Uint8Array, start: number, end?: number): Promise<Uint8Array> {
		const parts: Uint8Array[] = [];
		let next = start;
		let eof = false;
		if (end !== undefined && end <= start) return new Uint8Array(0);
		const readAt = async (off: number, len: number): Promise<void> => {
			let got = 0;
			while (got < len) {
				const d = await this.readChunk(h, off + got, len - got);
				if (!d || d.length === 0) {
					eof = true;
					break;
				}
				parts[(off - start) / this.chunk] = got ? concat(parts[(off - start) / this.chunk], d) : d.slice();
				got += d.length;
			}
		};
		const worker = async (): Promise<void> => {
			while (!eof && (end === undefined || next < end)) {
				const off = next;
				const len = end === undefined ? this.chunk : Math.min(this.chunk, end - off);
				next += len;
				await readAt(off, len);
			}
		};
		// Unknown size: read sequentially to avoid over-reading far past EOF.
		const workers = end === undefined ? 1 : Math.min(this.inflight, Math.ceil((end - start) / this.chunk));
		await Promise.all(Array.from({ length: workers }, worker));
		return concat(...parts.filter((p) => p));
	}

	async writeFile(path: string, data: Uint8Array, attrs: Attrs = {}): Promise<void> {
		const h = await this.openFile(path, OPEN.WRITE | OPEN.CREAT | OPEN.TRUNC, {
			permissions: attrs.permissions,
		});
		try {
			await this.writeToHandle(h, 0, data);
			if (attrs.mtime !== undefined) await this.fsetstat(h, { mtime: attrs.mtime, atime: attrs.atime });
			await this.fsync(h).catch(() => undefined);
		} finally {
			await this.closeHandle(h);
		}
	}

	/** Appends data at the current end of file (single-writer files only). */
	async appendFile(path: string, data: Uint8Array): Promise<number> {
		const h = await this.openFile(path, OPEN.WRITE | OPEN.CREAT);
		try {
			const size = (await this.fstat(h)).size ?? 0;
			await this.writeToHandle(h, size, data);
			return size + data.length;
		} finally {
			await this.closeHandle(h);
		}
	}

	private async writeToHandle(h: Uint8Array, start: number, data: Uint8Array): Promise<void> {
		let next = 0;
		const worker = async (): Promise<void> => {
			while (next < data.length) {
				const off = next;
				next += this.chunk;
				await this.writeChunk(h, start + off, data.subarray(off, Math.min(off + this.chunk, data.length)));
			}
		};
		const workers = Math.max(1, Math.min(this.inflight, Math.ceil(data.length / this.chunk)));
		await Promise.all(Array.from({ length: workers }, worker));
	}

	async mkdirp(path: string): Promise<void> {
		const a = await this.exists(path);
		if (a) {
			if (!isDir(a)) throw new SftpError(STATUS.FAILURE, 'not a directory', path);
			return;
		}
		const parent = path.replace(/\/[^/]+\/?$/, '');
		if (parent && parent !== path) await this.mkdirp(parent);
		try {
			await this.mkdir(path);
		} catch (e) {
			if (!(await this.exists(path))) throw e;
		}
	}

	/** Recursively removes a file or directory tree. */
	async rmrf(path: string): Promise<void> {
		let a: Attrs;
		try {
			a = await this.lstat(path);
		} catch (e) {
			if (isNoSuchFile(e)) return;
			throw e;
		}
		if (!isDir(a)) {
			await this.remove(path);
			return;
		}
		for (const e of await this.readdir(path)) await this.rmrf(`${path}/${e.name}`);
		await this.rmdir(path);
	}
}
