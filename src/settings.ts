import { App, Modal, Notice, Platform, PluginSettingTab, Setting, requireApiVersion } from 'obsidian';
import type { SettingDefinition, SettingDefinitionItem, SettingGroup } from 'obsidian';
import { t } from './i18n';
import type SyncherPlugin from './main';
import { defaultRelayUrl } from './relay-url';
import { parsePrivateKey, KeyPassphraseError } from './ssh/keys';

export type Transport = 'auto' | 'tcp' | 'websocket';

export interface SyncherSettings {
	remoteDir: string;
	host: string;
	port: number;
	username: string;
	/** sealed with SecretBox */
	passwordEnc: string;
	keyFile: string;
	/** imported private key text, sealed with SecretBox (takes precedence over keyFile) */
	keyDataEnc: string;
	/** sealed with SecretBox */
	keyPassEnc: string;
	transport: Transport;
	relayUrl: string;
	deviceName: string;
	permanentSave: boolean;
	autoSync: boolean;
	pollSeconds: number;
	debounceMs: number;
	fullSyncMinutes: number;
	exclude: string;
	notifyDeletes: boolean;
	/** pinned server key: "<type> SHA256:<fingerprint>" */
	hostKey: string;
}

export const DEFAULT_SETTINGS: SyncherSettings = {
	remoteDir: '',
	host: '',
	port: 0,
	username: '',
	passwordEnc: '',
	keyFile: '',
	keyDataEnc: '',
	keyPassEnc: '',
	transport: 'auto',
	relayUrl: '',
	deviceName: '',
	permanentSave: false,
	autoSync: true,
	pollSeconds: 3,
	debounceMs: 800,
	fullSyncMinutes: 15,
	exclude: '',
	notifyDeletes: true,
	hostKey: '',
};

/** Settings that require a new connection when changed. */
const CONNECTION_FIELDS: (keyof SyncherSettings)[] = [
	'remoteDir',
	'host',
	'port',
	'username',
	'passwordEnc',
	'keyFile',
	'keyDataEnc',
	'keyPassEnc',
	'transport',
	'relayUrl',
];

type TextKey = 'remoteDir' | 'host' | 'username' | 'keyFile' | 'relayUrl' | 'deviceName';
type SecretKey = 'passwordEnc' | 'keyPassEnc';
type NumberKey = 'pollSeconds' | 'debounceMs' | 'fullSyncMinutes';

/**
 * Settings tab described once with the declarative settings API: Obsidian ≥ 1.13 renders it itself
 * (and finds every row in its settings search); older versions get the same rows drawn by
 * `renderLegacy()`. Rows keep their custom controls through `render`.
 */
export class SyncherSettingTab extends PluginSettingTab {
	/** a connection field changed while the tab was open: reconnect when it closes */
	private connDirty = false;

	constructor(
		app: App,
		private plugin: SyncherPlugin,
	) {
		super(app, plugin);
	}

	hide(): void {
		super.hide();
		if (this.connDirty) void this.plugin.reconnect();
		this.connDirty = false;
	}

	/** Stores a value, persists the settings, and remembers when a reconnect is needed. */
	private async set<K extends keyof SyncherSettings>(key: K, value: SyncherSettings[K]): Promise<void> {
		this.plugin.settings[key] = value;
		if (CONNECTION_FIELDS.includes(key)) this.connDirty = true;
		await this.plugin.saveSettings();
	}

	/** Rebuilds the rows after a change that alters the structure or the texts shown. */
	private refresh(): void {
		if (requireApiVersion('1.13.0')) this.update();
		else this.renderLegacy();
	}

	/** Obsidian < 1.13 only calls display(); draw the same definitions imperatively there. */
	display(): void {
		this.renderLegacy();
	}

	private renderLegacy(): void {
		const el = this.containerEl;
		el.empty();
		const shown = (v: boolean | (() => boolean) | undefined): boolean => (typeof v === 'function' ? v() : v !== false);
		const row = (def: SettingDefinition): void => {
			if (!shown(def.visible)) return;
			const setting = new Setting(el).setName(def.name);
			if (def.desc) setting.setDesc(def.desc);
			if ('render' in def && def.render) def.render(setting, undefined as unknown as SettingGroup);
		};
		for (const item of this.getSettingDefinitions()) {
			if ('type' in item) {
				if (item.type !== 'group' && item.type !== 'list') continue;
				if (!shown(item.visible)) continue;
				if (item.heading) new Setting(el).setName(item.heading).setHeading();
				for (const child of item.items ?? []) if (!('items' in child)) row(child);
			} else if (!('items' in item)) row(item);
		}
	}

	private text(name: string, desc: string, key: TextKey, placeholder: string): SettingDefinition {
		return {
			name,
			desc,
			render: (setting) => {
				setting.addText((c) =>
					c
						.setPlaceholder(placeholder)
						.setValue(this.plugin.settings[key])
						.onChange((v) => void this.set(key, v.trim())),
				);
			},
		};
	}

	private secret(name: string, desc: string, key: SecretKey): SettingDefinition {
		return {
			name,
			desc,
			render: (setting) => {
				setting
					.addText((c) => {
						c.inputEl.type = 'password';
						c.inputEl.autocomplete = 'off';
						c.setPlaceholder(this.plugin.settings[key] ? t('secretSaved') : '').onChange(
							(v) => void this.set(key, v ? this.plugin.secrets.seal(key, v) : ''),
						);
					})
					.addExtraButton((b) =>
						b
							.setIcon('trash')
							.setTooltip(t('bReset'))
							.onClick(() => void this.set(key, '').then(() => this.refresh())),
					);
			},
		};
	}

	private number(name: string, desc: string, key: NumberKey, min: number): SettingDefinition {
		return {
			name,
			desc,
			render: (setting) => {
				setting.addText((c) =>
					c.setValue(String(this.plugin.settings[key])).onChange((v) => {
						const n = Number(v);
						if (!Number.isFinite(n) || n < min) return;
						void this.set(key, n).then(() => this.plugin.restartTimers());
					}),
				);
			},
		};
	}

	/** A read-only multi-line list shown under the row description. */
	private listBlock(setting: Setting, lines: string[]): void {
		if (lines.length) setting.descEl.createEl('pre', { cls: 'syncher-ignore', text: lines.join('\n') });
	}

	getSettingDefinitions(): SettingDefinitionItem[] {
		const p = this.plugin;
		const s = p.settings;
		const cfg = p.config.cfg;
		return [
			{ name: `Syncher v${p.manifest.version}`, desc: t('versionDesc') },
			{
				type: 'group',
				heading: t('secConnection'),
				items: [
					this.text(t('fRemoteDir'), t('fRemoteDirDesc'), 'remoteDir', cfg.remoteDir || '/home/user/vaults/notes'),
					this.text(t('fHost'), t('fHostDesc'), 'host', cfg.host || 'example.org'),
					{
						name: t('fPort'),
						render: (setting) => {
							setting.addText((c) =>
								c
									.setPlaceholder(String(cfg.port || 22))
									.setValue(s.port ? String(s.port) : '')
									.onChange((v) => {
										const n = parseInt(v, 10);
										void this.set('port', Number.isFinite(n) && n > 0 && n < 65536 ? n : 0);
									}),
							);
						},
					},
					this.text(t('fUser'), '', 'username', cfg.username || 'user'),
					this.secret(t('fPassword'), t('fPasswordDesc'), 'passwordEnc'),
					// The key is imported once (file picker or pasted text) and stored encrypted in the plugin
					// data, so the plugin never reads files outside the vault — on any platform.
					{
						name: t('fKeyImport'),
						desc: s.keyDataEnc ? t('fKeyImportedDesc') : t('fKeyImportDesc'),
						render: (setting) => {
							setting.addButton((b) =>
								b
									.setButtonText(s.keyDataEnc ? t('bKeyReplace') : t('bKeyImport'))
									.setCta()
									.onClick(() =>
										new KeyImportModal(this.app, async (keyText) => {
											await this.set('keyDataEnc', p.secrets.seal('keyDataEnc', keyText));
											this.refresh();
										}).open(),
									),
							);
							if (s.keyDataEnc)
								setting.addExtraButton((b) =>
									b
										.setIcon('trash')
										.setTooltip(t('bReset'))
										.onClick(() => void this.set('keyDataEnc', '').then(() => this.refresh())),
								);
						},
					},
					this.secret(t('fKeyPass'), t('fKeyPassDesc'), 'keyPassEnc'),
					// Desktop talks SSH directly; Obsidian mobile has no TCP API at all, so the same SSH
					// stream goes through a tiny byte relay next to sshd (server/install-relay.sh).
					{
						name: t('fTransport'),
						desc: t('fTransportDesc'),
						visible: () => !Platform.isMobile,
						render: (setting) => {
							setting.addDropdown((d) =>
								d
									.addOption('auto', t('tTcp'))
									.addOption('websocket', t('tWs'))
									.setValue(s.transport === 'websocket' ? 'websocket' : 'auto')
									.onChange((v) => void this.set('transport', v === 'websocket' ? 'websocket' : 'auto').then(() => this.refresh())),
							);
						},
					},
					{
						...this.text(
							t('fRelay'),
							t('fRelayDesc'),
							'relayUrl',
							cfg.relayUrl || defaultRelayUrl(s.host || cfg.host) || 'ws://example.org:8022',
						),
						visible: () => p.usesRelay(),
					},
				],
			},
			{
				type: 'group',
				heading: t('secDevice'),
				items: [
					{
						name: t('fDeviceName'),
						desc: t('fDeviceNameDesc'),
						render: (setting) => {
							setting.addText((c) =>
								c
									.setPlaceholder(p.defaultDeviceName())
									.setValue(s.deviceName)
									.onChange((v) => void this.set('deviceName', v.trim()).then(() => p.engine?.setDeviceName(p.deviceName()))),
							);
						},
					},
					{
						name: t('fPermanent'),
						desc: t('fPermanentDesc'),
						render: (setting) => {
							setting.addToggle((c) =>
								c.setValue(s.permanentSave).onChange((v) => {
									void this.set('permanentSave', v)
										.then(() => p.engine?.setPermanentSave(v))
										.then(() => this.refresh());
								}),
							);
						},
					},
				],
			},
			{
				type: 'group',
				heading: t('secSync'),
				items: [
					{
						name: t('fAuto'),
						desc: t('fAutoDesc'),
						render: (setting) => {
							setting.addToggle((c) =>
								c.setValue(s.autoSync).onChange((v) => {
									void this.set('autoSync', v).then(() => {
										if (v) void p.connect();
										else p.disconnect();
									});
								}),
							);
						},
					},
					this.number(t('fPoll'), '', 'pollSeconds', 1),
					this.number(t('fDebounce'), t('fDebounceDesc'), 'debounceMs', 0),
					this.number(t('fFull'), t('fFullDesc'), 'fullSyncMinutes', 0),
					{
						name: t('fExclude'),
						desc: t('fExcludeDesc'),
						render: (setting) => {
							setting.addTextArea((c) => {
								c.inputEl.rows = 3;
								c.setValue(s.exclude).onChange(
									(v) => void this.set('exclude', v).then(() => p.engine?.setExclude(p.excludePatterns())),
								);
							});
						},
					},
					{
						name: t('fNotify'),
						desc: t('fNotifyDesc'),
						render: (setting) => {
							setting.addToggle((c) => c.setValue(s.notifyDeletes).onChange((v) => void this.set('notifyDeletes', v)));
						},
					},
				],
			},
			{
				type: 'group',
				heading: t('secStatus'),
				items: [
					{
						name: p.statusText(),
						searchable: false,
						render: (setting) => {
							setting
								.addButton((b) => b.setButtonText(t('bTest')).onClick(() => void p.testConnection()))
								.addButton((b) => b.setButtonText(t('bReconnect')).onClick(() => void p.reconnect().then(() => this.refresh())))
								.addButton((b) =>
									b
										.setButtonText(t('bSyncNow'))
										.setCta()
										.onClick(() => p.syncNow()),
								);
						},
					},
					{
						name: t('fHostKey'),
						desc: s.hostKey || t('fHostKeyNone'),
						render: (setting) => {
							setting.addButton((b) =>
								b.setButtonText(t('bReset')).onClick(() => {
									void this.set('hostKey', '').then(() => {
										new Notice(t('fHostKeyNone'));
										this.refresh();
									});
								}),
							);
						},
					},
					{
						name: t('fProblems'),
						desc: t('fProblemsDesc', { n: p.engine?.problemList.length ?? 0 }),
						visible: () => (p.engine?.problemList.length ?? 0) > 0,
						render: (setting) =>
							this.listBlock(
								setting,
								(p.engine?.problemList ?? []).map((x) => `${x.path || '/'} — ${x.message}`),
							),
					},
					{
						name: t('fIgnore'),
						desc: t('fIgnoreDesc', { n: p.engine?.ignoreList.length ?? 0 }),
						render: (setting) => this.listBlock(setting, p.engine?.ignoreList ?? []),
					},
					{
						name: t('fDevices'),
						desc: (p.engine?.devices ?? [])
							.map((x) => {
								const mine = p.manifest.version;
								const v = x.version ? `v${x.version}` : t('versionOld');
								const warn = x.version !== mine ? ` ⚠ ${t('versionDiffers', { mine })}` : '';
								return `${x.name} (${v}) — ${p.isDeviceOnline(x) ? t('online') : t('offline')}${warn}`;
							})
							.join(' · '),
						visible: () => (p.engine?.devices.length ?? 0) > 0,
					},
					{ name: t('fConfig'), desc: t('fConfigDesc', { path: p.config.path }) },
				],
			},
		];
	}
}

/**
 * Import of a private key into the plugin data (sealed with SecretBox). Works the same on
 * every platform: pick the key file with the system file picker or paste its text.
 */
class KeyImportModal extends Modal {
	constructor(
		app: App,
		private onSave: (keyText: string) => Promise<void>,
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		this.titleEl.setText(t('keyImportTitle'));
		contentEl.createEl('p', { text: t('keyImportBody') });
		const area = contentEl.createEl('textarea', { cls: 'syncher-key-input' });
		area.rows = 8;
		area.placeholder = t('keyImportPlaceholder');
		area.spellcheck = false;
		area.autocomplete = 'off';
		const picker = contentEl.createEl('input', { type: 'file', cls: 'syncher-hidden' });
		picker.addEventListener('change', () => {
			const file = picker.files?.[0];
			if (!file) return;
			void file.text().then((txt) => (area.value = txt));
		});
		new Setting(contentEl)
			.addButton((b) => b.setButtonText(t('bKeyChooseFile')).onClick(() => picker.click()))
			.addButton((b) =>
				b
					.setButtonText(t('bSave'))
					.setCta()
					.onClick(async () => {
						if (!area.value.trim()) {
							new Notice(t('keyImportEmpty'), 6000);
							return;
						}
						const keyText = area.value.trim() + '\n';
						try {
							parsePrivateKey(keyText);
						} catch (e) {
							// an encrypted key is fine here: its passphrase is a separate setting
							if (!(e instanceof KeyPassphraseError)) {
								new Notice(t('keyBad', { msg: (e as Error).message }), 8000);
								return;
							}
						}
						await this.onSave(keyText);
						area.value = '';
						new Notice(t('keyImported'));
						this.close();
					}),
			);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
