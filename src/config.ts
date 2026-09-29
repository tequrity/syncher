// Plugin config file (`<plugin dir>/obsyncher.config.json`) and SSH key loading.
// The config file holds per-device defaults, first of all the keys directory.
// Nothing here is hard-coded to a machine: `~` is the user's home, relative
// paths are relative to the plugin folder (works on Android too).

import { App, normalizePath } from 'obsidian';
import { NodeApis, nodeApis } from './node';

export const CONFIG_FILE = 'obsyncher.config.json';

export interface FileConfig {
	/** Directory with SSH keys. `~/.ssh`, an absolute path, or relative to the plugin folder (e.g. `keys`). */
	keysDir: string;
	remoteDir: string;
	host: string;
	port: number;
	username: string;
	keyFile: string;
	relayUrl: string;
}

/** Node APIs available (Electron desktop, and not the mobile emulation mode). */
export function onDesktop(): boolean {
	return nodeApis() !== undefined;
}

export function defaultFileConfig(): FileConfig {
	return {
		keysDir: onDesktop() ? '~/.ssh' : 'keys',
		remoteDir: '',
		host: '',
		port: 22,
		username: '',
		keyFile: '',
		relayUrl: '',
	};
}

function nodeFs(): NodeApis['fs'] | undefined {
	return nodeApis()?.fs;
}

/** Only called on desktop (after an `onDesktop()` check). */
function nodePath(): NodeApis['path'] {
	const api = nodeApis();
	if (!api) throw new Error('Node APIs are not available on this platform');
	return api.path;
}

function homeDir(): string {
	return nodeApis()?.os.homedir() ?? '';
}

function isAbsolute(p: string): boolean {
	return p.startsWith('/') || p.startsWith('~') || /^[A-Za-z]:[\\/]/.test(p) || p.startsWith('\\\\');
}

export class ConfigManager {
	cfg: FileConfig = defaultFileConfig();

	constructor(
		private app: App,
		private pluginDir: string,
	) {}

	get path(): string {
		return normalizePath(`${this.pluginDir}/${CONFIG_FILE}`);
	}

	async load(): Promise<FileConfig> {
		const adapter = this.app.vault.adapter;
		const def = defaultFileConfig();
		try {
			if (await adapter.exists(this.path)) {
				const raw = JSON.parse(await adapter.read(this.path)) as Partial<FileConfig>;
				this.cfg = { ...def, ...raw };
			} else {
				this.cfg = def;
				await adapter.write(this.path, JSON.stringify(def, null, '\t') + '\n');
			}
		} catch (e) {
			console.error('Obsyncher: bad config file', e);
			this.cfg = def;
		}
		return this.cfg;
	}

	/** Absolute OS path of the plugin folder (desktop only). */
	private pluginAbs(): string | undefined {
		if (!onDesktop()) return undefined;
		const base = (this.app.vault.adapter as unknown as { getBasePath?: () => string }).getBasePath?.();
		return base ? nodePath().join(base, this.pluginDir) : undefined;
	}

	/** Where a path from the config/settings points to. */
	resolve(p: string): { os?: string; vault?: string } {
		if (p.startsWith('~') && onDesktop()) return { os: nodePath().join(homeDir(), p.slice(1)) };
		if (isAbsolute(p)) return onDesktop() ? { os: p } : { vault: undefined };
		const rel = normalizePath(`${this.pluginDir}/${p}`);
		const abs = this.pluginAbs();
		return abs && onDesktop() ? { os: nodePath().join(abs, p), vault: rel } : { vault: rel };
	}

	keysDirLabel(): string {
		return this.cfg.keysDir || defaultFileConfig().keysDir;
	}

	/** `keyFile` may be a bare file name (inside keysDir) or a full path. */
	keyLocation(keyFile: string): { os?: string; vault?: string } {
		if (isAbsolute(keyFile)) return this.resolve(keyFile);
		const dir = this.keysDirLabel().replace(/[\\/]+$/, '');
		return this.resolve(`${dir}/${keyFile}`);
	}

	/** Vault-relative form of an absolute path that points inside the vault (any platform), else undefined. */
	private insideVault(p: string): string | undefined {
		const a = this.app.vault.adapter as unknown as { getBasePath?: () => string; basePath?: string };
		let base = a.getBasePath?.() ?? a.basePath ?? '';
		base = base.replace(/^file:\/\//, '').replace(/\\/g, '/').replace(/\/+$/, '');
		const q = p.replace(/^file:\/\//, '').replace(/\\/g, '/');
		if (!base || !q.toLowerCase().startsWith(base.toLowerCase() + '/')) return undefined;
		return normalizePath(q.slice(base.length + 1));
	}

	/**
	 * Candidate locations, in order: the configured meaning of `keyFile` (keys dir / OS path),
	 * then — for phones, where plugins cannot read the OS file system — the same path inside the vault.
	 */
	private keyCandidates(keyFile: string): { os?: string; vault?: string }[] {
		const out = [this.keyLocation(keyFile)];
		const inVault = isAbsolute(keyFile) ? this.insideVault(keyFile) : normalizePath(keyFile);
		if (inVault) out.push({ vault: inVault });
		return out;
	}

	async readKey(keyFile: string): Promise<string> {
		const fs = nodeFs();
		const candidates = this.keyCandidates(keyFile.trim());
		for (const loc of candidates) {
			if (loc.os && fs && fs.existsSync(loc.os)) return fs.readFileSync(loc.os, 'utf8');
			if (loc.vault && (await this.app.vault.adapter.exists(loc.vault))) return this.app.vault.adapter.read(loc.vault);
		}
		const first = candidates[0];
		throw new KeyNotFoundError(first.os ?? first.vault ?? keyFile);
	}

	/** Private-key-looking files in the keys directory. */
	async listKeys(): Promise<string[]> {
		const loc = this.resolve(this.keysDirLabel());
		let names: string[] = [];
		const fs = nodeFs();
		try {
			if (loc.os && fs && fs.existsSync(loc.os)) names = fs.readdirSync(loc.os);
			else if (loc.vault && (await this.app.vault.adapter.exists(loc.vault)))
				names = (await this.app.vault.adapter.list(loc.vault)).files.map((f) => f.split('/').pop()!);
		} catch {
			names = [];
		}
		const skip = /(\.pub|\.ppk|known_hosts.*|authorized_keys.*|config|environment|\.old|\.bak)$/i;
		return names.filter((n) => !skip.test(n) && !n.startsWith('.')).sort();
	}
}

export class KeyNotFoundError extends Error {
	constructor(readonly path: string) {
		super(`Key file not found: ${path}`);
		this.name = 'KeyNotFoundError';
	}
}
