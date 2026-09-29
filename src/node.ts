// Node.js built-ins, reachable only in the desktop app (Electron). Obsidian mobile has no Node
// APIs at all, so every access goes through this one guarded place and yields `undefined` there.

import { Platform } from 'obsidian';

declare const require: (id: string) => unknown;

export interface NodeApis {
	fs: typeof import('fs');
	path: typeof import('path');
	os: typeof import('os');
	net: typeof import('net');
}

let cached: NodeApis | null | undefined;

/** Node APIs on desktop; `undefined` on mobile (including Obsidian's mobile emulation). */
export function nodeApis(): NodeApis | undefined {
	if (cached !== undefined) return cached ?? undefined;
	cached = null;
	if (Platform.isDesktop && !Platform.isMobile) {
		try {
			cached = {
				fs: require('fs') as NodeApis['fs'],
				path: require('path') as NodeApis['path'],
				os: require('os') as NodeApis['os'],
				net: require('net') as NodeApis['net'],
			};
		} catch {
			cached = null;
		}
	}
	return cached ?? undefined;
}
