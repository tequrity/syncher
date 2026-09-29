// Multi-device scenarios: several simulated devices (own local folder, own SSH
// connection, own state) syncing through one remote directory on a real OpenSSH server.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'fs';
import { join, resolve } from 'path';
import { SshClient } from '../src/ssh/client';
import { Sftp } from '../src/ssh/sftp';
import { RemoteStore } from '../src/sync/remote';
import { SyncEngine } from '../src/sync/engine';
import { connect, serverAvailable } from './helpers';
import { MemoryPersistence, NodeFs, StrictNamesFs } from './nodefs';

const avail = serverAvailable();
const TMP = resolve('.test-tmp/devices');
let clock = Math.floor(Date.now() / 1000) - 86400; // deterministic, increasing mtimes (s)

function tick(): number {
	clock += 10;
	return clock * 1000;
}

/** every device of the running scenario: disconnected even when an assertion fails (else node hangs on open sockets) */
const live: Device[] = [];

class Device {
	fs: NodeFs;
	persist = new MemoryPersistence();
	engine: SyncEngine;
	client?: SshClient;
	notices: string[] = [];
	problems: string[] = [];
	massDeleteAnswer = false;
	massDeleteAsked = 0;

	constructor(
		readonly name: string,
		readonly remoteDir: string,
		permanentSave = false,
		strictNames = false,
	) {
		live.push(this);
		const root = join(TMP, remoteDir.split('/').pop()!, name);
		this.fs = strictNames ? new StrictNamesFs(root) : new NodeFs(root);
		this.engine = new SyncEngine(
			this.fs,
			this.persist,
			{ deviceId: `id-${name}`, deviceName: name, permanentSave, exclude: [], presenceWindowSec: 60 },
			{
				onRemoteDelete: (dev, p, kept) => this.notices.push(`${dev} deleted ${p}${kept ? ' (kept)' : ''}`),
				onProblems: (list) => this.problems.push(...list.map((x) => x.path)),
				confirmMassDelete: async () => {
					this.massDeleteAsked++;
					return this.massDeleteAnswer;
				},
				log: (m) => process.env.OBSYNCHER_TEST_VERBOSE && console.log(`[${name}] ${m}`),
			},
		);
	}

	async init(): Promise<this> {
		await fs.rm(this.fs.root, { recursive: true, force: true });
		await fs.mkdir(this.fs.root, { recursive: true });
		await this.engine.init();
		return this;
	}

	async connect(): Promise<void> {
		this.client = await connect();
		const sftp = await Sftp.open(this.client);
		const store = await RemoteStore.open(sftp, this.remoteDir, `id-${this.name}`);
		await this.engine.attach(store);
	}

	disconnect(): void {
		this.engine.detach();
		this.client?.close();
	}

	async write(p: string, text: string, notify = true): Promise<void> {
		await this.fs.write(p, new TextEncoder().encode(text), tick());
		if (notify) this.engine.localChanged(p);
	}

	async del(p: string, notify = true): Promise<void> {
		const st = await this.fs.stat(p);
		await fs.rm(join(this.fs.root, p), { recursive: true, force: true });
		if (notify) this.engine.localDeleted(p, st?.type === 'folder');
	}

	async mv(from: string, to: string): Promise<void> {
		const st = await this.fs.stat(from);
		await this.fs.rename(from, to);
		this.engine.localRenamed(from, to, st?.type === 'folder');
	}

	async read(p: string): Promise<string | null> {
		try {
			return await fs.readFile(join(this.fs.root, p), 'utf8');
		} catch {
			return null;
		}
	}

	async tree(): Promise<string[]> {
		const { files } = await this.fs.list();
		return [...files.keys()].filter((p) => !p.startsWith('.')).sort();
	}

	async idle(): Promise<void> {
		await this.engine.whenIdle();
	}

	async poll(): Promise<void> {
		this.engine.poll();
		await this.engine.whenIdle();
	}
}

async function freshRemote(name: string): Promise<string> {
	const c = await connect();
	const s = await Sftp.open(c);
	const dir = `${await s.realpath('.')}/.obsyncher-test/vault-${name}`;
	await s.rmrf(dir);
	c.close();
	return dir;
}

async function devices(tag: string, names: string[], permanent: string[] = []): Promise<Device[]> {
	const dir = await freshRemote(tag);
	return Promise.all(names.map((n) => new Device(n, dir, permanent.includes(n)).init()));
}

function scenario(name: string, fn: () => Promise<Device[] | void>): void {
	test(name, async (t) => {
		if (!(await avail)) return t.skip('test sshd not reachable (see test/sshd/start-wsl-sshd.sh)');
		try {
			await fn();
		} finally {
			for (const d of live.splice(0)) d.disconnect();
		}
	});
}

scenario('initial sync: files flow both ways, hidden paths stay local', async () => {
	const [a, b] = await devices('initial', ['A', 'B']);
	await a.write('notes/one.md', 'one', false);
	await a.write('two.md', 'two', false);
	await a.write('.obsidian/workspace.json', '{}', false);
	await b.write('fromB.md', 'b', false);
	await a.connect();
	await b.connect();
	await a.poll();
	assert.deepEqual(await a.tree(), ['fromB.md', 'notes/one.md', 'two.md']);
	assert.deepEqual(await b.tree(), ['fromB.md', 'notes/one.md', 'two.md']);
	assert.equal(await b.read('.obsidian/workspace.json'), null);
	return [a, b];
});

scenario('live edit, create, delete propagate; delete shows a notice', async () => {
	const [a, b, c] = await devices('live', ['A', 'B', 'C']);
	await a.write('x.md', 'v1', false);
	for (const d of [a, b, c]) await d.connect();
	await a.write('x.md', 'v2');
	await a.idle();
	await b.poll();
	await c.poll();
	assert.equal(await b.read('x.md'), 'v2');
	assert.equal(await c.read('x.md'), 'v2');

	await b.write('dir/new.md', 'new');
	await b.idle();
	await a.poll();
	await c.poll();
	assert.equal(await a.read('dir/new.md'), 'new');
	assert.equal(await c.read('dir/new.md'), 'new');

	await c.del('x.md');
	await c.idle();
	await a.poll();
	await b.poll();
	assert.equal(await a.read('x.md'), null);
	assert.equal(await b.read('x.md'), null);
	assert.deepEqual(a.notices, ['C deleted x.md']);
	assert.deepEqual(b.notices, ['C deleted x.md']);
	assert.deepEqual(c.notices, []);
	return [a, b, c];
});

scenario('offline deletions do not produce notices', async () => {
	const [a, b] = await devices('offline', ['A', 'B']);
	await a.write('gone.md', 'x', false);
	await a.write('stay.md', 'y', false);
	await a.connect();
	await b.connect();
	b.disconnect();
	await a.del('gone.md');
	await a.idle();
	await b.connect();
	assert.equal(await b.read('gone.md'), null);
	assert.equal(await b.read('stay.md'), 'y');
	assert.deepEqual(b.notices, []);
	return [a, b];
});

scenario('same file edited on two devices: the later edit wins', async () => {
	const [a, b] = await devices('lww', ['A', 'B']);
	await a.write('n.md', 'base', false);
	await a.connect();
	await b.connect();
	// A edits first, B edits later (newer mtime) but A syncs first
	await a.write('n.md', 'from A', false);
	await b.write('n.md', 'from B (later)', false);
	a.engine.localChanged('n.md');
	await a.idle();
	b.engine.localChanged('n.md');
	await b.idle();
	await a.poll();
	assert.equal(await a.read('n.md'), 'from B (later)');
	assert.equal(await b.read('n.md'), 'from B (later)');

	// reverse: B edits earlier, A later; B syncs last -> A's newer edit still wins
	await b.write('n.md', 'B older', false);
	await a.write('n.md', 'A newer', false);
	a.engine.localChanged('n.md');
	await a.idle();
	b.engine.localChanged('n.md');
	await b.idle();
	await a.poll();
	assert.equal(await a.read('n.md'), 'A newer');
	assert.equal(await b.read('n.md'), 'A newer');
	return [a, b];
});

scenario('different files edited concurrently', async () => {
	const [a, b] = await devices('parallel', ['A', 'B']);
	await a.connect();
	await b.connect();
	await Promise.all([a.write('a.md', 'A'), b.write('b.md', 'B')]);
	await Promise.all([a.idle(), b.idle()]);
	await a.poll();
	await b.poll();
	assert.deepEqual(await a.tree(), ['a.md', 'b.md']);
	assert.deepEqual(await b.tree(), ['a.md', 'b.md']);
	return [a, b];
});

scenario('edit beats a concurrent delete', async () => {
	const [a, b] = await devices('editdel', ['A', 'B']);
	await a.write('f.md', 'v1', false);
	await a.connect();
	await b.connect();
	await a.del('f.md');
	await a.idle();
	await b.write('f.md', 'edited on B'); // before B saw the deletion
	await b.idle();
	await a.poll();
	assert.equal(await a.read('f.md'), 'edited on B');
	return [a, b];
});

scenario('rename and move of files and folders propagate', async () => {
	const [a, b] = await devices('rename', ['A', 'B']);
	await a.write('old.md', 'content', false);
	await a.write('folder/inner/deep.md', 'deep', false);
	await a.connect();
	await b.connect();
	await a.mv('old.md', 'moved/new.md');
	await a.idle();
	await b.poll();
	assert.equal(await b.read('old.md'), null);
	assert.equal(await b.read('moved/new.md'), 'content');

	await b.mv('folder', 'renamed');
	await b.idle();
	await a.poll();
	assert.equal(await a.read('renamed/inner/deep.md'), 'deep');
	assert.equal(await a.fs.stat('folder'), null);
	assert.deepEqual(await a.tree(), await b.tree());
	return [a, b];
});

scenario('Permanent save: keep deleted files, *.old on collision, re-upload when switched off', async () => {
	const [a, p] = await devices('permanent', ['A', 'P'], ['P']);
	await a.write('keep.md', 'original', false);
	await a.write('dir/k2.md', 'k2', false);
	await a.connect();
	await p.connect();
	assert.equal(await p.read('keep.md'), 'original');

	// A deletes -> P keeps the file, it lands in sync_ignore; notice mentions it was kept
	await a.del('keep.md');
	await a.del('dir');
	await a.idle();
	await p.poll();
	assert.equal(await p.read('keep.md'), 'original');
	assert.equal(await p.read('dir/k2.md'), 'k2');
	assert.ok(p.engine.ignoreList.includes('keep.md'));
	assert.ok(p.notices.some((n) => n.includes('keep.md') && n.includes('(kept)')));

	// A creates a new file with the same name -> P renames its kept copy to keep-1.old.md
	await a.write('keep.md', 'brand new');
	await a.idle();
	await p.poll();
	assert.equal(await p.read('keep.md'), 'brand new');
	assert.equal(await p.read('keep-1.old.md'), 'original');
	assert.ok(p.engine.ignoreList.includes('keep-1.old.md'));
	assert.ok(!p.engine.ignoreList.includes('keep.md'));

	// edits of the new file still sync both ways
	await p.write('keep.md', 'edited on P');
	await p.idle();
	await a.poll();
	assert.equal(await a.read('keep.md'), 'edited on P');
	assert.equal(await a.read('keep-1.old.md'), null);

	// switching Permanent save off clears sync_ignore and restores kept files everywhere
	await p.engine.setPermanentSave(false);
	await p.idle();
	assert.deepEqual(p.engine.ignoreList, []);
	await a.poll();
	assert.equal(await a.read('keep-1.old.md'), 'original');
	assert.equal(await a.read('dir/k2.md'), 'k2');
	return [a, p];
});

scenario('mass deletion guard: an emptied vault does not wipe the server', async () => {
	const [a, b] = await devices('guard', ['A', 'B']);
	for (let i = 0; i < 30; i++) await a.write(`n${i}.md`, `${i}`, false);
	await a.connect();
	a.disconnect();
	for (let i = 0; i < 30; i++) await a.del(`n${i}.md`, false);
	await a.connect(); // would delete 30 remote files -> asks, answer "no"
	assert.equal(a.massDeleteAsked, 1);
	assert.equal((await a.tree()).length, 30);
	await b.connect();
	assert.equal((await b.tree()).length, 30);
	return [a, b];
});

scenario('offline edits on both sides merge on reconnect', async () => {
	const [a, b] = await devices('merge', ['A', 'B']);
	await a.write('s.md', 'shared', false);
	await a.connect();
	await b.connect();
	b.disconnect();
	await a.write('a-only.md', 'a');
	await a.write('s.md', 'A edit');
	await a.idle();
	await b.write('b-only.md', 'b', false);
	await b.connect();
	await a.poll();
	assert.deepEqual(await a.tree(), ['a-only.md', 'b-only.md', 's.md']);
	assert.deepEqual(await b.tree(), ['a-only.md', 'b-only.md', 's.md']);
	assert.equal(await b.read('s.md'), 'A edit');
	return [a, b];
});

// ---- regressions: one bad item must never break the connection or the rest of the vault

async function onRemote<T>(fn: (s: Sftp) => Promise<T>): Promise<T> {
	const c = await connect();
	try {
		return await fn(await Sftp.open(c));
	} finally {
		c.close();
	}
}

const enc = (t: string) => new TextEncoder().encode(t);

scenario('a remote file with a name invalid on this OS is skipped, the rest syncs, connection stays', async () => {
	const [a] = await devices('badname', ['A']);
	const b = await new Device('B', a.remoteDir, false, true).init();
	await a.write('good.md', 'g', false);
	await a.write('z/after.md', 'z', false); // sorts after the bad one
	await a.connect();
	// created on the server, as a Linux device would (a ':' name is fine there)
	await onRemote((s) => s.writeFile(`${a.remoteDir}/bad:name.md`, enc('x')));
	await b.connect(); // used to reject and drop the connection -> endless reconnect loop
	assert.ok(b.engine.connected);
	assert.deepEqual(await b.tree(), ['good.md', 'z/after.md']);
	assert.deepEqual(b.problems, ['bad:name.md']);
	assert.deepEqual(b.engine.problemList.map((p) => p.path), ['bad:name.md']);
	// live sync keeps working, and the problem is not re-announced by every full sync
	await a.write('live.md', 'l');
	await a.idle();
	await b.poll();
	assert.equal(await b.read('live.md'), 'l');
	b.engine.requestFullSync();
	await b.idle();
	assert.deepEqual(b.problems, ['bad:name.md']);
	// nothing was deleted on the server because of the failure
	assert.ok(await onRemote((s) => s.exists(`${a.remoteDir}/bad:name.md`)));
	return [a, b];
});

scenario('names differing only by case do not overwrite each other', async () => {
	const [b] = await devices('case', ['B']);
	await onRemote(async (s) => {
		await s.mkdirp(b.remoteDir);
		await s.writeFile(`${b.remoteDir}/Note.md`, enc('upper'));
		await s.writeFile(`${b.remoteDir}/note.md`, enc('lower'));
	});
	await b.connect();
	assert.ok(b.engine.connected);
	assert.deepEqual(await b.tree(), ['Note.md']);
	assert.equal(await b.read('Note.md'), 'upper');
	assert.deepEqual(b.problems, ['note.md']);
	// and the server copy of the skipped one is untouched
	assert.equal(await onRemote(async (s) => new TextDecoder().decode((await s.readFile(`${b.remoteDir}/note.md`)).data)), 'lower');
	return [b];
});

scenario('an unreadable remote folder is reported and its local copy is NOT deleted', async () => {
	const [a, b] = await devices('perm', ['A', 'B']);
	await a.write('Locked/secret.md', 's', false);
	await a.write('open.md', 'o', false);
	await a.connect();
	await b.connect();
	assert.equal(await b.read('Locked/secret.md'), 's');
	await onRemote((s) => s.setstat(`${a.remoteDir}/Locked`, { permissions: 0 }));
	try {
		b.engine.requestFullSync();
		await b.idle();
		assert.ok(b.engine.connected);
		assert.equal(await b.read('Locked/secret.md'), 's');
		assert.deepEqual(b.problems, ['Locked']);
	} finally {
		await onRemote((s) => s.setstat(`${a.remoteDir}/Locked`, { permissions: 0o755 }));
	}
	return [a, b];
});

scenario('disconnect while a task runs does not trigger a reconnect request', async () => {
	const [a] = await devices('detach', ['A']);
	for (let i = 0; i < 30; i++) await a.write(`f${i}.md`, `${i}`, false);
	let lost = 0;
	a.engine.onDisconnect = () => lost++;
	await a.connect();
	for (let i = 0; i < 30; i++) await a.write(`f${i}.md`, `v2-${i}`);
	a.disconnect(); // user pressed "Reconnect" / closed settings mid-sync
	await a.idle();
	assert.equal(lost, 0);
	return [a];
});

scenario('a stale copy without base does not resurrect a file another device deleted', async () => {
	const [a, b] = await devices('stale', ['A', 'B']);
	await a.write('old.md', 'v1', false);
	await a.write('fresh.md', 'v1', false);
	await a.connect();
	await b.connect();
	// B gets copies it has no base for (e.g. put there by another tool), then A deletes both
	await b.idle();
	const bState = (b.engine as unknown as { state: { files: Record<string, unknown> } }).state;
	delete bState.files['old.md'];
	delete bState.files['fresh.md'];
	await a.del('old.md');
	await a.del('fresh.md');
	await a.idle();
	const deletedAt = Date.now();
	await b.fs.write('fresh.md', new TextEncoder().encode('edited after the delete'), deletedAt + 60000);
	await b.poll();
	assert.equal(await b.read('old.md'), null); // stale copy removed, not re-uploaded
	assert.equal(await b.read('fresh.md'), 'edited after the delete'); // newer edit wins over the delete
	await a.poll();
	assert.equal(await a.read('old.md'), null);
	assert.equal(await a.read('fresh.md'), 'edited after the delete');
	return [a, b];
});
