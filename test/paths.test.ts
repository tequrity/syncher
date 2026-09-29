import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PathFilter, oldName } from '../src/sync/paths';

test('*.old naming', () => {
	assert.equal(oldName('note.md', 1, false), 'note-1.old.md');
	assert.equal(oldName('dir/sub/a.b.png', 3, false), 'dir/sub/a.b-3.old.png');
	assert.equal(oldName('README', 2, false), 'README-2.old');
	assert.equal(oldName('folder', 1, true), 'folder-1.old');
});

test('filter: hidden paths and user patterns', () => {
	const f = new PathFilter(['Private/**', '*.tmp', '# comment', '']);
	for (const p of ['.obsidian/app.json', 'a/.git/x', '.syncher', 'Private', 'Private/x.md', 'x.tmp', 'a/b.tmp'])
		assert.ok(f.excluded(p), p);
	for (const p of ['note.md', 'Privateer/x.md', 'a/b.md', 'tmp.md']) assert.ok(!f.excluded(p), p);
});
