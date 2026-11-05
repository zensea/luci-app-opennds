const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { pathToFileURL } = require('node:url');
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');

const app = path.resolve(__dirname, '..');
const repository = path.resolve(app, '../..');
const shell = process.env.OPENNDS_TEST_SHELL || (process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/bash');
const read = file => fs.readFileSync(path.join(repository, file), 'utf8');

function run(command, args, cwd) {
	const result = spawnSync(command, args, { cwd, encoding: 'utf8' });
	assert.equal(result.status, 0, result.stderr || result.error?.message);
	return result.stdout.trim();
}
const git = (cwd, ...args) => run('git', ['-c', 'core.autocrlf=false', '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-C', cwd, ...args], cwd);

function temporary(callback) {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'opennds-workflow-'));
	try { return callback(directory); }
	finally {
		const absolute = path.resolve(directory);
		assert.ok(absolute.startsWith(path.resolve(os.tmpdir()) + path.sep));
		assert.ok(path.basename(absolute).startsWith('opennds-workflow-'));
		fs.rmSync(absolute, { recursive: true, force: true });
	}
}

function step(file, name) {
	const lines = read(file).split(/\r?\n/);
	const begin = lines.findIndex(line => line.trim() === '- name: ' + name);
	assert.ok(begin >= 0, name);
	const start = lines.findIndex((line, index) => index > begin && line.trim() === 'run: |');
	assert.ok(start > begin);
	let end = start + 1;
	while (end < lines.length && (!lines[end].trim() || lines[end].startsWith('          '))) end++;
	return lines.slice(start + 1, end).map(line => line.slice(10)).join('\n') + '\n';
}

function fixture(directory, oldPointer = false) {
	const official = path.join(directory, 'official');
	const source = path.join(directory, 'source');
	fs.mkdirSync(path.join(official, 'src'), { recursive: true });
	fs.mkdirSync(path.join(official, 'linux_openwrt/opennds'), { recursive: true });
	fs.writeFileSync(path.join(official, 'src/conf.h'), '#define VERSION "11.0.0"\n');
	fs.copyFileSync(path.join(repository, 'root/opennds/linux_openwrt/opennds/Makefile'), path.join(official, 'linux_openwrt/opennds/Makefile'));
	git(official, 'init', '-b', 'master');
	git(official, 'add', '.');
	git(official, 'commit', '-m', 'Original release');
	const original = git(official, 'rev-parse', 'HEAD');
	fs.writeFileSync(path.join(official, 'README'), 'Next release fixture\n');
	git(official, 'add', '.');
	git(official, 'commit', '-m', 'Next release');
	const next = git(official, 'rev-parse', 'HEAD');
	fs.mkdirSync(source);
	git(source, 'init', '-b', 'main');
	git(source, '-c', 'protocol.file.allow=always', 'submodule', 'add', pathToFileURL(official).href, 'root/opennds');
	const child = path.join(source, 'root/opennds');
	if (oldPointer) git(child, 'checkout', '--detach', original);
	const plugin = path.join(source, 'root/luci-app-opennds');
	fs.mkdirSync(plugin, { recursive: true });
	for (const file of ['Makefile', 'LICENSE', 'htdocs', 'root', 'po']) fs.cpSync(path.join(app, file), path.join(plugin, file), { recursive: true });
	git(source, 'add', '.');
	git(source, 'commit', '-m', 'Initial repository');
	const remote = path.join(directory, 'remote.git');
	fs.mkdirSync(remote);
	git(remote, 'init', '--bare', '--initial-branch=main');
	git(source, 'remote', 'add', 'origin', pathToFileURL(remote).href);
	git(source, 'push', 'origin', 'main');
	return { source, child, plugin, remote, original, next };
}

function sync(instance, directory, overrides = {}) {
	const output = path.join(directory, 'sync-output');
	fs.writeFileSync(output, '');
	const prelude = `gh() {
case "$2" in
  repos/openNDS/openNDS/releases/latest) printf '%s' "$TEST_RELEASE";;
  repos/openNDS/openNDS/commits/tags/v11.0.0) printf '%s' "$TEST_TARGET";;
  *) return 99;;
esac
}\n`;
	const result = spawnSync(shell, ['-s'], { cwd: instance.source, encoding: 'utf8',
		input: prelude + step('.github/workflows/sync-opennds.yml', 'Sync latest official release'),
		env: { ...process.env, DEFAULT_BRANCH: 'main', GITHUB_OUTPUT: output.replace(/\\/g, '/'),
			TEST_RELEASE: JSON.stringify({ tag_name: 'v11.0.0', draft: false, prerelease: false }), TEST_TARGET: instance.next, ...overrides } });
	return { ...result, output: fs.readFileSync(output, 'utf8') };
}

test('release synchronization changes only the submodule pointer, pushes it and skips repeated sync', () => temporary(directory => {
	const instance = fixture(directory, true);
	const result = sync(instance, directory);
	assert.equal(result.status, 0, result.stderr || result.error?.message);
	assert.equal(git(instance.child, 'rev-parse', 'HEAD'), instance.next);
	assert.equal(git(instance.source, 'diff', 'HEAD^', '--name-only'), 'root/opennds');
	const head = git(instance.source, 'rev-parse', 'HEAD');
	assert.equal(git(instance.remote, 'rev-parse', 'refs/heads/main'), head);
	assert.match(result.output, new RegExp('changed=true\\nref=' + head));
	const repeated = sync(instance, directory);
	assert.equal(repeated.status, 0, repeated.stderr);
	assert.match(repeated.output, /changed=false/);
	assert.equal(git(instance.source, 'rev-parse', 'HEAD'), head);
	assert.equal(fs.existsSync(path.join(instance.source, 'opennds.lock.json')), false);
}));

test('release synchronization rejects prereleases, invalid tags and invalid SHA without updating the repository', () => temporary(directory => {
	const instance = fixture(directory, true);
	const head = git(instance.source, 'rev-parse', 'HEAD');
	for (const overrides of [
		{ TEST_RELEASE: JSON.stringify({ tag_name: 'v11.0.0', draft: false, prerelease: true }) },
		{ TEST_RELEASE: JSON.stringify({ tag_name: 'v11.0.0', draft: true, prerelease: false }) },
		{ TEST_RELEASE: JSON.stringify({ tag_name: 'v11.0.0;echo unexpected', draft: false, prerelease: false }) },
		{ TEST_TARGET: 'not-a-commit' }
	]) {
		const result = sync(instance, directory, overrides);
		assert.notEqual(result.status, 0);
		assert.equal(git(instance.source, 'rev-parse', 'HEAD'), head);
		assert.equal(git(instance.child, 'rev-parse', 'HEAD'), instance.original);
	}
}));

test('SDK preparation archives the exact submodule HEAD and edits only a temporary recipe', () => temporary(directory => {
	const instance = fixture(directory);
	git(instance.child, 'remote', 'set-url', 'origin', 'https://github.com/openNDS/openNDS.git');
	const originalRecipe = fs.readFileSync(path.join(instance.child, 'linux_openwrt/opennds/Makefile'), 'utf8');
	const environment = path.join(directory, 'environment');
	fs.writeFileSync(environment, '');
	const result = spawnSync(shell, ['-s'], { cwd: directory, encoding: 'utf8',
		input: step('.github/workflows/build-opennds.yml', 'Prepare SDK feed'),
		env: { ...process.env, APP_DIR: instance.plugin.replace(/\\/g, '/'), OUTPUT_DIR: path.join(directory, 'artifacts').replace(/\\/g, '/'),
			GITHUB_ENV: environment.replace(/\\/g, '/'), GITHUB_REPOSITORY: 'fixture/repository', SDK_ARCH: 'aarch64_cortex-a53-openwrt-24.10', SDK_BRANCH: 'openwrt-24.10' } });
	assert.equal(result.status, 0, result.stderr || result.error?.message);
	const archiveName = 'opennds-11.0.0-' + instance.next + '.tar.gz';
	const archive = fs.readFileSync(path.join(directory, 'feed/.sources', archiveName));
	const hash = createHash('sha256').update(archive).digest('hex');
	const recipe = fs.readFileSync(path.join(directory, 'feed/opennds/Makefile'), 'utf8');
	assert.match(recipe, new RegExp('PKG_HASH:=' + hash));
	assert.ok(recipe.includes('PKG_SOURCE:=' + archiveName));
	assert.match(recipe, /PKG_SOURCE_URL:=file:\/\/\/feed\/\.sources/);
	assert.match(recipe, /PKG_BUILD_DIR:=\$\(BUILD_DIR\)\/opennds-\$\(PKG_VERSION\)/);
	assert.equal(fs.readFileSync(path.join(instance.child, 'linux_openwrt/opennds/Makefile'), 'utf8'), originalRecipe);
	assert.equal(git(instance.child, 'status', '--porcelain'), '');
	assert.match(fs.readFileSync(environment, 'utf8'), new RegExp('OPENNDS_SOURCE_SHA=' + instance.next));
	assert.equal(fs.existsSync(path.join(directory, 'feed/opennds/patches')), false);
}));
