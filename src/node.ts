// Node.js networking, reachable only in the desktop app (Electron). Obsidian mobile has no Node
// APIs at all, so the one Node module the plugin needs (`net`, for a direct SSH connection) is
// loaded here behind a platform guard and is `undefined` on phones, which use the relay instead.

import { Platform } from 'obsidian';

declare const require: (id: string) => unknown;

export type NetModule = typeof import('net');

let cached: NetModule | null | undefined;

/** Node's `net` module on desktop; `undefined` on mobile (including Obsidian's mobile emulation). */
export function nodeNet(): NetModule | undefined {
	if (cached !== undefined) return cached ?? undefined;
	cached = null;
	if (Platform.isDesktop && !Platform.isMobile) {
		try {
			cached = require('net') as NetModule;
		} catch {
			cached = null;
		}
	}
	return cached ?? undefined;
}
