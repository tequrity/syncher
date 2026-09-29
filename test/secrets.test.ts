import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { App } from 'obsidian';
import { SecretBox } from '../src/secrets';

function fakeApp(withSecretStorage: boolean): App & { ls: Map<string, unknown>; ss: Map<string, string> } {
	const ls = new Map<string, unknown>();
	const ss = new Map<string, string>();
	const app = {
		ls,
		ss,
		loadLocalStorage: (k: string) => ls.get(k) ?? null,
		saveLocalStorage: (k: string, v: unknown) => (v === null ? ls.delete(k) : ls.set(k, v)),
		secretStorage: withSecretStorage
			? { getSecret: (id: string) => ss.get(id) ?? null, setSecret: (id: string, v: string) => ss.set(id, v) }
			: undefined,
	};
	return app as unknown as App & { ls: Map<string, unknown>; ss: Map<string, string> };
}

test('seal/open round-trip, per-field binding, tamper detection', () => {
	const app = fakeApp(true);
	const box = new SecretBox(app);
	const sealed = box.seal('keyPassEnc', 'pässwörd 🔑');
	assert.match(sealed, /^v1\./);
	assert.ok(!sealed.includes('pässwörd'));
	assert.equal(box.open('keyPassEnc', sealed), 'pässwörd 🔑');
	assert.notEqual(box.seal('keyPassEnc', 'x'), box.seal('keyPassEnc', 'x'), 'fresh salt/nonce each time');
	assert.equal(box.open('passwordEnc', sealed), null, 'bound to its field');
	const mid = sealed.lastIndexOf('.') + 4; // inside the ciphertext, away from base64 padding bits
	const tampered = sealed.slice(0, mid) + (sealed[mid] === 'A' ? 'B' : 'A') + sealed.slice(mid + 1);
	assert.equal(box.open('keyPassEnc', tampered), null);
	assert.equal(box.backend, 'keychain');
	assert.equal(app.ls.size, 0, 'master key not in local storage when SecretStorage exists');
	assert.equal(box.open('keyPassEnc', ''), '');
});

test('another device (different master key) cannot decrypt', () => {
	const sealed = new SecretBox(fakeApp(true)).seal('passwordEnc', 'secret');
	assert.equal(new SecretBox(fakeApp(true)).open('passwordEnc', sealed), null);
});

test('falls back to local storage and migrates into SecretStorage later', () => {
	const app = fakeApp(false);
	const sealed = new SecretBox(app).seal('passwordEnc', 'secret');
	assert.equal(app.ls.size, 1);
	const upgraded = fakeApp(true);
	for (const [k, v] of app.ls) upgraded.ls.set(k, v);
	assert.equal(new SecretBox(upgraded).open('passwordEnc', sealed), 'secret');
	assert.equal(upgraded.ls.size, 0);
	assert.equal(upgraded.ss.size, 1);
});

test('secrets sealed before the rename from Obsyncher still open', async () => {
	const { hkdf } = await import('@noble/hashes/hkdf.js');
	const { sha512 } = await import('@noble/hashes/sha2.js');
	const { gcm } = await import('@noble/ciphers/aes.js');
	const b64 = (b: Uint8Array) => Buffer.from(b).toString('base64');
	const te = new TextEncoder();
	// what the old version stored: master key under its old id, value sealed with its old HKDF label
	const master = crypto.getRandomValues(new Uint8Array(32));
	const salt = crypto.getRandomValues(new Uint8Array(16));
	const nonce = crypto.getRandomValues(new Uint8Array(12));
	const key = hkdf(sha512, master, salt, te.encode('obsyncher/v1/keyPassEnc'), 32);
	const sealed = 'v1.' + [salt, nonce, gcm(key, nonce, te.encode('keyPassEnc')).encrypt(te.encode('old pass'))].map(b64).join('.');
	const app = fakeApp(true);
	app.ss.set('obsyncher-master-key', b64(master));
	const box = new SecretBox(app);
	assert.equal(box.open('keyPassEnc', sealed), 'old pass');
	assert.ok(app.ss.has('syncher-master-key'), 'master key now also stored under the new id');
	assert.equal(box.open('keyPassEnc', box.seal('keyPassEnc', 'new')), 'new');
});
