// LocalFs / Persistence on top of the Obsidian Vault API (works on desktop and mobile).

import { App, TAbstractFile, TFile, TFolder, normalizePath } from 'obsidian';
import { LocalFs, LocalStat, Persistence, SyncState } from './sync/types';
import { parentOf } from './sync/paths';

function toBuffer(d: Uint8Array): ArrayBuffer {
	return d.byteOffset === 0 && d.byteLength === d.buffer.byteLength
		? (d.buffer as ArrayBuffer)
		: (d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength) as ArrayBuffer);
}

export class ObsidianFs implements LocalFs {
	constructor(private app: App) {}

	private get vault() {
		return this.app.vault;
	}

	private get(p: string): TAbstractFile | null {
		return this.vault.getAbstractFileByPath(normalizePath(p));
	}

	async list(): Promise<{ files: Map<string, LocalStat>; folders: Set<string> }> {
		const files = new Map<string, LocalStat>();
		const folders = new Set<string>();
		for (const f of this.vault.getAllLoadedFiles()) {
			if (f instanceof TFile) files.set(f.path, { type: 'file', mtime: f.stat.mtime, size: f.stat.size });
			else if (f instanceof TFolder && !f.isRoot()) folders.add(f.path);
		}
		return { files, folders };
	}

	async stat(p: string): Promise<LocalStat | null> {
		const f = this.get(p);
		if (f instanceof TFile) return { type: 'file', mtime: f.stat.mtime, size: f.stat.size };
		if (f instanceof TFolder) return { type: 'folder', mtime: 0, size: 0 };
		return null;
	}

	async read(p: string): Promise<Uint8Array> {
		const f = this.get(p);
		if (!(f instanceof TFile)) throw new Error(`not a file: ${p}`);
		return new Uint8Array(await this.vault.readBinary(f));
	}

	async write(p: string, data: Uint8Array, mtimeMs: number): Promise<void> {
		const f = this.get(p);
		if (f instanceof TFolder) throw new Error(`a folder is in the way: ${p}`);
		if (f instanceof TFile) {
			await this.vault.modifyBinary(f, toBuffer(data), { mtime: mtimeMs });
			return;
		}
		await this.mkdir(parentOf(p));
		await this.vault.createBinary(normalizePath(p), toBuffer(data), { mtime: mtimeMs });
	}

	async mkdir(p: string): Promise<void> {
		if (!p) return;
		const f = this.get(p);
		if (f instanceof TFolder) return;
		if (f) throw new Error(`a file is in the way: ${p}`);
		await this.mkdir(parentOf(p));
		try {
			await this.vault.createFolder(normalizePath(p));
		} catch (e) {
			if (!(this.get(p) instanceof TFolder)) throw e;
		}
	}

	async remove(p: string): Promise<void> {
		const f = this.get(p);
		if (f) await this.app.fileManager.trashFile(f);
	}

	async rmdirIfEmpty(p: string): Promise<boolean> {
		const f = this.get(p);
		if (!f) return true;
		if (!(f instanceof TFolder)) return false;
		if (f.children.length) return false;
		await this.app.fileManager.trashFile(f);
		return true;
	}

	async rename(from: string, to: string): Promise<void> {
		const f = this.get(from);
		if (!f) throw new Error(`nothing to rename: ${from}`);
		await this.mkdir(parentOf(to));
		await this.vault.rename(f, normalizePath(to));
	}

	async caseConflict(p: string): Promise<string | null> {
		let folder: TFolder = this.vault.getRoot();
		let cur = '';
		for (const seg of normalizePath(p).split('/')) {
			cur = cur ? `${cur}/${seg}` : seg;
			const exact = this.get(cur);
			if (exact) {
				if (!(exact instanceof TFolder)) return null;
				folder = exact;
				continue;
			}
			const lower = seg.toLowerCase();
			const other = folder.children.find((c) => c.name.toLowerCase() === lower);
			return other ? other.path : null;
		}
		return null;
	}
}

/** state.json (hash base) and sync_ignore.json in the plugin folder; never synced. */
export class PluginPersistence implements Persistence {
	constructor(
		private app: App,
		private dir: string,
	) {}

	private p(name: string): string {
		return normalizePath(`${this.dir}/${name}`);
	}

	private async readJson<T>(name: string): Promise<T | null> {
		try {
			const a = this.app.vault.adapter;
			if (!(await a.exists(this.p(name)))) return null;
			return JSON.parse(await a.read(this.p(name))) as T;
		} catch (e) {
			console.error(`Obsyncher: cannot read ${name}`, e);
			return null;
		}
	}

	private async writeJson(name: string, v: unknown): Promise<void> {
		const a = this.app.vault.adapter;
		const tmp = this.p(`${name}.tmp`);
		await a.write(tmp, JSON.stringify(v));
		if (await a.exists(this.p(name))) await a.remove(this.p(name));
		await a.rename(tmp, this.p(name));
	}

	loadState(): Promise<SyncState | null> {
		return this.readJson<SyncState>('state.json');
	}

	saveState(s: SyncState): Promise<void> {
		return this.writeJson('state.json', s);
	}

	async loadIgnore(): Promise<string[]> {
		return (await this.readJson<string[]>('sync_ignore.json')) ?? [];
	}

	saveIgnore(list: string[]): Promise<void> {
		return this.writeJson('sync_ignore.json', list);
	}
}
