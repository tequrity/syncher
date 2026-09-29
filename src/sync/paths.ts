// Vault-relative path helpers (always '/'-separated, no leading slash).

export const META_DIR = '.syncher';
/** Metadata folder name used before the plugin was renamed from Obsyncher (migrated on connect). */
export const LEGACY_META_DIR = '.obsyncher';

export function parentOf(p: string): string {
	const i = p.lastIndexOf('/');
	return i < 0 ? '' : p.slice(0, i);
}

export function baseName(p: string): string {
	return p.slice(p.lastIndexOf('/') + 1);
}

export function isUnder(p: string, dir: string): boolean {
	return dir === '' || p === dir || p.startsWith(dir + '/');
}

export function rebase(p: string, from: string, to: string): string {
	return p === from ? to : to + p.slice(from.length);
}

export function depth(p: string): number {
	return p.split('/').length;
}

/** Hidden files/folders (any segment starting with '.') are never synced:
 * that covers the Obsidian config dir, the plugin's own state, `.syncher`, `.trash`, `.git`. */
export function isHidden(p: string): boolean {
	return p.split('/').some((s) => s.startsWith('.'));
}

function globToRegExp(glob: string): RegExp {
	glob = glob.replace(/\/\*\*$/, ''); // 'dir/**' also covers 'dir' itself
	let re = '';
	for (let i = 0; i < glob.length; i++) {
		const c = glob[i];
		if (c === '*') {
			if (glob[i + 1] === '*') {
				re += '.*';
				i++;
			} else re += '[^/]*';
		} else if (c === '?') re += '[^/]';
		else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
	}
	// like .gitignore: a pattern without '/' matches a name at any depth
	return new RegExp(`^${glob.includes('/') ? '' : '(.*/)?'}${re}(/.*)?$`);
}

export class PathFilter {
	private res: RegExp[];
	constructor(patterns: string[]) {
		this.res = patterns
			.map((p) => p.trim().replace(/^\/+|\/+$/g, ''))
			.filter((p) => p && !p.startsWith('#'))
			.map(globToRegExp);
	}
	excluded(p: string): boolean {
		if (!p || isHidden(p)) return true;
		return this.res.some((r) => r.test(p));
	}
}

/** `dir/note.md` -> `dir/note-1.old.md` (first free N). Folders get `-N.old` appended. */
export function oldName(p: string, n: number, isFolder: boolean): string {
	const dir = parentOf(p);
	const base = baseName(p);
	const dot = base.lastIndexOf('.');
	const name =
		isFolder || dot <= 0 ? `${base}-${n}.old` : `${base.slice(0, dot)}-${n}.old${base.slice(dot)}`;
	return dir ? `${dir}/${name}` : name;
}
