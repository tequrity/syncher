// The remote side of the vault: a directory on the SSH server accessed via SFTP.
//
// Layout on the server:
//   <remoteDir>/...                       the vault files (mirror)
//   <remoteDir>/.syncher/vault.json     remote vault id
//   <remoteDir>/.syncher/devices/<id>.json   heartbeat / presence of each device
//   <remoteDir>/.syncher/journal/<id>.<epoch>.jsonl   append-only change log, one writer per file
//   <remoteDir>/.syncher/tmp/           staging area for atomic uploads

import { Attrs, Sftp, SftpError, isDir, isNoSuchFile } from '../ssh/sftp';
import { fromUtf8, utf8 } from '../ssh/buffer';
import { LEGACY_META_DIR, META_DIR, PathFilter, parentOf } from './paths';
import { DeviceInfo, JournalEvent, RemoteStat } from './types';

/** Concurrent directory listings during a scan. */
const SCAN_PARALLEL = 8;

function toStat(a: Attrs): RemoteStat {
	return { type: isDir(a) ? 'folder' : 'file', mtime: a.mtime ?? 0, size: a.size ?? 0 };
}

function randomId(n = 12): string {
	const b = new Uint8Array(n);
	crypto.getRandomValues(b);
	return Array.from(b, (x) => x.toString(36).padStart(2, '0')).join('').slice(0, n * 2);
}

export interface JournalFileInfo {
	name: string;
	deviceId: string;
	size: number;
}

export class RemoteStore {
	readonly meta: string;
	private journalName = '';
	private journalSize = 0;
	private heartbeatAt = 0; // Date.now() when last written
	private heartbeatServerTime = 0; // server mtime of our heartbeat

	constructor(
		readonly sftp: Sftp,
		readonly root: string,
		readonly deviceId: string,
	) {
		this.meta = `${root}/${META_DIR}`;
	}

	/** Resolves `~`, relative paths and creates the vault root + metadata dirs. */
	static async open(sftp: Sftp, remoteDir: string, deviceId: string): Promise<RemoteStore> {
		let dir = remoteDir.trim().replace(/\/+$/, '') || '.';
		const home = await sftp.realpath('.');
		if (dir === '~' || dir === '.') dir = home;
		else if (dir.startsWith('~/')) dir = `${home}/${dir.slice(2)}`;
		else if (!dir.startsWith('/')) dir = `${home}/${dir}`;
		await sftp.mkdirp(dir);
		const store = new RemoteStore(sftp, dir, deviceId);
		// keep the vault id, journals and device list of a folder synced under the plugin's former name
		if (!(await sftp.exists(store.meta))) {
			const legacy = `${dir}/${LEGACY_META_DIR}`;
			if (await sftp.exists(legacy)) await sftp.rename(legacy, store.meta, false).catch(() => undefined);
		}
		for (const d of ['devices', 'journal', 'tmp']) await sftp.mkdirp(`${store.meta}/${d}`);
		return store;
	}

	abs(p: string): string {
		return p ? `${this.root}/${p}` : this.root;
	}

	async vaultId(): Promise<string> {
		const f = `${this.meta}/vault.json`;
		try {
			const { data } = await this.sftp.readFile(f);
			const id = (JSON.parse(fromUtf8(data)) as { id?: unknown }).id;
			if (typeof id === 'string' && id) return id;
		} catch (e) {
			if (!isNoSuchFile(e) && !(e instanceof SyntaxError)) throw e;
		}
		const id = randomId();
		await this.sftp.writeFile(f, utf8(JSON.stringify({ id, created: Date.now() })));
		return id;
	}

	// ---------------- vault content ----------------

	/**
	 * Lists everything under `under`. Sub-folders that cannot be read (e.g. permission
	 * denied) are reported in `unreadable` instead of failing the whole scan; their
	 * content is unknown, so callers must not treat it as deleted.
	 */
	async scan(filter: PathFilter, under = '', unreadable: Set<string> = new Set()): Promise<Map<string, RemoteStat>> {
		const out = new Map<string, RemoteStat>();
		// Folders are listed in parallel (bounded): over the phone relay every readdir is a slow round trip.
		let active = 0;
		const waiting: (() => void)[] = [];
		const readdir = async (dir: string) => {
			if (active >= SCAN_PARALLEL) await new Promise<void>((r) => waiting.push(r));
			active++;
			try {
				return await this.sftp.readdir(dir);
			} finally {
				active--;
				waiting.shift()?.();
			}
		};
		const walk = async (rel: string): Promise<void> => {
			let entries;
			try {
				entries = await readdir(this.abs(rel));
			} catch (e) {
				if (isNoSuchFile(e)) return;
				if (rel === under || !(e instanceof SftpError) || this.sftp.closed) throw e;
				unreadable.add(rel);
				return;
			}
			const subdirs: string[] = [];
			for (const e of entries) {
				const p = rel ? `${rel}/${e.name}` : e.name;
				if (filter.excluded(p)) continue;
				const st = toStat(e.attrs);
				if (e.attrs.permissions !== undefined && st.type === 'file' && (e.attrs.permissions & 0o170000) !== 0o100000)
					continue; // symlinks, sockets...
				out.set(p, st);
				if (st.type === 'folder') subdirs.push(p);
			}
			await Promise.all(subdirs.map(walk));
		};
		if (under) {
			const st = await this.stat(under);
			if (!st) return out;
			out.set(under, st);
			if (st.type === 'folder') await walk(under);
		} else await walk('');
		return out;
	}

	async stat(p: string): Promise<RemoteStat | null> {
		try {
			return toStat(await this.sftp.stat(this.abs(p)));
		} catch (e) {
			if (isNoSuchFile(e)) return null;
			throw e;
		}
	}

	async read(p: string): Promise<{ data: Uint8Array; stat: RemoteStat }> {
		const { data, attrs } = await this.sftp.readFile(this.abs(p));
		return { data, stat: toStat(attrs) };
	}

	/** Atomic upload: stage in .syncher/tmp, then rename over the target. */
	async write(p: string, data: Uint8Array, mtimeSec: number): Promise<RemoteStat> {
		const tmp = `${this.meta}/tmp/${this.deviceId}-${randomId(6)}`;
		const parent = parentOf(p);
		if (parent) await this.sftp.mkdirp(this.abs(parent));
		await this.sftp.writeFile(tmp, data, { mtime: mtimeSec });
		try {
			await this.sftp.rename(tmp, this.abs(p), true);
		} catch (e) {
			await this.sftp.remove(tmp).catch(() => undefined);
			throw e;
		}
		return toStat(await this.sftp.stat(this.abs(p)));
	}

	async mkdirp(p: string): Promise<void> {
		await this.sftp.mkdirp(this.abs(p));
	}

	async remove(p: string): Promise<void> {
		try {
			await this.sftp.remove(this.abs(p));
		} catch (e) {
			if (!isNoSuchFile(e)) throw e;
		}
	}

	async rmdirIfEmpty(p: string): Promise<boolean> {
		try {
			const entries = await this.sftp.readdir(this.abs(p));
			if (entries.length) return false;
			await this.sftp.rmdir(this.abs(p));
			return true;
		} catch (e) {
			if (isNoSuchFile(e)) return true;
			throw e;
		}
	}

	/** Non-overwriting rename. */
	async rename(from: string, to: string): Promise<void> {
		const parent = parentOf(to);
		if (parent) await this.sftp.mkdirp(this.abs(parent));
		await this.sftp.rename(this.abs(from), this.abs(to), false);
	}

	/** Proves the remote folder is writable (used by "Test connection"). */
	async checkWritable(): Promise<void> {
		const probe = `${this.meta}/tmp/${this.deviceId}-probe-${randomId(4)}`;
		await this.sftp.writeFile(probe, utf8('ok'));
		await this.sftp.remove(probe);
	}

	async cleanupTmp(maxAgeSec = 3600): Promise<void> {
		const now = this.serverNow();
		for (const e of await this.sftp.readdir(`${this.meta}/tmp`).catch(() => [])) {
			if (now - (e.attrs.mtime ?? now) > maxAgeSec) await this.sftp.remove(`${this.meta}/tmp/${e.name}`).catch(() => undefined);
		}
	}

	// ---------------- journal ----------------

	/** Starts a fresh journal file for this session and drops our older ones. */
	async startJournal(): Promise<void> {
		const dir = `${this.meta}/journal`;
		for (const e of await this.sftp.readdir(dir)) {
			if (e.name.startsWith(this.deviceId + '.')) await this.sftp.remove(`${dir}/${e.name}`).catch(() => undefined);
		}
		await this.rotateJournal();
	}

	private async rotateJournal(): Promise<void> {
		const dir = `${this.meta}/journal`;
		const previous = this.journalName;
		this.journalName = `${this.deviceId}.${Date.now().toString(36)}.jsonl`;
		this.journalSize = 0;
		await this.sftp.writeFile(`${dir}/${this.journalName}`, new Uint8Array(0));
		// keep exactly one previous file so slow readers can finish it; remove anything older
		for (const e of await this.sftp.readdir(dir)) {
			if (e.name.startsWith(this.deviceId + '.') && e.name !== this.journalName && e.name !== previous)
				await this.sftp.remove(`${dir}/${e.name}`).catch(() => undefined);
		}
	}

	private journalChain: Promise<unknown> = Promise.resolve();

	/** Appends one event. Serialised: concurrent appends would both write at the same end offset. */
	appendJournal(ev: JournalEvent): Promise<void> {
		const run = this.journalChain.then(() => this.appendJournalNow(ev));
		this.journalChain = run.catch(() => undefined);
		return run;
	}

	private async appendJournalNow(ev: JournalEvent): Promise<void> {
		if (!this.journalName) await this.startJournal();
		if (this.journalSize > 512 * 1024) await this.rotateJournal();
		const line = utf8(JSON.stringify(ev) + '\n');
		this.journalSize = await this.sftp.appendFile(`${this.meta}/journal/${this.journalName}`, line);
	}

	async listJournals(): Promise<JournalFileInfo[]> {
		const out: JournalFileInfo[] = [];
		for (const e of await this.sftp.readdir(`${this.meta}/journal`)) {
			const m = /^(.+)\.[0-9a-z]+\.jsonl$/.exec(e.name);
			if (!m) continue;
			out.push({ name: e.name, deviceId: m[1], size: e.attrs.size ?? 0 });
		}
		return out;
	}

	/** Reads complete lines from `offset`; returns events and the offset after the last full line. */
	async readJournal(name: string, offset: number): Promise<{ events: JournalEvent[]; offset: number }> {
		const data = await this.sftp.readRange(`${this.meta}/journal/${name}`, offset);
		const lastNl = data.lastIndexOf(10);
		if (lastNl < 0) return { events: [], offset };
		const events: JournalEvent[] = [];
		for (const line of fromUtf8(data.subarray(0, lastNl)).split('\n')) {
			if (!line.trim()) continue;
			try {
				events.push(JSON.parse(line) as JournalEvent);
			} catch {
				/* torn/corrupt line: skip */
			}
		}
		return { events, offset: offset + lastNl + 1 };
	}

	// ---------------- presence ----------------

	async heartbeat(name: string, permanentSave: boolean, version?: string): Promise<void> {
		const f = `${this.meta}/devices/${this.deviceId}.json`;
		await this.sftp.writeFile(f, utf8(JSON.stringify({ id: this.deviceId, name, permanentSave, version, ts: Date.now() })));
		this.heartbeatAt = Date.now();
		this.heartbeatServerTime = (await this.sftp.stat(f)).mtime ?? Math.floor(Date.now() / 1000);
	}

	/** Server clock estimate (seconds), derived from our own heartbeat's mtime. */
	serverNow(): number {
		if (!this.heartbeatAt) return Math.floor(Date.now() / 1000);
		return this.heartbeatServerTime + Math.floor((Date.now() - this.heartbeatAt) / 1000);
	}

	/** Lists devices; heartbeat files are only re-read when their size changed vs `known`. */
	async devices(known?: Map<string, DeviceInfo & { size?: number }>): Promise<DeviceInfo[]> {
		const dir = `${this.meta}/devices`;
		const out: (DeviceInfo & { size?: number })[] = [];
		for (const e of await this.sftp.readdir(dir)) {
			if (!e.name.endsWith('.json')) continue;
			const id = e.name.slice(0, -5);
			const prev = known?.get(id);
			if (prev && prev.size === e.attrs.size && prev.name !== id) {
				out.push({ ...prev, seen: e.attrs.mtime ?? 0 });
				continue;
			}
			let name = id;
			let permanentSave = false;
			let version: string | undefined;
			try {
				const j = JSON.parse(fromUtf8((await this.sftp.readFile(`${dir}/${e.name}`)).data)) as {
					name?: unknown;
					permanentSave?: unknown;
					version?: unknown;
				};
				if (typeof j.name === 'string' && j.name) name = j.name;
				permanentSave = j.permanentSave === true;
				if (typeof j.version === 'string') version = j.version;
			} catch {
				/* ignore */
			}
			out.push({ id, name, seen: e.attrs.mtime ?? 0, permanentSave, version, size: e.attrs.size });
		}
		return out;
	}
}
