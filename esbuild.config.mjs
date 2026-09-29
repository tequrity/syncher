import esbuild from 'esbuild';
import builtins from 'builtin-modules';
import { readdirSync } from 'fs';

const mode = process.argv[2];
const prod = mode === 'production';

if (mode === 'test') {
	const entryPoints = readdirSync('test')
		.filter((f) => f.endsWith('.test.ts') || f.endsWith('.e2e.ts'))
		.map((f) => `test/${f}`);
	await esbuild.build({
		entryPoints,
		bundle: true,
		platform: 'node',
		format: 'cjs',
		target: 'node20',
		outdir: 'test-dist',
		outExtension: { '.js': '.cjs' },
		external: ['obsidian'],
		sourcemap: 'inline',
		logLevel: 'warning',
	});
} else {
	const ctx = await esbuild.context({
		banner: { js: '/* Obsyncher — SSH/SFTP live sync for Obsidian. Bundled by esbuild. */' },
		entryPoints: ['src/main.ts'],
		bundle: true,
		external: ['obsidian', 'electron', '@codemirror/*', '@lezer/*', ...builtins],
		format: 'cjs',
		target: 'es2020',
		platform: 'browser',
		logLevel: 'info',
		sourcemap: prod ? false : 'inline',
		treeShaking: true,
		minify: prod,
		outfile: 'main.js',
	});
	if (prod) {
		await ctx.rebuild();
		process.exit(0);
	} else {
		await ctx.watch();
	}
}
