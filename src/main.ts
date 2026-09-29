import { App, Modal, Notice, Platform, Plugin, Setting, TAbstractFile, TFile, TFolder, requireApiVersion } from 'obsidian';
import { ConfigManager, KeyNotFoundError } from './config';
import { t } from './i18n';
import { defaultRelayUrl } from './relay-url';
import { ObsidianFs, PluginPersistence } from './obsidian-fs';
import { SecretBox } from './secrets';
import { DEFAULT_SETTINGS, ObsyncherSettingTab, ObsyncherSettings } from './settings';
import { HostKeyInfo, HostKeyMismatchError, SshAuthError, SshClient } from './ssh/client';
import { KeyPassphraseError, PrivateKey, parsePrivateKey } from './ssh/keys';
import { Sftp } from './ssh/sftp';
import { Duplex, connectTcp, connectWebSocket } from './ssh/socket';
import { nodeApis } from './node';
import { SyncEngine } from './sync/engine';
import { RemoteStore } from './sync/remote';
import { DeviceInfo, SyncStatus } from './sync/types';

/** Errors that retrying cannot fix: wait for the user to change settings. */
class FatalConnectError extends Error {}

export default class ObsyncherPlugin extends Plugin {
	settings: ObsyncherSettings = { ...DEFAULT_SETTINGS };
	config!: ConfigManager;
	secrets!: SecretBox;
	engine?: SyncEngine;
	private client?: SshClient;
	private deviceId = '';
	private status: SyncStatus = 'offline';
	private statusDetail = '';
	private statusEl?: HTMLElement;
	private ribbonEl?: HTMLElement;
	/** Bumped by every disconnect: a connect attempt from an older generation gives up silently. */
	private gen = 0;
	/** Generation of the connect attempt in flight, -1 when none. */
	private connectingGen = -1;
	private stopped = false;
	private reconnectTimer?: number;
	private backoff = 0;
	private pollTimer?: number;
	private fullTimer?: number;
	private debounce = new Map<string, number>();
	private lastConnectError = '';

	async onload(): Promise<void> {
		await this.loadSettings();
		this.secrets = new SecretBox(this.app);
		this.config = new ConfigManager(this.app, this.manifest.dir ?? `${this.app.vault.configDir}/plugins/${this.manifest.id}`);
		await this.config.load();
		this.deviceId = this.ensureDeviceId();

		this.engine = new SyncEngine(
			new ObsidianFs(this.app),
			new PluginPersistence(this.app, this.config.path.replace(/\/[^/]+$/, '')),
			{
				deviceId: this.deviceId,
				deviceName: this.deviceName(),
				permanentSave: this.settings.permanentSave,
				exclude: this.excludePatterns(),
				presenceWindowSec: 45,
				version: this.manifest.version,
			},
			{
				onRemoteDelete: (device, file, kept) => {
					if (this.settings.notifyDeletes) new Notice(t(kept ? 'deletedByKept' : 'deletedBy', { device, file }), 8000);
				},
				onProblems: (problems) => {
					const shown = problems.slice(0, 5).map((p) => `• ${p.path || '/'}: ${p.message}`);
					if (problems.length > shown.length) shown.push('…');
					const lines = [t('problems', { n: problems.length }), ...shown].join('\n');
					new Notice(createFragment((el) => el.createDiv({ cls: 'obsyncher-notice-lines', text: lines })), 15000);
				},
				onStatus: (s, detail) => this.setStatus(s, detail),
				log: (m) => console.debug(`Obsyncher: ${m}`),
				confirmMassDelete: (side, count, total) => confirmModal(this.app, side, count, total),
			},
		);
		await this.engine.init();
		this.engine.onDisconnect = () => this.scheduleReconnect();

		this.addSettingTab(new ObsyncherSettingTab(this.app, this));
		if (!Platform.isMobile) {
			this.statusEl = this.addStatusBarItem();
			this.statusEl.addClass('obsyncher-status');
			this.statusEl.onClickEvent(() => this.syncNow());
		}
		this.ribbonEl = this.addRibbonIcon('refresh-cw', 'Obsyncher', () => this.syncNow());
		this.addCommand({ id: 'sync-now', name: t('cmdSyncNow'), callback: () => this.syncNow() });
		this.addCommand({ id: 'reconnect', name: t('cmdReconnect'), callback: () => void this.reconnect() });
		this.addCommand({
			id: 'toggle',
			name: t('cmdToggle'),
			callback: async () => {
				this.settings.autoSync = !this.settings.autoSync;
				await this.saveSettings();
				if (this.settings.autoSync) void this.connect();
				else this.disconnect();
			},
		});
		this.setStatus('offline');

		this.app.workspace.onLayoutReady(() => {
			this.registerVaultEvents();
			if (this.settings.autoSync) void this.connect();
		});
		// Mobile suspends sockets in background: reconnect as soon as we're visible / online again.
		this.registerDomEvent(document, 'visibilitychange', () => {
			if (document.visibilityState === 'visible') this.kick();
		});
		this.registerDomEvent(window, 'online', () => this.kick());
		this.restartTimers();
	}

	onunload(): void {
		this.stopped = true;
		for (const h of this.debounce.values()) window.clearTimeout(h);
		this.disconnect();
		void this.engine?.flush();
	}

	// ---------------------------------------------------------------- settings

	async loadSettings(): Promise<void> {
		const stored = (await this.loadData()) as Partial<ObsyncherSettings> | null;
		this.settings = { ...DEFAULT_SETTINGS, ...(stored ?? {}) };
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	private ensureDeviceId(): string {
		let id = this.app.loadLocalStorage('obsyncher-device-id') as string | null;
		if (!id || !/^[a-z0-9-]{8,}$/.test(id)) {
			const b = crypto.getRandomValues(new Uint8Array(8));
			id = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
			this.app.saveLocalStorage('obsyncher-device-id', id);
		}
		return id;
	}

	defaultDeviceName(): string {
		const host = nodeApis()?.os.hostname();
		if (host) return host;
		const kind = Platform.isAndroidApp ? 'Android' : Platform.isIosApp ? 'iOS' : 'Device';
		return `${kind}-${this.deviceId.slice(0, 4)}`;
	}

	deviceName(): string {
		return this.settings.deviceName || this.defaultDeviceName();
	}

	excludePatterns(): string[] {
		return this.settings.exclude.split(/\r?\n/).filter((l) => l.trim());
	}

	private effective() {
		const s = this.settings;
		const c = this.config.cfg;
		return {
			remoteDir: s.remoteDir || c.remoteDir,
			host: s.host || c.host,
			port: s.port || c.port || 22,
			username: s.username || c.username,
			keyFile: s.keyFile || c.keyFile,
			relayUrl: s.relayUrl || c.relayUrl || defaultRelayUrl(s.host || c.host),
		};
	}

	isDeviceOnline(d: DeviceInfo): boolean {
		return this.engine?.isOnline(d) ?? false;
	}

	// ---------------------------------------------------------------- status

	private setStatus(s: SyncStatus, detail = ''): void {
		this.status = s;
		this.statusDetail = detail;
		const text = this.statusText();
		if (this.statusEl) {
			this.statusEl.setText(text);
			this.statusEl.setAttr('title', `${detail || text} · v${this.manifest.version}`);
		}
		this.ribbonEl?.setAttr('aria-label', `${text} · v${this.manifest.version}`);
	}

	statusText(): string {
		if (!this.settings.autoSync && !this.engine?.connected) return t('statusDisabled');
		switch (this.status) {
			case 'idle':
				return t('statusIdle');
			case 'syncing':
				return t('statusSyncing');
			case 'connecting':
				return t('statusConnecting');
			case 'error':
				return `${t('statusError')}${this.statusDetail ? `: ${this.statusDetail}` : ''}`;
			default:
				return t('statusOffline');
		}
	}

	restartTimers(): void {
		if (this.pollTimer) window.clearInterval(this.pollTimer);
		if (this.fullTimer) window.clearInterval(this.fullTimer);
		this.pollTimer = window.setInterval(() => {
			if (this.engine?.connected) this.engine.poll();
		}, Math.max(1, this.settings.pollSeconds) * 1000);
		this.registerInterval(this.pollTimer);
		if (this.settings.fullSyncMinutes > 0) {
			this.fullTimer = window.setInterval(() => {
				if (this.engine?.connected) this.engine.requestFullSync();
			}, this.settings.fullSyncMinutes * 60000);
			this.registerInterval(this.fullTimer);
		}
	}

	// ---------------------------------------------------------------- vault events

	private registerVaultEvents(): void {
		const vault = this.app.vault;
		const onFile = (f: TAbstractFile): void => {
			if (f instanceof TFolder) {
				this.engine?.localFolderChanged(f.path);
				return;
			}
			const prev = this.debounce.get(f.path);
			if (prev) window.clearTimeout(prev);
			this.debounce.set(
				f.path,
				window.setTimeout(() => {
					this.debounce.delete(f.path);
					this.engine?.localChanged(f.path);
				}, this.settings.debounceMs),
			);
		};
		this.registerEvent(vault.on('create', onFile));
		this.registerEvent(vault.on('modify', onFile));
		this.registerEvent(
			vault.on('delete', (f) => {
				const prev = this.debounce.get(f.path);
				if (prev) window.clearTimeout(prev);
				this.debounce.delete(f.path);
				this.engine?.localDeleted(f.path, f instanceof TFolder);
			}),
		);
		this.registerEvent(
			vault.on('rename', (f, oldPath) => {
				const prev = this.debounce.get(oldPath);
				if (prev) window.clearTimeout(prev);
				this.debounce.delete(oldPath);
				this.engine?.localRenamed(oldPath, f.path, f instanceof TFolder);
				if (f instanceof TFile && prev) onFile(f);
			}),
		);
	}

	// ---------------------------------------------------------------- connection

	syncNow(): void {
		if (this.engine?.connected) this.engine.requestFullSync();
		else if (this.connecting) new Notice(t('statusConnecting'));
		else void this.reconnect();
	}

	get connecting(): boolean {
		return this.connectingGen === this.gen;
	}

	private kick(): void {
		if (this.stopped || !this.settings.autoSync || this.engine?.connected || this.connecting) return;
		if (this.lastConnectError === 'fatal') return;
		void this.connect();
	}

	private scheduleReconnect(): void {
		const old = this.client;
		this.client = undefined;
		old?.close();
		if (this.stopped || !this.settings.autoSync || this.reconnectTimer) return;
		const delay = [2, 5, 10, 20, 40, 60][Math.min(this.backoff, 5)] * 1000;
		this.backoff++;
		this.reconnectTimer = window.setTimeout(() => {
			this.reconnectTimer = undefined;
			void this.connect();
		}, delay);
	}

	disconnect(): void {
		this.gen++;
		if (this.reconnectTimer) window.clearTimeout(this.reconnectTimer);
		this.reconnectTimer = undefined;
		const c = this.client;
		this.client = undefined;
		this.engine?.detach();
		c?.close();
		this.setStatus('offline');
	}

	async reconnect(): Promise<void> {
		this.lastConnectError = '';
		this.backoff = 0;
		this.disconnect();
		await this.connect(true);
	}

	/** Direct TCP where the platform has it (desktop); Obsidian mobile has no TCP API, only WebSocket. */
	usesRelay(): boolean {
		return !nodeApis() || this.settings.transport === 'websocket';
	}

	private async openSocket(e: ReturnType<ObsyncherPlugin['effective']>): Promise<Duplex> {
		if (this.usesRelay()) {
			if (!e.relayUrl) throw new FatalConnectError(t('noRelay'));
			try {
				return await connectWebSocket(e.relayUrl, 15000);
			} catch (err) {
				throw new Error(t('relayFailed', { url: e.relayUrl, msg: (err as Error).message }));
			}
		}
		const api = nodeApis();
		if (!api) throw new FatalConnectError(t('noRelay'));
		return connectTcp(api.net, e.host, e.port, 15000);
	}

	private async loadKey(keyFile: string): Promise<PrivateKey | undefined> {
		let text: string;
		if (this.settings.keyDataEnc) {
			const k = this.secrets.open('keyDataEnc', this.settings.keyDataEnc);
			if (k === null) throw new FatalConnectError(t('secretLost'));
			text = k;
		} else if (keyFile) text = await this.config.readKey(keyFile);
		else return undefined;
		const pass = this.secrets.open('keyPassEnc', this.settings.keyPassEnc);
		if (pass === null) throw new FatalConnectError(t('secretLost'));
		return parsePrivateKey(text, pass || undefined);
	}

	private verifyHostKey(info: HostKeyInfo, pin: boolean): boolean {
		const id = `${info.type} ${info.fingerprint}`;
		const pinned = this.settings.hostKey;
		if (!pinned) {
			if (pin) {
				this.settings.hostKey = id;
				void this.saveSettings();
				new Notice(t('newHostKey', { fp: id }), 10000);
			}
			return true;
		}
		return pinned.split(' ').pop() === info.fingerprint;
	}

	private async openClient(pin: boolean): Promise<{ client: SshClient; e: ReturnType<ObsyncherPlugin['effective']> }> {
		const e = this.effective();
		if (!e.host || !e.username || !e.remoteDir) throw new FatalConnectError(t('notConfigured'));
		const password = this.secrets.open('passwordEnc', this.settings.passwordEnc);
		if (password === null) throw new FatalConnectError(t('secretLost'));
		let privateKey: PrivateKey | undefined;
		try {
			privateKey = await this.loadKey(e.keyFile);
		} catch (err) {
			if (err instanceof KeyPassphraseError)
				throw new FatalConnectError(t(/required/.test(err.message) ? 'keyPassNeeded' : 'keyPassWrong'));
			if (err instanceof KeyNotFoundError)
				throw new FatalConnectError(t(Platform.isMobile ? 'keyNotFoundMobile' : 'keyNotFound', { path: err.path }));
			if (err instanceof FatalConnectError) throw err;
			throw new FatalConnectError(t('keyBad', { msg: (err as Error).message }));
		}
		const sock = await this.openSocket(e);
		try {
			const client = await SshClient.connect(sock, {
				username: e.username,
				password: password || undefined,
				privateKey,
				verifyHostKey: (info) => this.verifyHostKey(info, pin),
				keepaliveMs: 15000,
				timeoutMs: 20000,
			});
			return { client, e };
		} catch (err) {
			if (err instanceof HostKeyMismatchError)
				throw new FatalConnectError(t('hostKeyMismatch', { fp: `${err.info.type} ${err.info.fingerprint}` }));
			if (err instanceof SshAuthError) throw new FatalConnectError(t('authFailed', { msg: err.message }));
			throw err;
		}
	}

	async connect(manual = false): Promise<void> {
		if (this.stopped || this.engine?.connected || this.connecting) return;
		const gen = this.gen;
		this.connectingGen = gen;
		// disconnect()/reconnect() happened while we were waiting: this attempt is obsolete
		const stale = (): boolean => gen !== this.gen || this.stopped;
		this.setStatus('connecting');
		let client: SshClient | undefined;
		try {
			const opened = await this.openClient(true);
			client = opened.client;
			if (stale()) return;
			const own = client;
			client.onClose = (err) => {
				if (this.client !== own) return;
				this.client = undefined;
				this.engine?.detach();
				this.setStatus('offline', err?.message ?? '');
				this.scheduleReconnect();
			};
			this.client = client;
			const sftp = await Sftp.open(client);
			const store = await RemoteStore.open(sftp, opened.e.remoteDir, this.deviceId);
			if (stale()) return;
			this.backoff = 0;
			if (manual || this.lastConnectError) new Notice(t('connected', { host: opened.e.host }));
			this.lastConnectError = '';
			// Resolves once the initial full sync is done. Problems with single files are reported
			// by the engine and do NOT drop the connection; only a lost connection throws here.
			await this.engine!.attach(store);
		} catch (err) {
			if (stale()) return;
			const msg = (err as Error).message;
			console.error('Obsyncher: connect failed', err);
			if (this.client === client) this.client = undefined;
			client?.close();
			this.engine?.detach();
			if (err instanceof FatalConnectError) {
				this.lastConnectError = 'fatal';
				this.setStatus('error', msg);
				new Notice(msg, 12000);
			} else {
				if (manual || !this.lastConnectError) new Notice(t('connectFailed', { msg }), 8000);
				this.lastConnectError = msg;
				this.setStatus('offline', msg);
				this.scheduleReconnect();
			}
		} finally {
			if (stale() && client && this.client !== client) client.close();
			if (this.connectingGen === gen) this.connectingGen = -1;
		}
	}

	/** Checks everything a sync needs: transport, host key, login, SFTP, remote folder and write access. */
	async testConnection(): Promise<void> {
		let client: SshClient | undefined;
		try {
			const opened = await this.openClient(false);
			client = opened.client;
			const e = opened.e;
			const sftp = await Sftp.open(client);
			const store = await RemoteStore.open(sftp, e.remoteDir, this.deviceId);
			await store.checkWritable();
			const via = this.usesRelay() ? e.relayUrl : `${e.host}:${e.port}`;
			new Notice(t('testOk', { user: e.username, via, dir: store.root, fp: client.hostKey?.fingerprint ?? '?' }), 12000);
		} catch (err) {
			new Notice(err instanceof FatalConnectError ? err.message : t('connectFailed', { msg: (err as Error).message }), 12000);
		} finally {
			client?.close();
		}
	}
}

function confirmModal(app: App, side: 'local' | 'remote', count: number, total: number): Promise<boolean> {
	return new Promise((resolve) => {
		const m = new Modal(app);
		let answered = false;
		const done = (v: boolean): void => {
			answered = true;
			resolve(v);
			m.close();
		};
		m.titleEl.setText(t('massDeleteTitle'));
		m.contentEl.createEl('p', {
			text: t('massDeleteBody', { count, total, side: side === 'local' ? t('sideLocal') : t('sideRemote') }),
		});
		new Setting(m.contentEl)
			.addButton((b) => b.setButtonText(t('massDeleteNo')).setCta().onClick(() => done(false)))
			.addButton((b) => {
				b.setButtonText(t('massDeleteYes')).onClick(() => done(true));
				// red destructive style: setDestructive() since 1.13, the same CSS class before
				if (requireApiVersion('1.13.0')) b.setDestructive();
				else b.buttonEl.addClass('mod-warning');
			});
		m.onClose = () => {
			if (!answered) resolve(false);
		};
		m.open();
	});
}
