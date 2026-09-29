// Encryption of stored passwords (SSH password, key passphrase).
//
// Each secret is sealed with AES-256-GCM. The AES key is derived with HKDF-SHA-512
// from a 256-bit random device master key plus a fresh 128-bit salt per secret, with
// the field name bound as HKDF info and as GCM associated data. The ciphertext lives
// in the plugin's data.json; the master key never does: it is kept in Obsidian's
// SecretStorage (Obsidian ≥ 1.11.4) or, on older versions, in the
// device-local app storage. A copied data.json is useless on another machine.

import type { App } from 'obsidian';
import { gcm } from '@noble/ciphers/aes.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha512 } from '@noble/hashes/sha2.js';
import { fromBase64, fromUtf8, toBase64, utf8 } from './ssh/buffer';

const MASTER_ID = 'obsyncher-master-key';
const PREFIX = 'v1.';

interface SecretStore {
	getSecret(id: string): string | null;
	setSecret(id: string, secret: string): void;
}

export class SecretBox {
	private master?: Uint8Array;

	constructor(private app: App) {}

	private store(): SecretStore | undefined {
		const s = (this.app as unknown as { secretStorage?: SecretStore }).secretStorage;
		return s && typeof s.getSecret === 'function' && typeof s.setSecret === 'function' ? s : undefined;
	}

	private masterKey(): Uint8Array {
		if (this.master) return this.master;
		const store = this.store();
		let b64: string | null = null;
		try {
			b64 = store?.getSecret(MASTER_ID) ?? null;
		} catch {
			b64 = null;
		}
		const legacy = this.app.loadLocalStorage(MASTER_ID) as string | null;
		if (!b64 && legacy) {
			b64 = legacy;
			if (store) {
				try {
					store.setSecret(MASTER_ID, legacy);
					this.app.saveLocalStorage(MASTER_ID, null);
				} catch {
					/* keep in local storage */
				}
			}
		}
		if (!b64) {
			const k = new Uint8Array(32);
			crypto.getRandomValues(k);
			b64 = toBase64(k);
			let saved = false;
			if (store) {
				try {
					store.setSecret(MASTER_ID, b64);
					saved = true;
				} catch {
					saved = false;
				}
			}
			if (!saved) this.app.saveLocalStorage(MASTER_ID, b64);
		}
		this.master = fromBase64(b64);
		return this.master;
	}

	get backend(): 'keychain' | 'local-storage' {
		return this.store() ? 'keychain' : 'local-storage';
	}

	seal(field: string, plaintext: string): string {
		if (!plaintext) return '';
		const salt = crypto.getRandomValues(new Uint8Array(16));
		const nonce = crypto.getRandomValues(new Uint8Array(12));
		const key = hkdf(sha512, this.masterKey(), salt, utf8(`obsyncher/v1/${field}`), 32);
		const ct = gcm(key, nonce, utf8(field)).encrypt(utf8(plaintext));
		key.fill(0);
		return PREFIX + [salt, nonce, ct].map(toBase64).join('.');
	}

	/** Returns null when the value cannot be decrypted (other device, tampered, lost master key). */
	open(field: string, sealed: string): string | null {
		if (!sealed) return '';
		if (!sealed.startsWith(PREFIX)) return null;
		try {
			const [salt, nonce, ct] = sealed.slice(PREFIX.length).split('.').map(fromBase64);
			const key = hkdf(sha512, this.masterKey(), salt, utf8(`obsyncher/v1/${field}`), 32);
			const pt = gcm(key, nonce, utf8(field)).decrypt(ct);
			key.fill(0);
			return fromUtf8(pt);
		} catch {
			return null;
		}
	}
}
