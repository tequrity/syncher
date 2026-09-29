// Plugin config file (`<plugin folder>/syncher.config.json`): per-device default values for the
// connection fields, handy for preparing a device without typing. Values entered in the settings
// window always win. The SSH key is not part of it: keys are imported in the settings (stored
// encrypted), so the plugin never reads files outside the vault.

import { App, normalizePath } from 'obsidian';

export const CONFIG_FILE = 'syncher.config.json';

export interface FileConfig {
	remoteDir: string;
	host: string;
	port: number;
	username: string;
	relayUrl: string;
}

export function defaultFileConfig(): FileConfig {
	return { remoteDir: '', host: '', port: 22, username: '', relayUrl: '' };
}

/** Keeps only the known fields (older config files also had keysDir/keyFile). */
function pick(raw: Partial<Record<keyof FileConfig, unknown>>): Partial<FileConfig> {
	const out: Partial<FileConfig> = {};
	if (typeof raw.remoteDir === 'string') out.remoteDir = raw.remoteDir;
	if (typeof raw.host === 'string') out.host = raw.host;
	if (typeof raw.port === 'number') out.port = raw.port;
	if (typeof raw.username === 'string') out.username = raw.username;
	if (typeof raw.relayUrl === 'string') out.relayUrl = raw.relayUrl;
	return out;
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
				const raw = JSON.parse(await adapter.read(this.path)) as Partial<Record<keyof FileConfig, unknown>>;
				this.cfg = { ...def, ...pick(raw) };
			} else {
				this.cfg = def;
				await adapter.write(this.path, JSON.stringify(def, null, '\t') + '\n');
			}
		} catch (e) {
			console.error('Syncher: bad config file', e);
			this.cfg = def;
		}
		return this.cfg;
	}
}
