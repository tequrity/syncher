import { App, Modal, Notice, Platform, PluginSettingTab, Setting } from 'obsidian';
import { t } from './i18n';
import type ObsyncherPlugin from './main';
import { defaultRelayUrl } from './relay-url';
import { parsePrivateKey, KeyPassphraseError } from './ssh/keys';

export type Transport = 'auto' | 'tcp' | 'websocket';

export interface ObsyncherSettings {
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

export const DEFAULT_SETTINGS: ObsyncherSettings = {
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
const CONNECTION_FIELDS: (keyof ObsyncherSettings)[] = [
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

export class ObsyncherSettingTab extends PluginSettingTab {
	private snapshot = '';

	constructor(
		app: App,
		private plugin: ObsyncherPlugin,
	) {
		super(app, plugin);
	}

	private connKey(): string {
		const s = this.plugin.settings;
		return JSON.stringify(CONNECTION_FIELDS.map((k) => s[k]));
	}

	hide(): void {
		if (this.snapshot && this.snapshot !== this.connKey()) void this.plugin.reconnect();
		this.snapshot = '';
	}

	display(): void {
		const { containerEl } = this;
		const p = this.plugin;
		const s = p.settings;
		const cfg = p.config.cfg;
		if (!this.snapshot) this.snapshot = this.connKey();
		containerEl.empty();

		const save = async (): Promise<void> => {
			await p.saveSettings();
		};
		const text = (
			name: string,
			desc: string,
			key: 'remoteDir' | 'host' | 'username' | 'keyFile' | 'relayUrl' | 'deviceName',
			placeholder: string,
		): Setting =>
			new Setting(containerEl)
				.setName(name)
				.setDesc(desc)
				.addText((c) =>
					c
						.setPlaceholder(placeholder)
						.setValue(s[key])
						.onChange(async (v) => {
							s[key] = v.trim();
							await save();
						}),
				);
		const secret = (name: string, desc: string, key: 'passwordEnc' | 'keyPassEnc'): Setting =>
			new Setting(containerEl)
				.setName(name)
				.setDesc(desc)
				.addText((c) => {
					c.inputEl.type = 'password';
					c.inputEl.autocomplete = 'off';
					c.setPlaceholder(s[key] ? '•••••••• (saved)' : '').onChange(async (v) => {
						s[key] = v ? p.secrets.seal(key, v) : '';
						await save();
					});
				})
				.addExtraButton((b) =>
					b
						.setIcon('trash')
						.setTooltip(t('bReset'))
						.onClick(async () => {
							s[key] = '';
							await save();
							this.display();
						}),
				);

		// ---------------- connection
		new Setting(containerEl).setName(`Obsyncher v${p.manifest.version}`).setDesc(t('versionDesc')).setHeading();
		new Setting(containerEl).setName(t('secConnection')).setHeading();
		text(t('fRemoteDir'), t('fRemoteDirDesc'), 'remoteDir', cfg.remoteDir || '/home/user/vaults/notes');
		text(t('fHost'), t('fHostDesc'), 'host', cfg.host || 'example.org');
		new Setting(containerEl).setName(t('fPort')).addText((c) =>
			c
				.setPlaceholder(String(cfg.port || 22))
				.setValue(s.port ? String(s.port) : '')
				.onChange(async (v) => {
					const n = parseInt(v, 10);
					s.port = Number.isFinite(n) && n > 0 && n < 65536 ? n : 0;
					await save();
				}),
		);
		text(t('fUser'), '', 'username', cfg.username || 'user');
		secret(t('fPassword'), t('fPasswordDesc'), 'passwordEnc');

		// Key: an imported key (stored encrypted in the plugin data) beats a key file. Import is the
		// only reliable way on Android, where plugins cannot read files outside the vault.
		new Setting(containerEl)
			.setName(t('fKeyImport'))
			.setDesc(s.keyDataEnc ? t('fKeyImportedDesc') : t('fKeyImportDesc'))
			.addButton((b) =>
				b
					.setButtonText(s.keyDataEnc ? t('bKeyReplace') : t('bKeyImport'))
					.setCta()
					.onClick(() =>
						new KeyImportModal(this.app, async (keyText) => {
							s.keyDataEnc = p.secrets.seal('keyDataEnc', keyText);
							await save();
							this.display();
						}).open(),
					),
			)
			.then((st) => {
				if (!s.keyDataEnc) return;
				st.addExtraButton((b) =>
					b
						.setIcon('trash')
						.setTooltip(t('bReset'))
						.onClick(async () => {
							s.keyDataEnc = '';
							await save();
							this.display();
						}),
				);
			});
		if (!s.keyDataEnc) {
			const keySetting = text(t('fKey'), t('fKeyDesc', { dir: p.config.keysDirLabel() }), 'keyFile', cfg.keyFile || 'id_ed25519');
			void p.config.listKeys().then((keys) => {
				if (!keys.length) return;
				keySetting.addDropdown((d) => {
					d.addOption('', `— ${t('fKeyPick')} —`);
					for (const k of keys) d.addOption(k, k);
					d.setValue(keys.includes(s.keyFile) ? s.keyFile : '');
					d.onChange(async (v) => {
						if (!v) return;
						s.keyFile = v;
						await save();
						this.display();
					});
				});
			});
		}
		secret(t('fKeyPass'), t('fKeyPassDesc'), 'keyPassEnc');

		// Transport: desktop talks SSH directly; Obsidian mobile has no TCP API at all, so the
		// same SSH stream goes through a tiny byte relay next to sshd (server/install-relay.sh).
		if (!Platform.isMobile) {
			new Setting(containerEl)
				.setName(t('fTransport'))
				.setDesc(t('fTransportDesc'))
				.addDropdown((d) =>
					d
						.addOption('auto', t('tTcp'))
						.addOption('websocket', t('tWs'))
						.setValue(s.transport === 'websocket' ? 'websocket' : 'auto')
						.onChange(async (v) => {
							s.transport = v as Transport;
							await save();
							this.display();
						}),
				);
		}
		if (p.usesRelay()) {
			const host = s.host || cfg.host;
			text(t('fRelay'), t('fRelayDesc'), 'relayUrl', cfg.relayUrl || defaultRelayUrl(host) || 'ws://example.org:8022');
		}

		// ---------------- device
		new Setting(containerEl).setName(t('secDevice')).setHeading();
		new Setting(containerEl)
			.setName(t('fDeviceName'))
			.setDesc(t('fDeviceNameDesc'))
			.addText((c) =>
				c
					.setPlaceholder(p.defaultDeviceName())
					.setValue(s.deviceName)
					.onChange(async (v) => {
						s.deviceName = v.trim();
						await save();
						p.engine?.setDeviceName(p.deviceName());
					}),
			);
		new Setting(containerEl)
			.setName(t('fPermanent'))
			.setDesc(t('fPermanentDesc'))
			.addToggle((c) =>
				c.setValue(s.permanentSave).onChange(async (v) => {
					s.permanentSave = v;
					await save();
					await p.engine?.setPermanentSave(v);
					this.display();
				}),
			);

		// ---------------- sync behaviour
		new Setting(containerEl).setName(t('secSync')).setHeading();
		new Setting(containerEl)
			.setName(t('fAuto'))
			.setDesc(t('fAutoDesc'))
			.addToggle((c) =>
				c.setValue(s.autoSync).onChange(async (v) => {
					s.autoSync = v;
					await save();
					if (v) void p.connect();
					else p.disconnect();
				}),
			);
		const num = (name: string, desc: string, key: 'pollSeconds' | 'debounceMs' | 'fullSyncMinutes', min: number): void => {
			new Setting(containerEl)
				.setName(name)
				.setDesc(desc)
				.addText((c) =>
					c.setValue(String(s[key])).onChange(async (v) => {
						const n = Number(v);
						if (!Number.isFinite(n) || n < min) return;
						s[key] = n;
						await save();
						p.restartTimers();
					}),
				);
		};
		num(t('fPoll'), '', 'pollSeconds', 1);
		num(t('fDebounce'), t('fDebounceDesc'), 'debounceMs', 0);
		num(t('fFull'), t('fFullDesc'), 'fullSyncMinutes', 0);
		new Setting(containerEl)
			.setName(t('fExclude'))
			.setDesc(t('fExcludeDesc'))
			.addTextArea((c) => {
				c.inputEl.rows = 3;
				c.setValue(s.exclude).onChange(async (v) => {
					s.exclude = v;
					await save();
					p.engine?.setExclude(p.excludePatterns());
				});
			});
		new Setting(containerEl)
			.setName(t('fNotify'))
			.setDesc(t('fNotifyDesc'))
			.addToggle((c) =>
				c.setValue(s.notifyDeletes).onChange(async (v) => {
					s.notifyDeletes = v;
					await save();
				}),
			);

		// ---------------- status & tools
		new Setting(containerEl).setName(t('secStatus')).setHeading();
		new Setting(containerEl)
			.setName(p.statusText())
			.addButton((b) => b.setButtonText(t('bTest')).onClick(() => void p.testConnection()))
			.addButton((b) => b.setButtonText(t('bReconnect')).onClick(() => void p.reconnect()))
			.addButton((b) =>
				b
					.setButtonText(t('bSyncNow'))
					.setCta()
					.onClick(() => p.syncNow()),
			);
		new Setting(containerEl)
			.setName(t('fHostKey'))
			.setDesc(s.hostKey || t('fHostKeyNone'))
			.addButton((b) =>
				b.setButtonText(t('bReset')).onClick(async () => {
					s.hostKey = '';
					await save();
					new Notice(t('fHostKeyNone'));
					this.display();
				}),
			);
		const problems = p.engine?.problemList ?? [];
		if (problems.length) {
			new Setting(containerEl).setName(t('fProblems')).setDesc(t('fProblemsDesc', { n: problems.length }));
			containerEl.createEl('pre', {
				cls: 'obsyncher-ignore',
				text: problems.map((x) => `${x.path || '/'} — ${x.message}`).join('\n'),
			});
		}
		const ignore = p.engine?.ignoreList ?? [];
		const ig = new Setting(containerEl).setName(t('fIgnore')).setDesc(t('fIgnoreDesc', { n: ignore.length }));
		if (ignore.length) {
			const pre = containerEl.createEl('pre', { cls: 'obsyncher-ignore' });
			pre.setText(ignore.join('\n'));
			ig.settingEl.after(pre);
		}
		const devs = p.engine?.devices ?? [];
		if (devs.length) {
			const d = new Setting(containerEl).setName(t('fDevices'));
			const mine = p.manifest.version;
			d.setDesc(
				devs
					.map((x) => {
						const v = x.version ? `v${x.version}` : t('versionOld');
						const warn = x.version !== mine ? ` ⚠ ${t('versionDiffers', { mine })}` : '';
						return `${x.name} (${v}) — ${p.isDeviceOnline(x) ? t('online') : t('offline')}${warn}`;
					})
					.join(' · '),
			);
		}
		new Setting(containerEl).setName(t('fConfig')).setDesc(t('fConfigDesc', { path: p.config.path }));
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
		const area = contentEl.createEl('textarea', { cls: 'obsyncher-key-input' });
		area.rows = 8;
		area.placeholder = '-----BEGIN OPENSSH PRIVATE KEY-----\n…\n-----END OPENSSH PRIVATE KEY-----';
		area.spellcheck = false;
		area.autocomplete = 'off';
		const picker = contentEl.createEl('input', { type: 'file', cls: 'obsyncher-hidden' });
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
