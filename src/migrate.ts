// One-time migration from the plugin's former name "Obsyncher" (plugin id `obsyncher`), renamed
// because the Obsidian directory does not allow names that contain parts of "Obsidian".
// On the first start of Syncher in a vault that still has the old plugin, its settings, sync base
// and config are copied over and the old plugin is disabled, so two sync engines never run at once.
// Device id and the secret master key are migrated where they are read (main.ts, secrets.ts); the
// server's metadata folder is migrated in RemoteStore.open().

import { App, normalizePath } from 'obsidian';

export const LEGACY_ID = 'obsyncher';

/** Files copied from the old plugin folder (the settings file is loaded through the Plugin API). */
const COPIED_FILES = ['state.json', 'sync_ignore.json'];

interface PluginsApi {
	enabledPlugins?: Set<string>;
	disablePluginAndSave?: (id: string) => Promise<void>;
}

/** The folder of an installed plugin with the old id (its folder name may differ from the id). */
async function findLegacyFolder(app: App): Promise<string | undefined> {
	const adapter = app.vault.adapter;
	const root = normalizePath(`${app.vault.configDir}/plugins`);
	if (!(await adapter.exists(root))) return undefined;
	for (const dir of (await adapter.list(root)).folders) {
		try {
			const manifest = JSON.parse(await adapter.read(`${dir}/manifest.json`)) as { id?: unknown };
			if (manifest.id === LEGACY_ID) return dir;
		} catch {
			/* not a plugin folder */
		}
	}
	return undefined;
}

/**
 * Copies the old plugin's data into `ownDir` when this plugin has no settings yet.
 * Returns the old settings object (to be saved by the caller) or undefined when nothing was migrated.
 */
export async function migrateLegacyPlugin(app: App, ownDir: string, configFile: string): Promise<Record<string, unknown> | undefined> {
	const legacy = await findLegacyFolder(app);
	if (!legacy) return undefined;
	const adapter = app.vault.adapter;
	let settings: Record<string, unknown> | undefined;
	try {
		settings = JSON.parse(await adapter.read(`${legacy}/data.json`)) as Record<string, unknown>;
	} catch {
		settings = undefined;
	}
	for (const name of COPIED_FILES) {
		const from = `${legacy}/${name}`;
		const to = normalizePath(`${ownDir}/${name}`);
		if ((await adapter.exists(from)) && !(await adapter.exists(to))) await adapter.write(to, await adapter.read(from));
	}
	const oldConfig = `${legacy}/${LEGACY_ID}.config.json`;
	const newConfig = normalizePath(`${ownDir}/${configFile}`);
	if ((await adapter.exists(oldConfig)) && !(await adapter.exists(newConfig))) await adapter.write(newConfig, await adapter.read(oldConfig));
	const plugins = (app as unknown as { plugins?: PluginsApi }).plugins;
	if (plugins?.enabledPlugins?.has(LEGACY_ID)) await plugins.disablePluginAndSave?.(LEGACY_ID);
	return settings;
}
