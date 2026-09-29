import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connect, serverAvailable, withSftp } from './helpers';
import { Sftp, isDir } from '../src/ssh/sftp';
import { KeyPassphraseError, parsePrivateKey } from '../src/ssh/keys';
import { keyText } from './helpers';

const avail = serverAvailable();
function itSsh(name: string, fn: () => Promise<void>): void {
	test(name, async (t) => {
		if (!(await avail)) return t.skip('test sshd not reachable (see test/sshd/start-wsl-sshd.sh)');
		await fn();
	});
}

const KEYS: [string, string | undefined][] = [
	['id_ed25519', undefined],
	['id_ed25519_enc', 'secret pass'],
	['id_rsa_enc', 'rsapass'],
	['id_rsa_pem', undefined],
	['id_ecdsa', undefined],
	['id_ecdsa384', 'ec'],
];

for (const [name, pass] of KEYS) {
	itSsh(`auth with ${name}`, async () => {
		const c = await connect({}, name, pass);
		c.close();
	});
}

test('wrong passphrase is reported', () => {
	assert.throws(() => parsePrivateKey(keyText('id_ed25519_enc'), 'nope'), KeyPassphraseError);
	assert.throws(() => parsePrivateKey(keyText('id_ed25519_enc')), KeyPassphraseError);
});

const CIPHERS = [
	['chacha20-poly1305@openssh.com'],
	['aes256-gcm@openssh.com'],
	['aes128-gcm@openssh.com'],
	['aes256-ctr', 'hmac-sha2-256-etm@openssh.com'],
	['aes128-ctr', 'hmac-sha2-512-etm@openssh.com'],
	['aes192-ctr', 'hmac-sha2-256'],
	['aes256-ctr', 'hmac-sha2-512'],
];

for (const [cipher, mac] of CIPHERS) {
	itSsh(`cipher ${cipher} ${mac ?? ''} transfers 3 MB intact`, async () => {
		await withSftp(
			async (s) => {
				const data = new Uint8Array(3 * 1024 * 1024 + 123);
				for (let i = 0; i < data.length; i += 65536) crypto.getRandomValues(data.subarray(i, i + 65536));
				const home = await s.realpath('.');
				const p = `${home}/.obsyncher-test/blob-${cipher}`;
				await s.writeFile(p, data, { mtime: 1700000000 });
				const back = await s.readFile(p);
				assert.equal(back.attrs.mtime, 1700000000);
				assert.equal(back.data.length, data.length);
				assert.ok(Buffer.from(back.data).equals(Buffer.from(data)));
				await s.remove(p);
			},
			{ algorithms: { cipher: [cipher], mac: mac ? [mac] : undefined } },
		);
	});
}

for (const kex of ['curve25519-sha256', 'ecdh-sha2-nistp256', 'ecdh-sha2-nistp384', 'ecdh-sha2-nistp521']) {
	itSsh(`kex ${kex}`, async () => {
		(await connect({ algorithms: { kex: [kex] } })).close();
	});
}

for (const hk of ['ssh-ed25519', 'ecdsa-sha2-nistp256', 'rsa-sha2-512', 'rsa-sha2-256']) {
	itSsh(`host key ${hk}`, async () => {
		let seen = '';
		const c = await connect({
			algorithms: { hostKey: [hk] },
			verifyHostKey: (i) => {
				seen = i.fingerprint;
				return true;
			},
		});
		assert.match(seen, /^SHA256:/);
		c.close();
	});
}

itSsh('host key rejection aborts', async () => {
	await assert.rejects(connect({ verifyHostKey: () => false }), /Host key rejected/);
});

itSsh('sftp directory ops, rename, append', async () => {
	await withSftp(async (s: Sftp) => {
		const base = `${await s.realpath('.')}/.obsyncher-test/ops`;
		await s.rmrf(base);
		await s.mkdirp(`${base}/a/b/c`);
		assert.ok(isDir(await s.stat(`${base}/a/b`)));
		await s.writeFile(`${base}/a/b/c/x.md`, new TextEncoder().encode('hello'));
		await s.rename(`${base}/a/b/c/x.md`, `${base}/a/y.md`);
		assert.equal(await s.exists(`${base}/a/b/c/x.md`), null);
		await s.writeFile(`${base}/a/z.md`, new TextEncoder().encode('old'));
		await s.rename(`${base}/a/y.md`, `${base}/a/z.md`);
		assert.equal(new TextDecoder().decode((await s.readFile(`${base}/a/z.md`)).data), 'hello');
		await s.appendFile(`${base}/log`, new TextEncoder().encode('1\n'));
		await s.appendFile(`${base}/log`, new TextEncoder().encode('2\n'));
		assert.equal(new TextDecoder().decode(await s.readRange(`${base}/log`, 2)), '2\n');
		const names = (await s.readdir(`${base}/a`)).map((e) => e.name).sort();
		assert.deepEqual(names, ['b', 'z.md']);
		await s.rmrf(base);
		assert.equal(await s.exists(base), null);
	});
});
