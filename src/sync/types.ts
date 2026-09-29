// Platform-neutral contracts of the sync engine. The Obsidian plugin and the
// Node test-suite each provide their own LocalFs / persistence implementations.

export interface LocalStat {
	type: 'file' | 'folder';
	/** milliseconds since epoch */
	mtime: number;
	size: number;
}

export interface LocalFs {
	/** All syncable files and folders (hidden/ignored paths already filtered out by the caller). */
	list(): Promise<{ files: Map<string, LocalStat>; folders: Set<string> }>;
	stat(path: string): Promise<LocalStat | null>;
	read(path: string): Promise<Uint8Array>;
	/** Create or overwrite; creates missing parent folders. */
	write(path: string, data: Uint8Array, mtimeMs: number): Promise<void>;
	mkdir(path: string): Promise<void>;
	/** Delete a file (implementations may move it to a trash). */
	remove(path: string): Promise<void>;
	/** Delete a folder only when it is empty. Returns false if it was not empty. */
	rmdirIfEmpty(path: string): Promise<boolean>;
	/** Rename/move a file or folder; creates missing parent folders. */
	rename(from: string, to: string): Promise<void>;
	/**
	 * An existing path that differs from `path` only by letter case (Windows, macOS and
	 * Android storage are case-insensitive), or null.
	 */
	caseConflict?(path: string): Promise<string | null>;
}

export interface RemoteStat {
	type: 'file' | 'folder';
	/** seconds since epoch (SFTP v3 precision) */
	mtime: number;
	size: number;
}

/** What we knew about a file right after it was last synchronised. */
export interface FileEntry {
	/** sha-256 (hex) of the content */
	h: string;
	/** local mtime (ms) and size */
	lm: number;
	ls: number;
	/** remote mtime (s) and size */
	rm: number;
	rs: number;
}

export interface SyncState {
	v: 1;
	deviceId: string;
	/** id of the remote vault this state belongs to (`.syncher/vault.json`) */
	remoteVaultId?: string;
	files: Record<string, FileEntry>;
	folders: Record<string, true>;
}

export type JournalEvent =
	| { t: 'put'; p: string; h: string; ts: number }
	| { t: 'del'; p: string; d?: boolean; ts: number }
	| { t: 'ren'; p: string; to: string; d?: boolean; ts: number }
	| { t: 'mkdir'; p: string; ts: number };

export interface DeviceInfo {
	id: string;
	name: string;
	/** server-side mtime (s) of the heartbeat file */
	seen: number;
	permanentSave?: boolean;
	/** plugin version the device runs (from its heartbeat; absent for 0.1.0/0.1.1) */
	version?: string;
}

export interface Persistence {
	loadState(): Promise<SyncState | null>;
	saveState(s: SyncState): Promise<void>;
	loadIgnore(): Promise<string[]>;
	saveIgnore(list: string[]): Promise<void>;
}

export interface SyncOptions {
	deviceId: string;
	deviceName: string;
	permanentSave: boolean;
	/** extra user exclude patterns (glob-ish, see paths.ts) */
	exclude: string[];
	/** plugin version, published in the heartbeat so other devices can see who runs what */
	version?: string;
	/** a device counts as "online" when its heartbeat is at most this old */
	presenceWindowSec: number;
}

export interface SyncCallbacks {
	/** "Device X deleted file Y" — only for live, concurrent deletions. */
	onRemoteDelete?(deviceName: string, path: string, keptLocally: boolean): void;
	onStatus?(s: SyncStatus, detail?: string): void;
	log?(msg: string): void;
	/** Asked before a full sync deletes many files. Return false to merge without deleting. */
	confirmMassDelete?(side: 'local' | 'remote', count: number, total: number): Promise<boolean>;
	/**
	 * Items that could not be synced (invalid name on this OS, permission denied, case clash…).
	 * Called after every sync pass that hit problems; the rest of the vault is synced regardless.
	 */
	onProblems?(problems: SyncProblem[]): void;
}

export interface SyncProblem {
	path: string;
	message: string;
}

export type SyncStatus = 'idle' | 'syncing' | 'offline' | 'error' | 'connecting';
