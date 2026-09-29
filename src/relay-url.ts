// Obsidian mobile has no TCP API, so there the SSH byte stream goes through a WebSocket
// relay running next to sshd (server/install-relay.sh, port 8022 by default).

export const DEFAULT_RELAY_PORT = 8022;

/** Relay address used when none is configured: same host as SSH, default relay port. */
export function defaultRelayUrl(host: string): string {
	host = host.trim();
	if (!host) return '';
	const h = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host; // IPv6 literal
	return `ws://${h}:${DEFAULT_RELAY_PORT}`;
}
