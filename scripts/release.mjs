// Copies the production build into dist/obsyncher (committed, so devices can install without building).
// Refuses to release when the version is not the same everywhere or has no CHANGELOG entry:
// the version shown in the plugin must always tell which build a device runs.
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'fs';

const json = (f) => JSON.parse(readFileSync(f, 'utf8'));
const { version, minAppVersion } = json('manifest.json');
const problems = [];
if (json('package.json').version !== version) problems.push(`package.json version is not ${version}`);
if (json('versions.json')[version] !== minAppVersion) problems.push(`versions.json has no "${version}": "${minAppVersion}"`);
if (!readFileSync('CHANGELOG.md', 'utf8').includes(`## [${version}]`)) problems.push(`CHANGELOG.md has no "## [${version}]" section`);
if (problems.length) {
	console.error(`release refused (manifest.json version ${version}):\n  - ${problems.join('\n  - ')}`);
	process.exit(1);
}

const dst = 'dist/obsyncher';
mkdirSync(dst, { recursive: true });
for (const f of ['main.js', 'manifest.json', 'styles.css']) copyFileSync(f, `${dst}/${f}`);
writeFileSync('dist/VERSION', `${version}\n`);
console.log(`dist/obsyncher updated (v${version})`);
