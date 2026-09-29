// Byte-stream transports for the SSH client.
// Desktop (Electron/Node) uses a raw TCP socket; Obsidian mobile has no TCP API,
// so it tunnels the very same SSH byte stream through a WebSocket relay
// (e.g. websockify on the server). SSH stays end-to-end encrypted either way.

export interface Duplex {
	write(data: Uint8Array): void;
	close(): void;
	onData: (data: Uint8Array) => void;
	onClose: (err?: Error) => void;
}

/** Node's `net` module; the caller provides it (desktop only), so this file needs no Node import. */
export type NetModule = typeof import('net');

export function connectTcp(net: NetModule, host: string, port: number, timeoutMs: number): Promise<Duplex> {
	return new Promise((resolve, reject) => {
		const sock = net.createConnection({ host, port });
		let settled = false;
		const duplex: Duplex = {
			write: (d) => {
				sock.write(d);
			},
			close: () => sock.destroy(),
			onData: () => undefined,
			onClose: () => undefined,
		};
		const timer = window.setTimeout(() => {
			if (settled) return;
			settled = true;
			sock.destroy();
			reject(new Error(`TCP connect timeout to ${host}:${port}`));
		}, timeoutMs);
		sock.setNoDelay(true);
		sock.setKeepAlive(true, 15000);
		sock.once('connect', () => {
			if (settled) return;
			settled = true;
			window.clearTimeout(timer);
			resolve(duplex);
		});
		sock.on('data', (d: Uint8Array) => duplex.onData(new Uint8Array(d.buffer, d.byteOffset, d.byteLength)));
		sock.on('error', (e: Error) => {
			if (!settled) {
				settled = true;
				window.clearTimeout(timer);
				reject(e);
				return;
			}
			duplex.onClose(e);
		});
		sock.on('close', () => {
			if (settled) duplex.onClose();
		});
	});
}

export function connectWebSocket(url: string, timeoutMs: number): Promise<Duplex> {
	return new Promise((resolve, reject) => {
		let ws: WebSocket;
		try {
			ws = new WebSocket(url, ['binary']);
		} catch (e) {
			reject(e instanceof Error ? e : new Error(String(e)));
			return;
		}
		ws.binaryType = 'arraybuffer';
		let settled = false;
		let closed = false;
		const duplex: Duplex = {
			write: (d) => {
				if (ws.readyState === WebSocket.OPEN) ws.send(d as Uint8Array<ArrayBuffer>);
			},
			close: () => {
				try {
					ws.close();
				} catch {
					/* ignore */
				}
			},
			onData: () => undefined,
			onClose: () => undefined,
		};
		const timer = window.setTimeout(() => {
			if (settled) return;
			settled = true;
			duplex.close();
			reject(new Error(`WebSocket connect timeout: ${url}`));
		}, timeoutMs);
		ws.onopen = () => {
			if (settled) return;
			settled = true;
			window.clearTimeout(timer);
			resolve(duplex);
		};
		ws.onmessage = (ev) => {
			if (ev.data instanceof ArrayBuffer) duplex.onData(new Uint8Array(ev.data));
			else if (typeof ev.data === 'string') {
				// base64 mode of old websockify versions
				const bin = atob(ev.data);
				const out = new Uint8Array(bin.length);
				for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
				duplex.onData(out);
			}
		};
		ws.onerror = () => {
			if (!settled) {
				settled = true;
				window.clearTimeout(timer);
				reject(new Error(`WebSocket error: ${url}`));
			}
		};
		ws.onclose = (ev) => {
			if (!settled) {
				settled = true;
				window.clearTimeout(timer);
				reject(new Error(`WebSocket closed (${ev.code}) ${url}`));
				return;
			}
			if (closed) return;
			closed = true;
			duplex.onClose(ev.code === 1000 ? undefined : new Error(`WebSocket closed (${ev.code})`));
		};
	});
}
