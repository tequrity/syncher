// The Android code path: SSH over a WebSocket relay (server/obsyncher-relay.py).
// Start the relay next to the test sshd, e.g.:
//   python3 server/obsyncher-relay.py --listen 0.0.0.0:8023 --target 127.0.0.1:2299
// Configure with OBSYNCHER_TEST_WS (default ws://127.0.0.1:8023).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SshClient } from '../src/ssh/client';
import { parsePrivateKey } from '../src/ssh/keys';
import { Sftp } from '../src/ssh/sftp';
import { connectWebSocket } from '../src/ssh/socket';
import { TEST_USER, keyText } from './helpers';

const WS_URL = process.env.OBSYNCHER_TEST_WS ?? 'ws://127.0.0.1:8023';

const avail = connectWebSocket(WS_URL, 2000).then(
	(d) => {
		d.close();
		return true;
	},
	() => false,
);

test('SSH + SFTP through the WebSocket relay', async (t) => {
	if (!(await avail)) return t.skip(`relay not reachable at ${WS_URL}`);
	const sock = await connectWebSocket(WS_URL, 5000);
	const client = await SshClient.connect(sock, {
		username: TEST_USER,
		privateKey: parsePrivateKey(keyText('id_ed25519_enc'), 'secret pass'),
		verifyHostKey: () => true,
		keepaliveMs: 0,
	});
	try {
		const s = await Sftp.open(client);
		const data = new Uint8Array(5 * 1024 * 1024 + 7);
		for (let i = 0; i < data.length; i += 65536) crypto.getRandomValues(data.subarray(i, i + 65536));
		const p = `${await s.realpath('.')}/.obsyncher-test/ws-blob`;
		await s.writeFile(p, data);
		const back = await s.readFile(p);
		assert.ok(Buffer.from(back.data).equals(Buffer.from(data)));
		await s.remove(p);
	} finally {
		client.close();
	}
});
