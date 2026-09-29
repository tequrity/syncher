// Node implementations of LocalFs / Persistence used to simulate devices in tests.

import { promises as fs } from 'fs';
import { dirname, join } from 'path';
import { LocalFs, LocalStat, Persistence, SyncState } from '../src/sync/types';

export class NodeFs implements LocalFs {
	constructor(readonly root: string) {}

	private abs(p: string): string {
		return join(this.root, ...p.split('/'));
	}

	async list(): Promise<{ files: Map<string, LocalStat>; folders: Set<string> }> {
		const files = new Map<string, LocalStat>();
		const folders = new Set<string>();
		const walk = async (rel: string): Promise<void> => {
			for (const d of await fs.readdir(this.abs(rel), { withFileTypes: true })) {
				const p = rel ? `${rel}/${d.name}` : d.name;
				if (d.isDirectory()) {
					folders.add(p);
					await walk(p);
				} else if (d.isFile()) {
					const st = await fs.stat(this.abs(p));
					files.set(p, { type: 'file', mtime: Math.floor(st.mtimeMs), size: st.size });
				}
			}
		};
		await walk('');
		return { files, folders };
	}

	async stat(p: string): Promise<LocalStat | null> {
		try {
			const st = await fs.stat(this.abs(p));
			return { type: st.isDirectory() ? 'folder' : 'file', mtime: Math.floor(st.mtimeMs), size: st.size };
		} catch {
			return null;
		}
	}

	async read(p: string): Promise<Uint8Array> {
		return new Uint8Array(await fs.readFile(this.abs(p)));
	}

	async write(p: string, data: Uint8Array, mtimeMs: number): Promise<void> {
		await fs.mkdir(dirname(this.abs(p)), { recursive: true });
		await fs.writeFile(this.abs(p), data);
		await fs.utimes(this.abs(p), mtimeMs / 1000, mtimeMs / 1000);
	}

	async mkdir(p: string): Promise<void> {
		await fs.mkdir(this.abs(p), { recursive: true });
	}

	async remove(p: string): Promise<void> {
		await fs.rm(this.abs(p), { force: true });
	}

	async rmdirIfEmpty(p: string): Promise<boolean> {
		try {
			const left = (await fs.readdir(this.abs(p))).filter((n) => !n.startsWith('.'));
			if (left.length) return false;
			await fs.rm(this.abs(p), { recursive: true, force: true });
			return true;
		} catch {
			return true;
		}
	}

	async rename(from: string, to: string): Promise<void> {
		await fs.mkdir(dirname(this.abs(to)), { recursive: true });
		await fs.rename(this.abs(from), this.abs(to));
	}

	/** Behaves like a case-insensitive disk regardless of the host OS. */
	async caseConflict(p: string): Promise<string | null> {
		let cur = '';
		for (const seg of p.split('/')) {
			let names: string[];
			try {
				names = await fs.readdir(this.abs(cur));
			} catch {
				return null;
			}
			const next = cur ? `${cur}/${seg}` : seg;
			if (names.includes(seg)) {
				cur = next;
				continue;
			}
			const other = names.find((n) => n.toLowerCase() === seg.toLowerCase());
			return other ? (cur ? `${cur}/${other}` : other) : null;
		}
		return null;
	}
}

export class MemoryPersistence implements Persistence {
	state: SyncState | null = null;
	ignore: string[] = [];
	async loadState() {
		return this.state ? structuredClone(this.state) : null;
	}
	async saveState(s: SyncState) {
		this.state = structuredClone(s);
	}
	async loadIgnore() {
		return [...this.ignore];
	}
	async saveIgnore(l: string[]) {
		this.ignore = [...l];
	}
}

/** Rejects names Obsidian refuses on Windows (`bad:name.md` …), like the real vault does. */
export class StrictNamesFs extends NodeFs {
	private check(p: string): void {
		if (/[*"\\<>:|?]/.test(p)) throw new Error('File name cannot contain any of the following characters: * " \\ / < > : | ?');
	}
	async write(p: string, data: Uint8Array, mtimeMs: number): Promise<void> {
		this.check(p);
		await super.write(p, data, mtimeMs);
	}
	async mkdir(p: string): Promise<void> {
		this.check(p);
		await super.mkdir(p);
	}
}
