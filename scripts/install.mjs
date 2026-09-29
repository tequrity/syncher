#!/usr/bin/env node
// Installs the built plugin into a vault:  node scripts/install.mjs "<path to vault>"
// Copies dist/syncher/{main.js,manifest.json,styles.css} to <vault>/.obsidian/plugins/syncher/.
// Existing data.json, syncher.config.json, state.json, sync_ignore.json and keys/ are kept.
import { copyFileSync, existsSync, mkdirSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

const vault = process.argv[2];
if (!vault) {
	console.error('usage: node scripts/install.mjs "<path to vault>"');
	process.exit(1);
}
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'dist', 'syncher');
if (!existsSync(join(resolve(vault), '.obsidian'))) {
	console.error(`not an Obsidian vault (no .obsidian folder): ${resolve(vault)}`);
	process.exit(1);
}
const dst = join(resolve(vault), '.obsidian', 'plugins', 'syncher');
mkdirSync(dst, { recursive: true });
for (const f of ['main.js', 'manifest.json', 'styles.css']) copyFileSync(join(src, f), join(dst, f));
console.log(`Syncher installed to ${dst}\nRestart Obsidian (or reload plugins) and enable it in Settings → Community plugins.`);
