// Shared helpers for integration tests against a real OpenSSH server.
// Configure with env OBSYNCHER_TEST_SSH="host:port:user" (default 127.0.0.1:2299:<USER>)
// and OBSYNCHER_TEST_KEYS (default .test-tmp/keys). See test/sshd/start-wsl-sshd.sh.

import { readFileSync } from 'fs';
import { join, resolve } from 'path';
import { SshClient, SshOptions } from '../src/ssh/client';
import { parsePrivateKey } from '../src/ssh/keys';
import { Sftp } from '../src/ssh/sftp';
import { connectTcp } from '../src/ssh/socket';

const [host, portStr, user] = (process.env.OBSYNCHER_TEST_SSH ?? `127.0.0.1:2299:${process.env.USER ?? process.env.USERNAME ?? 'user'}`).split(':');
export const TEST_HOST = host;
export const TEST_PORT = Number(portStr);
export const TEST_USER = user;
export const KEYS_DIR = resolve(process.env.OBSYNCHER_TEST_KEYS ?? '.test-tmp/keys');

export function keyText(name: string): string {
	return readFileSync(join(KEYS_DIR, name), 'utf8');
}

export async function connect(extra: Partial<SshOptions> = {}, keyName = 'id_ed25519', pass?: string): Promise<SshClient> {
	const sock = await connectTcp(TEST_HOST, TEST_PORT, 5000);
	return SshClient.connect(sock, {
		username: TEST_USER,
		privateKey: parsePrivateKey(keyText(keyName), pass),
		verifyHostKey: () => true,
		keepaliveMs: 0,
		...extra,
	});
}

export async function withSftp<T>(fn: (s: Sftp, c: SshClient) => Promise<T>, extra: Partial<SshOptions> = {}): Promise<T> {
	const c = await connect(extra);
	try {
		const s = await Sftp.open(c);
		return await fn(s, c);
	} finally {
		c.close();
	}
}

export async function serverAvailable(): Promise<boolean> {
	try {
		const s = await connectTcp(TEST_HOST, TEST_PORT, 2000);
		s.close();
		return true;
	} catch {
		return false;
	}
}
