// Syncher sync engine.
//
// Model: every device keeps a local "base" record (hash + stats at the moment of the
// last successful sync) for each path. Comparing base vs. current local vs. current
// remote tells who changed what (three-way), which decides upload / download /
// delete / last-writer-wins. Live propagation between online devices goes through
// a per-device append-only journal on the server; a full scan is only needed at
// connect time (and periodically as a safety net).

import { hashHex } from './hash';
import { PathFilter, depth, isUnder, oldName, parentOf, rebase } from './paths';
import { RemoteStore } from './remote';
import {
	DeviceInfo,
	FileEntry,
	JournalEvent,
	LocalFs,
	LocalStat,
	Persistence,
	RemoteStat,
	SyncCallbacks,
	SyncOptions,
	SyncProblem,
	SyncState,
} from './types';

type Outcome = 'none' | 'uploaded' | 'downloaded' | 'deleted-local' | 'kept-local' | 'deleted-remote' | 'conflict';

interface LocalInfo {
	stat: LocalStat;
	hash: string;
	data?: Uint8Array;
}

interface Task {
	key: string;
	run: () => Promise<void>;
}

const HEARTBEAT_EVERY_MS = 15000;
/** Files reconciled in parallel during a scan: each one costs several SFTP round trips, which
 * over the phone relay dominate (a first sync of ~1300 notes took >25 min one by one). */
const SCAN_PARALLEL = 8;

/** A remote item whose name clashes (by letter case only) with a different local one. */
export class CaseClashError extends Error {
	constructor(
		readonly path: string,
		readonly existing: string,
	) {
		super(`name differs only by letter case from existing "${existing}"`);
		this.name = 'CaseClashError';
	}
}

export class SyncEngine {
	private remote?: RemoteStore;
	private state: SyncState;
	private ignore = new Set<string>();
	private filter: PathFilter;
	private queue: Task[] = [];
	private queued = new Set<string>();
	private running = false;
	private idleWaiters: (() => void)[] = [];
	private journalOffsets = new Map<string, number>();
	private presence = new Map<string, DeviceInfo>();
	private lastHeartbeat = 0;
	private heartbeatBusy = false;
	private createChain: Promise<unknown> = Promise.resolve();
	private saveTimer?: number;
	private stateDirty = false;
	private noDeletes = false;
	/** items that currently cannot be synced: path -> reason */
	private problems = new Map<string, string>();
	private reported = new Set<string>();
	/** set when something happened while offline: a full sync is required on reconnect */
	needsFullSync = true;
	onDisconnect: (err: Error) => void = () => undefined;

	constructor(
		private local: LocalFs,
		private persist: Persistence,
		private opts: SyncOptions,
		private cb: SyncCallbacks = {},
	) {
		this.state = { v: 1, deviceId: opts.deviceId, files: {}, folders: {} };
		this.filter = new PathFilter(opts.exclude);
	}

	// ---------------------------------------------------------------- lifecycle

	async init(): Promise<void> {
		const s = await this.persist.loadState();
		if (s && s.v === 1 && s.deviceId === this.opts.deviceId) this.state = s;
		this.ignore = new Set(await this.persist.loadIgnore());
		if (!this.opts.permanentSave && this.ignore.size) {
			this.ignore.clear();
			await this.persist.saveIgnore([]);
		}
	}

	get connected(): boolean {
		return !!this.remote && !this.remote.sftp.closed;
	}

	get ignoreList(): string[] {
		return [...this.ignore].sort();
	}

	get devices(): DeviceInfo[] {
		return [...this.presence.values()];
	}

	/** Called by the plugin after (re)connecting. Runs the initial full sync. */
	async attach(remote: RemoteStore): Promise<void> {
		this.remote = remote;
		await this.enqueueAndWait('attach', async () => {
			const vid = await remote.vaultId();
			if (this.state.remoteVaultId !== vid) {
				if (this.state.remoteVaultId) this.log(`remote vault id changed (${this.state.remoteVaultId} -> ${vid}); merging without deletions`);
				this.state.files = {};
				this.state.folders = {};
				this.state.remoteVaultId = vid;
				this.markDirty();
			}
			await remote.heartbeat(this.opts.deviceName, this.opts.permanentSave, this.opts.version);
			this.lastHeartbeat = Date.now();
			await remote.startJournal();
			await remote.cleanupTmp().catch(() => undefined);
			// Snapshot journal positions BEFORE scanning: events written during the scan are replayed later.
			this.journalOffsets.clear();
			for (const j of await remote.listJournals()) this.journalOffsets.set(j.name, j.size);
			await this.refreshPresence();
			this.needsFullSync = false;
			// A sync failure that is not a lost connection must not tear the connection down:
			// live sync keeps working and the next full sync retries.
			await this.guarded('', () => this.syncScope('', true));
		});
	}

	/** Items that currently cannot be synced, sorted by path. */
	get problemList(): SyncProblem[] {
		return [...this.problems].map(([path, message]) => ({ path, message })).sort((a, b) => a.path.localeCompare(b.path));
	}

	/** True when `e` means the connection is gone (as opposed to one item failing). */
	private connectionLost(): boolean {
		return !this.remote || this.remote.sftp.closed;
	}

	/** Runs one item's sync; an item-level failure is recorded as a problem instead of aborting the pass. */
	private async guarded(path: string, fn: () => Promise<unknown>, fresh?: SyncProblem[]): Promise<void> {
		try {
			await fn();
			if (this.problems.delete(path)) this.log(`problem cleared: ${path || '(vault)'}`);
		} catch (e) {
			if (this.connectionLost()) throw e;
			this.addProblem(path, (e as Error).message ?? String(e), fresh);
		}
	}

	private addProblem(path: string, message: string, fresh?: SyncProblem[]): void {
		this.problems.set(path, message);
		this.log(`cannot sync ${path || '(vault)'}: ${message}`);
		// report each (path, reason) once per session: periodic full syncs must not spam pop-ups
		const key = `${path}\n${message}`;
		if (this.reported.has(key)) return;
		this.reported.add(key);
		if (fresh) fresh.push({ path, message });
		else this.cb.onProblems?.([{ path, message }]);
	}

	private async clashes(path: string, except?: string): Promise<boolean> {
		const other = await this.local.caseConflict?.(path);
		return !!other && other !== path && other !== except;
	}

	/** Runs `fn` exclusively among other local creations. */
	private createLock<T>(fn: () => Promise<T>): Promise<T> {
		const run = this.createChain.then(fn);
		this.createChain = run.catch(() => undefined);
		return run;
	}

	/** Throws CaseClashError when creating `path` locally would hit an item differing only by case. */
	private async assertNoCaseClash(path: string, except?: string): Promise<void> {
		const other = await this.local.caseConflict?.(path);
		if (other && other !== path && other !== except) throw new CaseClashError(path, other);
	}

	detach(): void {
		this.remote = undefined;
		this.needsFullSync = true;
		this.queue = [];
		this.queued.clear();
	}

	async flush(): Promise<void> {
		if (this.saveTimer) window.clearTimeout(this.saveTimer);
		this.saveTimer = undefined;
		if (this.stateDirty) {
			this.stateDirty = false;
			await this.persist.saveState(this.state);
		}
	}

	setExclude(patterns: string[]): void {
		this.opts.exclude = patterns;
		this.filter = new PathFilter(patterns);
	}

	setDeviceName(name: string): void {
		this.opts.deviceName = name;
		this.lastHeartbeat = 0;
	}

	/** Toggling "Permanent save" off clears sync_ignore, re-hashes everything and re-uploads kept files. */
	async setPermanentSave(on: boolean): Promise<void> {
		if (this.opts.permanentSave === on) return;
		this.opts.permanentSave = on;
		this.lastHeartbeat = 0;
		if (on) return;
		this.ignore.clear();
		await this.persist.saveIgnore([]);
		for (const e of Object.values(this.state.files)) e.lm = -1; // force re-hash
		this.markDirty();
		this.requestFullSync();
	}

	requestFullSync(): void {
		if (!this.connected) {
			this.needsFullSync = true;
			return;
		}
		this.enqueue('full', () => this.guarded('', () => this.syncScope('', true)));
	}

	whenIdle(): Promise<void> {
		if (!this.running && this.queue.length === 0) return Promise.resolve();
		return new Promise((r) => this.idleWaiters.push(r));
	}

	// ---------------------------------------------------------------- local triggers

	localChanged(path: string): void {
		if (this.filter.excluded(path)) return;
		this.enqueue(`f:${path}`, () => this.guarded(path, () => this.reconcileFile(path)));
	}

	localFolderChanged(path: string): void {
		if (this.filter.excluded(path)) return;
		this.enqueue(`d:${path}`, () => this.guarded(path, () => this.reconcileFolder(path)));
	}

	localDeleted(path: string, isFolder: boolean): void {
		if (this.filter.excluded(path)) return;
		if (isFolder) this.enqueue(`s:${path}`, () => this.guarded(path, () => this.syncScope(path, false)));
		else this.enqueue(`f:${path}`, () => this.guarded(path, () => this.reconcileFile(path)));
	}

	localRenamed(from: string, to: string, isFolder: boolean): void {
		this.enqueue(`r:${from}>${to}`, () => this.guarded(to, () => this.handleLocalRename(from, to, isFolder)));
	}

	/** Remote change polling tick (journal + presence + heartbeat). */
	poll(): void {
		if (!this.connected) return;
		void this.heartbeatIfDue();
		this.enqueue('poll', () => this.doPoll());
	}

	/**
	 * Heartbeat + presence refresh. Runs beside the task queue (it only touches our own
	 * heartbeat file), so a long sync does not make this device look offline to others.
	 */
	private async heartbeatIfDue(): Promise<void> {
		const r = this.remote;
		if (!r || this.heartbeatBusy || Date.now() - this.lastHeartbeat < HEARTBEAT_EVERY_MS) return;
		this.heartbeatBusy = true;
		try {
			await r.heartbeat(this.opts.deviceName, this.opts.permanentSave, this.opts.version);
			this.lastHeartbeat = Date.now();
			await this.refreshPresence();
		} catch (e) {
			this.log(`heartbeat failed: ${(e as Error).message}`);
		} finally {
			this.heartbeatBusy = false;
		}
	}

	// ---------------------------------------------------------------- queue

	private enqueue(key: string, run: () => Promise<void>): void {
		if (!this.connected) {
			this.needsFullSync = true;
			return;
		}
		if (this.queued.has(key)) return;
		this.queued.add(key);
		this.queue.push({ key, run });
		void this.pump();
	}

	private enqueueAndWait(key: string, run: () => Promise<void>): Promise<void> {
		return new Promise((resolve, reject) => {
			this.queue.push({
				key,
				run: () =>
					run().then(resolve, (e: unknown) => {
						const err = e instanceof Error ? e : new Error(String(e));
						reject(err);
						throw err;
					}),
			});
			void this.pump();
		});
	}

	private async pump(): Promise<void> {
		if (this.running) return;
		this.running = true;
		this.cb.onStatus?.('syncing');
		try {
			while (this.queue.length) {
				const t = this.queue.shift()!;
				this.queued.delete(t.key);
				const remote = this.remote;
				if (!remote) continue;
				try {
					await t.run();
				} catch (e) {
					const err = e as Error;
					if (this.remote !== remote) {
						// detached (or replaced by a new connection) while the task ran: not our business any more
						this.log(`task ${t.key} dropped after disconnect: ${err.message}`);
						continue;
					}
					if (remote.sftp.closed) {
						this.log(`connection lost during ${t.key}: ${err.message}`);
						this.detach();
						this.cb.onStatus?.('offline', err.message);
						this.onDisconnect(err);
						break;
					}
					this.log(`task ${t.key} failed: ${err.stack ?? err.message}`);
				}
			}
		} finally {
			this.running = false;
			this.scheduleSave();
			if (this.remote) {
				const n = this.problems.size;
				if (n) this.cb.onStatus?.('error', `${n} item(s) not synced`);
				else this.cb.onStatus?.('idle');
			}
			const w = this.idleWaiters;
			this.idleWaiters = [];
			for (const f of w) f();
		}
	}

	// ---------------------------------------------------------------- helpers

	private log(m: string): void {
		this.cb.log?.(m);
	}

	private markDirty(): void {
		this.stateDirty = true;
		this.scheduleSave();
	}

	private scheduleSave(): void {
		if (!this.stateDirty || this.saveTimer) return;
		this.saveTimer = window.setTimeout(() => {
			this.saveTimer = undefined;
			void this.flush();
		}, 1000);
	}

	private get r(): RemoteStore {
		if (!this.remote) throw new Error('not connected');
		return this.remote;
	}

	/** The ignored path covering `p` (itself or an ancestor), if any. */
	private ignoredRoot(p: string): string | undefined {
		if (!this.ignore.size) return undefined;
		let cur = p;
		for (;;) {
			if (this.ignore.has(cur)) return cur;
			if (!cur.includes('/')) return undefined;
			cur = parentOf(cur);
		}
	}

	private async addIgnore(p: string): Promise<void> {
		this.ignore.add(p);
		await this.persist.saveIgnore(this.ignoreList);
	}

	private async replaceIgnore(from: string, to: string): Promise<void> {
		for (const x of [...this.ignore]) {
			if (isUnder(x, from)) {
				this.ignore.delete(x);
				this.ignore.add(rebase(x, from, to));
			}
		}
		await this.persist.saveIgnore(this.ignoreList);
	}

	private async freeOldName(p: string, isFolder: boolean): Promise<string> {
		for (let n = 1; ; n++) {
			const cand = oldName(p, n, isFolder);
			if (!(await this.local.stat(cand)) && !this.state.files[cand] && !(await this.r.stat(cand))) return cand;
		}
	}

	private async localInfo(path: string, st?: LocalStat | null): Promise<LocalInfo | null> {
		if (st === undefined) st = await this.local.stat(path);
		if (!st || st.type !== 'file') return null;
		const e = this.state.files[path];
		if (e && e.lm === st.mtime && e.ls === st.size) return { stat: st, hash: e.h };
		const data = await this.local.read(path);
		return { stat: st, hash: await hashHex(data), data };
	}

	private async journal(ev: JournalEvent): Promise<void> {
		await this.r.appendJournal(ev);
	}

	// ---------------------------------------------------------------- transfers

	private async upload(path: string, L: LocalInfo): Promise<Outcome> {
		let data = L.data ?? (await this.local.read(path));
		let stat = L.stat;
		if (data.length !== stat.size) {
			stat = (await this.local.stat(path)) ?? stat;
			data = await this.local.read(path);
		}
		const h = L.data && data === L.data ? L.hash : await hashHex(data);
		const rs = await this.r.write(path, data, Math.floor(stat.mtime / 1000));
		this.state.files[path] = { h, lm: stat.mtime, ls: stat.size, rm: rs.mtime, rs: rs.size };
		this.markDirty();
		await this.journal({ t: 'put', p: path, h, ts: Date.now() });
		this.log(`↑ ${path}`);
		return 'uploaded';
	}

	private async download(path: string, L: LocalInfo | null, pre?: { data: Uint8Array; stat: RemoteStat }): Promise<Outcome> {
		// on a case-insensitive disk `note.md` would silently overwrite an existing `Note.md`
		if (!L) await this.assertNoCaseClash(path);
		const { data, stat } = pre ?? (await this.r.read(path));
		const h = await hashHex(data);
		if (L && L.hash === h) {
			this.state.files[path] = { h, lm: L.stat.mtime, ls: L.stat.size, rm: stat.mtime, rs: stat.size };
			this.markDirty();
			return 'none';
		}
		if (L) await this.local.write(path, data, stat.mtime * 1000);
		// new local path: re-check the case clash and create atomically (scans download in parallel)
		else
			await this.createLock(async () => {
				await this.assertNoCaseClash(path);
				await this.local.write(path, data, stat.mtime * 1000);
			});
		const st = await this.local.stat(path);
		this.state.files[path] = { h, lm: st?.mtime ?? stat.mtime * 1000, ls: st?.size ?? data.length, rm: stat.mtime, rs: stat.size };
		this.markDirty();
		this.log(`↓ ${path}`);
		return 'downloaded';
	}

	/** Both sides changed (or both new): identical content is adopted, otherwise the later edit wins. */
	private async lastWriterWins(path: string, L: LocalInfo, R: RemoteStat): Promise<Outcome> {
		const remote = await this.r.read(path);
		const h = await hashHex(remote.data);
		if (h === L.hash) return this.download(path, L, remote);
		const localSec = L.stat.mtime / 1000;
		this.log(`conflict on ${path}: local ${new Date(L.stat.mtime).toISOString()} vs remote ${new Date(R.mtime * 1000).toISOString()}`);
		if (localSec > remote.stat.mtime) return this.upload(path, L);
		return this.download(path, L, remote);
	}

	// ---------------------------------------------------------------- reconcile: files

	/**
	 * Three-way reconcile of a single file. `pre` carries already-known stats
	 * (from a scan) to avoid extra round trips; `hint` comes from a journal event.
	 */
	async reconcileFile(
		path: string,
		pre?: { L?: LocalStat | null; R?: RemoteStat | null },
		hint?: { hash?: string; deletedAt?: number },
	): Promise<Outcome> {
		if (this.filter.excluded(path)) return 'none';
		let R = pre?.R !== undefined ? pre.R : await this.r.stat(path);
		if (R && R.type !== 'file') R = null;

		const ign = this.ignoredRoot(path);
		if (ign) {
			if (!R) return 'none';
			// Rule: a kept (Permanent save) item collides with an incoming remote one ->
			// rename the kept one to *-N.old (still ignored) and accept the remote file.
			const lst = await this.local.stat(ign);
			if (lst) {
				const target = await this.freeOldName(ign, lst.type === 'folder');
				await this.local.rename(ign, target);
				await this.replaceIgnore(ign, target);
				this.log(`kept ${ign} renamed to ${target} (incoming remote ${path})`);
			} else {
				this.ignore.delete(ign);
				await this.persist.saveIgnore(this.ignoreList);
			}
			return this.download(path, null);
		}

		const Lst = pre?.L !== undefined ? pre.L : await this.local.stat(path);
		if (Lst && Lst.type !== 'file') return 'none';
		const L = Lst ? await this.localInfo(path, Lst) : null;
		let E: FileEntry | undefined = this.state.files[path];
		if (E && L && E.lm === -1 && E.h === L.hash) {
			E.lm = L.stat.mtime;
			E.ls = L.stat.size;
		}

		const localChanged = !!L && (!E || L.hash !== E.h);
		const remoteChanged =
			!!R && (!E || R.mtime !== E.rm || R.size !== E.rs || (hint?.hash !== undefined && hint.hash !== E.h));

		if (L && R) {
			if (E && !localChanged && !remoteChanged) {
				if (E.lm !== L.stat.mtime || E.ls !== L.stat.size) {
					E.lm = L.stat.mtime;
					E.ls = L.stat.size;
					this.markDirty();
				}
				return 'none';
			}
			if (!E) return this.lastWriterWins(path, L, R);
			if (localChanged && !remoteChanged) return this.upload(path, L);
			if (!localChanged && remoteChanged) return this.download(path, L);
			return this.lastWriterWins(path, L, R);
		}

		if (E && this.noDeletes) {
			delete this.state.files[path];
			this.markDirty();
			E = undefined;
		}

		if (L && !R) {
			// Without a base this looks like a new local file. But if another device just deleted it
			// (journal event) and our copy is not newer than that deletion, it is a stale copy —
			// uploading it would resurrect the file everywhere.
			const staleCopy = !E && hint?.deletedAt !== undefined && L.stat.mtime <= hint.deletedAt;
			if ((!E && !staleCopy) || (E && localChanged)) return this.upload(path, L); // new file, or edit beats deletion
			if (E) {
				delete this.state.files[path];
				this.markDirty();
			}
			if (this.opts.permanentSave) {
				await this.addIgnore(path);
				this.log(`remote deleted ${path}; kept locally (Permanent save)`);
				return 'kept-local';
			}
			await this.local.remove(path);
			this.log(`✗ local ${path}`);
			return 'deleted-local';
		}

		if (!L && R) {
			if (!E || remoteChanged) return this.download(path, null); // new remote file, or remote edit beats local deletion
			await this.r.remove(path);
			delete this.state.files[path];
			this.markDirty();
			await this.journal({ t: 'del', p: path, ts: Date.now() });
			this.log(`✗ remote ${path}`);
			return 'deleted-remote';
		}

		if (E) {
			delete this.state.files[path];
			this.markDirty();
		}
		return 'none';
	}

	// ---------------------------------------------------------------- reconcile: folders

	async reconcileFolder(path: string, pre?: { L?: LocalStat | null; R?: RemoteStat | null }): Promise<Outcome> {
		if (!path || this.filter.excluded(path)) return 'none';
		let R = pre?.R !== undefined ? pre.R : await this.r.stat(path);
		if (R && R.type !== 'folder') R = null;
		let L = pre?.L !== undefined ? pre.L : await this.local.stat(path);
		if (L && L.type !== 'folder') L = null;

		const ign = this.ignoredRoot(path);
		if (ign) {
			if (!R) return 'none';
			if (L || ign !== path) {
				const lst = await this.local.stat(ign);
				if (lst) {
					const target = await this.freeOldName(ign, lst.type === 'folder');
					await this.local.rename(ign, target);
					await this.replaceIgnore(ign, target);
				}
			} else {
				this.ignore.delete(ign);
				await this.persist.saveIgnore(this.ignoreList);
			}
			await this.local.mkdir(path);
			this.state.folders[path] = true;
			this.markDirty();
			return 'downloaded';
		}

		let E = !!this.state.folders[path];
		if (E && this.noDeletes && !(L && R)) {
			delete this.state.folders[path];
			E = false;
		}

		if (L && R) {
			if (!E) {
				this.state.folders[path] = true;
				this.markDirty();
			}
			return 'none';
		}
		if (L && !R) {
			if (!E) {
				await this.r.mkdirp(path);
				this.state.folders[path] = true;
				this.markDirty();
				await this.journal({ t: 'mkdir', p: path, ts: Date.now() });
				return 'uploaded';
			}
			delete this.state.folders[path];
			this.markDirty();
			if (this.opts.permanentSave) {
				await this.addIgnore(path);
				return 'kept-local';
			}
			if (await this.local.rmdirIfEmpty(path)) return 'deleted-local';
			// still holds local-only content: keep it alive on the server
			await this.r.mkdirp(path);
			this.state.folders[path] = true;
			return 'uploaded';
		}
		if (!L && R) {
			if (!E) {
				await this.assertNoCaseClash(path);
				await this.local.mkdir(path);
				this.state.folders[path] = true;
				this.markDirty();
				return 'downloaded';
			}
			if (await this.remoteRmdirIfEmpty(path)) {
				delete this.state.folders[path];
				this.markDirty();
				await this.journal({ t: 'del', p: path, d: true, ts: Date.now() });
				return 'deleted-remote';
			}
			await this.assertNoCaseClash(path);
			await this.local.mkdir(path); // remote got new content meanwhile
			return 'downloaded';
		}
		if (E) {
			delete this.state.folders[path];
			this.markDirty();
		}
		return 'none';
	}

	/** Removes a remote folder when it holds nothing syncable (hidden/excluded leftovers are removed too). */
	private async remoteRmdirIfEmpty(path: string): Promise<boolean> {
		const inside = await this.r.scan(this.filter, path);
		inside.delete(path);
		if (inside.size) return false;
		await this.r.sftp.rmrf(this.r.abs(path));
		return true;
	}

	// ---------------------------------------------------------------- reconcile: trees

	/** Reconciles everything under `under` ('' = whole vault). */
	async syncScope(under: string, full: boolean): Promise<void> {
		const started = Date.now();
		const listing = await this.local.list();
		const unreadable = new Set<string>();
		const remote = await this.r.scan(this.filter, under, unreadable);
		// content of unreadable remote folders is unknown: leave everything below them alone
		const unknown = (p: string): boolean => {
			for (const d of unreadable) if (p !== d && isUnder(p, d)) return true;
			return false;
		};

		const lFiles = new Map<string, LocalStat>();
		const lFolders = new Set<string>();
		for (const [p, st] of listing.files) if (isUnder(p, under) && !this.filter.excluded(p)) lFiles.set(p, st);
		for (const p of listing.folders) if (isUnder(p, under) && !this.filter.excluded(p)) lFolders.add(p);

		const files = new Set<string>();
		const folders = new Set<string>();
		for (const p of lFiles.keys()) files.add(p);
		for (const p of lFolders) folders.add(p);
		for (const [p, st] of remote) (st.type === 'file' ? files : folders).add(p);
		for (const p of Object.keys(this.state.files)) if (isUnder(p, under)) files.add(p);
		for (const p of Object.keys(this.state.folders)) if (isUnder(p, under)) folders.add(p);
		if (unreadable.size) {
			for (const p of [...files]) if (unknown(p)) files.delete(p);
			for (const p of [...folders]) if (unknown(p)) folders.delete(p);
		}

		// Mass-deletion guard (e.g. wrong remote dir, wiped vault).
		this.noDeletes = false;
		if (full) {
			let delLocal = 0;
			let delRemote = 0;
			const known = Object.keys(this.state.files).length;
			for (const p of files) {
				const E = this.state.files[p];
				if (!E || this.ignoredRoot(p)) continue;
				const R = remote.get(p);
				if (lFiles.has(p) && !R) delLocal++;
				if (!lFiles.has(p) && R) delRemote++;
			}
			const limit = Math.max(20, Math.floor(known * 0.5));
			for (const [side, count] of [['local', delLocal], ['remote', delRemote]] as const) {
				if (count > limit) {
					const ok = (await this.cb.confirmMassDelete?.(side, count, known)) ?? false;
					if (!ok) {
						this.log(`mass deletion of ${count} ${side} files refused: merging without deletions`);
						this.noDeletes = true;
					}
				}
			}
		}

		// One item that cannot be synced (name not allowed on this OS, permission denied, case
		// clash…) must never stop the rest of the vault: it is recorded and reported instead.
		const fresh: SyncProblem[] = [];
		for (const p of [...this.problems.keys()]) if (p && isUnder(p, under)) this.problems.delete(p);
		try {
			const order = [...files].sort();
			let next = 0;
			const worker = async (): Promise<void> => {
				while (next < order.length) {
					const p = order[next++];
					await this.guarded(
						p,
						() =>
							this.reconcileFile(p, {
								L: lFiles.get(p) ?? (lFolders.has(p) ? { type: 'folder', mtime: 0, size: 0 } : null),
								R: remote.get(p) ?? null,
							}),
						fresh,
					);
				}
			};
			await Promise.all(Array.from({ length: Math.min(SCAN_PARALLEL, order.length) }, worker));
			const orderedFolders = [...folders].filter((p) => p !== '').sort((a, b) => depth(b) - depth(a) || a.localeCompare(b));
			for (const p of orderedFolders) await this.guarded(p, () => this.reconcileFolder(p), fresh);
		} finally {
			this.noDeletes = false;
		}
		for (const d of unreadable) this.addProblem(d, 'cannot read this folder on the server (permission denied?)', fresh);
		if (fresh.length) this.cb.onProblems?.(fresh);
		this.markDirty();
		if (full) this.log(`full sync done: ${files.size} files, ${folders.size} folders in ${Date.now() - started} ms`);
	}

	// ---------------------------------------------------------------- renames

	private async handleLocalRename(from: string, to: string, isFolder: boolean): Promise<void> {
		const plain = !this.filter.excluded(from) && !this.filter.excluded(to) && !this.ignoredRoot(from) && !this.ignoredRoot(to);
		if (!isFolder) {
			const E = this.state.files[from];
			if (plain && E) {
				const [Rfrom, Rto] = [await this.r.stat(from), await this.r.stat(to)];
				if (Rfrom && Rfrom.type === 'file' && Rfrom.mtime === E.rm && Rfrom.size === E.rs && !Rto) {
					await this.r.rename(from, to);
					this.state.files[to] = E;
					delete this.state.files[from];
					this.markDirty();
					await this.journal({ t: 'ren', p: from, to, ts: Date.now() });
					this.log(`→ ${from} ⇒ ${to}`);
				}
			}
			if (!this.filter.excluded(to)) await this.reconcileFile(to);
			if (!this.filter.excluded(from)) await this.reconcileFile(from);
			return;
		}
		if (plain && this.state.folders[from]) {
			const [Rfrom, Rto] = [await this.r.stat(from), await this.r.stat(to)];
			if (Rfrom && Rfrom.type === 'folder' && !Rto) {
				await this.r.rename(from, to);
				this.remapPrefix(from, to);
				await this.journal({ t: 'ren', p: from, to, d: true, ts: Date.now() });
				this.log(`→ ${from}/ ⇒ ${to}/`);
			}
		}
		if (!this.filter.excluded(to)) await this.syncScope(to, false);
		if (!this.filter.excluded(from)) await this.syncScope(from, false);
	}

	private remapPrefix(from: string, to: string): void {
		for (const key of ['files', 'folders'] as const) {
			const table = this.state[key] as Record<string, unknown>;
			for (const p of Object.keys(table)) {
				if (isUnder(p, from)) {
					table[rebase(p, from, to)] = table[p];
					delete table[p];
				}
			}
		}
		this.markDirty();
	}

	private async applyRemoteRename(from: string, to: string, isFolder: boolean): Promise<void> {
		const plain = !this.filter.excluded(from) && !this.filter.excluded(to) && !this.ignoredRoot(from) && !this.ignoredRoot(to);
		if (!isFolder) {
			const E = this.state.files[from];
			if (plain && E) {
				const [L, Lto] = [await this.local.stat(from), await this.local.stat(to)];
				if (L && L.type === 'file' && L.mtime === E.lm && L.size === E.ls && !Lto && !(await this.clashes(to, from))) {
					await this.local.rename(from, to);
					const st = await this.local.stat(to);
					this.state.files[to] = { ...E, lm: st?.mtime ?? E.lm, ls: st?.size ?? E.ls };
					delete this.state.files[from];
					this.markDirty();
				}
			}
			await this.reconcileFile(to);
			await this.reconcileFile(from);
			return;
		}
		if (plain) {
			const [L, Lto] = [await this.local.stat(from), await this.local.stat(to)];
			if (L && L.type === 'folder' && !Lto && !(await this.clashes(to, from))) {
				await this.local.rename(from, to);
				this.remapPrefix(from, to);
				// local mtimes can change on move for some adapters: refresh cheaply on next reconcile
			}
		}
		await this.syncScope(to, false);
		await this.syncScope(from, false);
	}

	// ---------------------------------------------------------------- remote polling

	/** True when the device's heartbeat is fresh (by server clock). */
	isOnline(d: DeviceInfo): boolean {
		return this.isActive(d);
	}

	private isActive(d: DeviceInfo | undefined): boolean {
		if (!d || !this.remote) return false;
		return this.remote.serverNow() - d.seen <= this.opts.presenceWindowSec;
	}

	private async refreshPresence(): Promise<void> {
		for (const d of await this.r.devices(this.presence)) this.presence.set(d.id, d);
	}

	private async doPoll(): Promise<void> {
		const r = this.r;
		await this.heartbeatIfDue();
		const journals = await r.listJournals();
		const seen = new Set<string>();
		for (const j of journals) {
			seen.add(j.name);
			if (j.deviceId === this.opts.deviceId) continue;
			const off = this.journalOffsets.get(j.name) ?? 0;
			if (j.size < off) {
				this.journalOffsets.set(j.name, 0);
				this.needsFullSync = true;
				continue;
			}
			if (j.size === off) continue;
			if (!this.presence.has(j.deviceId)) await this.refreshPresence();
			const { events, offset } = await r.readJournal(j.name, off);
			this.journalOffsets.set(j.name, offset);
			for (const ev of events) await this.guarded(ev.p, () => this.applyEvent(ev, this.presence.get(j.deviceId), j.deviceId));
		}
		for (const name of [...this.journalOffsets.keys()]) if (!seen.has(name)) this.journalOffsets.delete(name);
		if (this.needsFullSync) {
			this.needsFullSync = false;
			await this.syncScope('', true);
		}
	}

	private async applyEvent(ev: JournalEvent, dev: DeviceInfo | undefined, devId: string): Promise<void> {
		switch (ev.t) {
			case 'put':
				await this.reconcileFile(ev.p, undefined, { hash: ev.h });
				return;
			case 'mkdir':
				await this.reconcileFolder(ev.p);
				return;
			case 'ren':
				await this.applyRemoteRename(ev.p, ev.to, !!ev.d);
				return;
			case 'del': {
				let outcome: Outcome;
				if (ev.d) {
					const existed = !!(await this.local.stat(ev.p));
					await this.syncScope(ev.p, false);
					const now = await this.local.stat(ev.p);
					outcome = existed ? (now ? (this.ignoredRoot(ev.p) ? 'kept-local' : 'none') : 'deleted-local') : 'none';
				} else outcome = await this.reconcileFile(ev.p, undefined, { deletedAt: ev.ts });
				const live = Date.now() - ev.ts < 5 * 60 * 1000;
				if ((outcome === 'deleted-local' || outcome === 'kept-local') && live && this.isActive(dev))
					this.cb.onRemoteDelete?.(dev?.name ?? devId, ev.p, outcome === 'kept-local');
				return;
			}
		}
	}
}
