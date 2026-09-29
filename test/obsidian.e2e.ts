// End-to-end test inside real Obsidian desktop.
//
// Launches Obsidian with an isolated, throw-away profile (--user-data-dir), a temp
// vault with the freshly built plugin, drives it through the Chrome DevTools
// protocol and syncs against a simulated second device via the test sshd.
//
//   npm run build && node esbuild.config.mjs test && \
//   SYNCHER_OBSIDIAN="<path to Obsidian executable>" node --test test-dist/obsidian.e2e.cjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, ChildProcess } from 'child_process';
import { promises as fs } from 'fs';
import { join, resolve } from 'path';
import { Sftp } from '../src/ssh/sftp';
import { RemoteStore } from '../src/sync/remote';
import { SyncEngine } from '../src/sync/engine';
import { TEST_HOST, TEST_PORT, TEST_USER, connect, serverAvailable, keyText } from './helpers';
import { MemoryPersistence, NodeFs } from './nodefs';

const OBSIDIAN = process.env.SYNCHER_OBSIDIAN;
const ROOT = resolve('.test-tmp/e2e');
const PORT = 9333;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class Cdp {
	private id = 0;
	private waiters = new Map<number, (v: any) => void>();
	constructor(private ws: WebSocket) {
		ws.onmessage = (ev) => {
			const m = JSON.parse(String(ev.data));
			if (m.id && this.waiters.has(m.id)) {
				this.waiters.get(m.id)!(m);
				this.waiters.delete(m.id);
			}
		};
	}
	static async attach(): Promise<Cdp> {
		for (let i = 0; i < 60; i++) {
			try {
				const list = (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()) as any[];
				const page = list.find((p) => p.type === 'page' && !String(p.url).startsWith('devtools'));
				if (page) {
					const ws = new WebSocket(page.webSocketDebuggerUrl);
					await new Promise((r, j) => ((ws.onopen = r), (ws.onerror = j)));
					return new Cdp(ws);
				}
			} catch {
				/* not up yet */
			}
			await sleep(500);
		}
		throw new Error('Obsidian DevTools endpoint did not come up');
	}
	async eval<T = unknown>(expr: string): Promise<T> {
		const id = ++this.id;
		const p = new Promise<any>((r) => this.waiters.set(id, r));
		this.ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression: `(async () => { ${expr} })()`, awaitPromise: true, returnByValue: true } }));
		const m = await p;
		if (m.result?.exceptionDetails) throw new Error(JSON.stringify(m.result.exceptionDetails));
		return m.result?.result?.value as T;
	}
	async until<T>(expr: string, what: string, timeoutMs = 20000): Promise<T> {
		const end = Date.now() + timeoutMs;
		for (;;) {
			const v = await this.eval<T>(expr);
			if (v) return v;
			if (Date.now() > end) throw new Error(`timeout waiting for ${what}`);
			await sleep(300);
		}
	}
	close(): void {
		this.ws.close();
	}
}

test('plugin syncs inside real Obsidian', async (t) => {
	if (!OBSIDIAN) return t.skip('set SYNCHER_OBSIDIAN to the Obsidian executable');
	if (!(await serverAvailable())) return t.skip('test sshd not reachable');

	const c0 = await connect();
	const s0 = await Sftp.open(c0);
	const remoteDir = `${await s0.realpath('.')}/.syncher-test/vault-e2e`;
	await s0.rmrf(remoteDir);
	c0.close();

	// temp vault with the built plugin
	await fs.rm(ROOT, { recursive: true, force: true });
	const vault = join(ROOT, 'vault');
	const pluginDir = join(vault, '.obsidian', 'plugins', 'syncher');
	await fs.mkdir(pluginDir, { recursive: true });
	for (const f of ['main.js', 'manifest.json', 'styles.css']) await fs.copyFile(f, join(pluginDir, f));
	await fs.writeFile(join(pluginDir, 'syncher.config.json'), JSON.stringify({ host: TEST_HOST, port: TEST_PORT, username: TEST_USER }));
	await fs.writeFile(
		join(pluginDir, 'data.json'),
		JSON.stringify({ remoteDir, deviceName: 'E2E-Obsidian', pollSeconds: 1, debounceMs: 300 }),
	);
	await fs.writeFile(join(vault, '.obsidian', 'community-plugins.json'), JSON.stringify(['syncher']));
	await fs.writeFile(join(vault, 'Welcome.md'), 'local note');
	const userData = join(ROOT, 'userdata');
	await fs.mkdir(userData, { recursive: true });
	await fs.writeFile(
		join(userData, 'obsidian.json'),
		JSON.stringify({ vaults: { e2etestvault0001: { path: vault, ts: Date.now(), open: true } } }),
	);

	const proc: ChildProcess = spawn(OBSIDIAN, [`--user-data-dir=${userData}`, `--remote-debugging-port=${PORT}`], {
		stdio: 'ignore',
		detached: false,
	});
	const cdp = await Cdp.attach();
	// second device, simulated in Node
	const devFs = new NodeFs(join(ROOT, 'deviceB'));
	await fs.mkdir(devFs.root, { recursive: true });
	const b = new SyncEngine(devFs, new MemoryPersistence(), {
		deviceId: 'id-b',
		deviceName: 'Laptop-B',
		permanentSave: false,
		exclude: [],
		presenceWindowSec: 60,
	});
	await b.init();
	const cb = await connect();
	try {
		await cdp.until('return !!window.app?.workspace?.layoutReady', 'workspace', 60000);
		// leave restricted mode and enable the plugin (what the user does once by hand)
		await cdp.eval(`app.plugins.setEnable(true); await app.plugins.loadManifests(); await app.plugins.enablePluginAndSave('syncher'); return true;`);
		// import the SSH key the way a user does (sealed on this device), then connect
		await cdp.eval(`const p = app.plugins.plugins.syncher; p.settings.keyDataEnc = p.secrets.seal('keyDataEnc', ${JSON.stringify(keyText('id_ed25519'))}); await p.saveSettings(); await p.reconnect(); return true;`);
		await cdp.until(`return app.plugins.plugins.syncher?.engine?.connected`, 'plugin connected', 30000);

		// Obsidian -> server -> device B
		await b.attach(await RemoteStore.open(await Sftp.open(cb), remoteDir, 'id-b'));
		assert.equal(await fs.readFile(join(devFs.root, 'Welcome.md'), 'utf8'), 'local note');
		await cdp.eval(`await app.vault.create('Typed in Obsidian.md', 'hello from obsidian'); return true;`);
		for (let i = 0; i < 40; i++) {
			b.poll();
			await b.whenIdle();
			if (await devFs.stat('Typed in Obsidian.md')) break;
			await sleep(250);
		}
		assert.equal(await fs.readFile(join(devFs.root, 'Typed in Obsidian.md'), 'utf8'), 'hello from obsidian');

		// device B -> server -> Obsidian (live)
		await devFs.write('From B/note.md', new TextEncoder().encode('written on B'), Date.now());
		b.localChanged('From B/note.md');
		await b.whenIdle();
		const got = await cdp.until<string>(
			`const f = app.vault.getAbstractFileByPath('From B/note.md'); return f ? await app.vault.read(f) : '';`,
			'file from B',
		);
		assert.equal(got, 'written on B');

		// rename in Obsidian propagates as a rename
		await cdp.eval(`await app.vault.rename(app.vault.getAbstractFileByPath('Typed in Obsidian.md'), 'Renamed.md'); return true;`);
		for (let i = 0; i < 40 && !(await devFs.stat('Renamed.md')); i++) {
			b.poll();
			await b.whenIdle();
			await sleep(250);
		}
		assert.equal(await fs.readFile(join(devFs.root, 'Renamed.md'), 'utf8'), 'hello from obsidian');
		assert.equal(await devFs.stat('Typed in Obsidian.md'), null);

		// device B deletes while both are online -> pop-up in Obsidian
		if (process.env.SYNCHER_TEST_VERBOSE)
			await cdp.eval(`const cb = app.plugins.plugins.syncher.engine.cb; const orig = cb.onRemoteDelete; window.__obs = [];
				cb.log = (m) => window.__obs.push(m); cb.onRemoteDelete = (...a) => { window.__obs.push('NOTIFY ' + a.join(',')); try { orig(...a); window.__obs.push('orig ok') } catch (e) { window.__obs.push('ERR ' + e.stack) } }; return 1;`);
		await fs.rm(join(devFs.root, 'Welcome.md'));
		b.localDeleted('Welcome.md', false);
		await b.whenIdle();
		await cdp.until(`return !app.vault.getAbstractFileByPath('Welcome.md')`, 'Welcome.md deleted');
		if (process.env.SYNCHER_TEST_VERBOSE)
			console.log(
				await cdp.eval(
					`const e = app.plugins.plugins.syncher.engine; return JSON.stringify({aw: activeWindow === window, notices: [...activeWindow.document.querySelectorAll('.notice-container, .notice')].map(n => n.className + ':' + n.textContent), log: window.__obs, devs: e.devices, online: e.devices.map(d => e.isOnline(d)), now: e.remote?.serverNow(), notify: app.plugins.plugins.syncher.settings.notifyDeletes})`,
				),
			);
		const notices = await cdp.until<string>(
			`const s = [...activeWindow.document.querySelectorAll('.notice')].map(n => n.textContent).join(' | '); return s.includes('Laptop-B') ? s : ''`,
			'deletion notice',
		);
		assert.match(notices, /Laptop-B/);
		assert.match(notices, /Welcome\.md/);

		// state (hash file) is written locally and never uploaded
		await cdp.until(`return await app.vault.adapter.exists('.obsidian/plugins/syncher/state.json')`, 'state.json');
		assert.equal(await devFs.stat('.obsidian'), null);
	} finally {
		cb.close();
		cdp.close();
		proc.kill();
	}
});
