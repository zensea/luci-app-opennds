const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const views = 'htdocs/luci-static/resources/view/opennds/';
const read = name => fs.readFileSync(
	process.env.OPENNDS_TEST_VIEWS_DIR && name.startsWith(views)
		? path.join(process.env.OPENNDS_TEST_VIEWS_DIR, name.slice(views.length))
		: process.env.OPENNDS_TEST_VIEWS_DIR && name === 'htdocs/luci-static/resources/opennds.js'
			? path.resolve(process.env.OPENNDS_TEST_VIEWS_DIR, '../../opennds.js') : path.join(root, name), 'utf8');
const backendPath = 'root/usr/share/rpcd/ucode/opennds.uc';
const portalPath = '/etc/opennds/portal_theme.json';
const configPath = '/etc/config/opennds';
function findShell() {
	if (process.env.OPENNDS_TEST_SHELL) return process.env.OPENNDS_TEST_SHELL;
	if (process.platform !== 'win32') return '/bin/sh';
	const candidates = [
		'C:/Program Files/Git/bin/bash.exe',
		'C:/Program Files (x86)/Git/bin/bash.exe',
		path.join(process.env.LOCALAPPDATA || '', 'Programs/Git/bin/bash.exe')
	];
	for (const candidate of candidates) {
		if (candidate && fs.existsSync(candidate)) return candidate;
	}
	try {
		const which = spawnSync('where.exe', ['bash.exe'], { encoding: 'utf8' });
		if (which.status === 0 && which.stdout) {
			const found = which.stdout.split(/\r?\n/).find(p => p && fs.existsSync(p));
			if (found) return found;
		}
	} catch {}
	return 'C:/Program Files/Git/bin/bash.exe';
}
const shell = findShell();
const shellPath = value => process.platform === 'win32' ? value.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, drive) => '/' + drive.toLowerCase()) : value;

const poTranslations = {};
for (const m of read('po/zh_Hans/opennds.po').matchAll(/msgid "([\s\S]*?)"\r?\nmsgstr "([\s\S]*?)"/g)) {
	if (m[1] && m[2]) poTranslations[m[1]] = m[2];
}
const i18n = text => poTranslations[text] || text;

function common(rpc, ui, E, translate = i18n) {
	return new Function('baseclass', 'rpc', 'ui', 'E', '_', read('htdocs/luci-static/resources/opennds.js'))(
		{ extend: value => value }, rpc, ui, E, translate);
}

function frontend(file, responses = {}) {
	const nodes = [], notifications = [], calls = [], polls = [];
	const unloaded = [];
	let removedPolls = 0;
	const text = node => node == null ? '' : typeof node === 'object' ? node.innerText : String(node);
	class Element {
		constructor(tag, attrs = {}, children = []) {
			this.tag = tag; this.attrs = attrs; this.children = []; this.style = {}; this.rows = []; this.cells = [];
			this.events = Object.create(null);
			this.value = attrs.value ?? ''; nodes.push(this);
			for (const child of children ?? []) this.appendChild(child);
			if (tag === 'textarea') this.value = this.innerText;
		}
		get innerText() { return this.children.map(text).join(''); }
		set innerText(value) { this.children = [String(value)]; }
		appendChild(child) { this.children.push(child); if (this.tag === 'table' && child?.tag === 'tr') this.rows.push(child); return child; }
		insertRow() { return this.appendChild(new Element('tr')); }
		deleteRow(index) { const row = this.rows.splice(index, 1)[0]; this.children.splice(this.children.indexOf(row), 1); }
		insertCell() { const cell = new Element('td'); this.cells.push(cell); return this.appendChild(cell); }
		addEventListener(name, listener) { (this.events[name] ||= []).push(listener); }
		dispatch(name) { for (const listener of this.events[name] || []) listener({ currentTarget: this }); }
		querySelector(selector) {
			if (this.attrs.id === selector.slice(1)) return this;
			for (const child of this.children) { const found = child?.querySelector?.(selector); if (found) return found; }
			return null;
		}
	}
	const E = (tag, attrs, children) => new Element(tag, attrs, children);
	const rpc = { declare: declaration => (...args) => {
		calls.push({ method: declaration.method, args });
		try {
			const response = typeof responses[declaration.method] === 'function' ? responses[declaration.method](...args) : responses[declaration.method] ?? {};
			if (response instanceof Error) return Promise.reject(response);
			if (typeof response === 'number' && response !== 0 && declaration.reject)
				return Promise.reject(new Error('ubus status ' + response));
			const key = Object.keys(declaration.expect ?? {})[0];
			const value = key === '' ? response : response[key];
			return Promise.resolve(Object.prototype.toString.call(value) === Object.prototype.toString.call(declaration.expect[key]) ? value : declaration.expect[key]);
		} catch (error) { return Promise.reject(error); }
	} };
	const ui = { modal: false, showModal() { this.modal = true; }, hideModal() { this.modal = false; }, addNotification(_, node, level) { notifications.push({ level, text: text(node) }); } };
	const view = new Function('view', 'dom', 'rpc', 'ui', 'poll', 'E', '_', 'L', 'document', 'uci', 'nds', read(views + file))(
		{ extend: value => value }, {}, rpc, ui, { add: fn => polls.push(fn), remove: () => { removedPolls++; } }, E, i18n, { url: value => value },
		{ getElementById: id => nodes.find(node => node.attrs.id === id) }, { unload: name => unloaded.push(name) }, common(rpc, ui, E)
	);
	return { view, nodes, notifications, calls, polls, unloaded, removedPolls: () => removedPolls, ui, text, button: label => nodes.find(node => node.tag === 'button' && (text(node) === label || text(node) === i18n(label))) };
}

function backend(options = {}) {
	const files = new Map([[portalPath, JSON.stringify({ title: 'Previous theme' })]]);
	const config = { '.name': 'setup', '.type': 'opennds', '.anonymous': false, faskey: 'device-specific-test-key', gatewayinterface: 'br-lan', ...options.config };
	const serialize = () => (config['.anonymous'] ? 'config opennds' : "config opennds '" + config['.name'] + "'") + '\n' +
		Object.entries(config).filter(([key]) => !key.startsWith('.')).flatMap(([key, value]) => (Array.isArray(value) ? value : [value]).map(item =>
			'\t' + (Array.isArray(value) ? 'list' : 'option') + ' ' + key + " '" + String(item) + "'\n")).join('');
	files.set(configPath, options.configText ?? serialize());
	const commands = [], updates = [], pending = [];
	const cursor = {
		load: () => !options.loadFails,
		foreach: (_, type, callback) => {
			for (const section of options.sections || (options.noSection ? [] : [config]))
				if (!type || section['.type'] === type) callback(section);
		},
		changes: () => options.changes ?? {},
		rename: (_, __, name) => { if (options.sectionRenameFails) return false; config['.name'] = name; config['.anonymous'] = false; return true; },
		set: (_, __, key, value) => { updates.push({ key, value }); if (options.setFails) return false; config[key] = value; return true; },
		commit: () => {
			if (options.commitFails) return false;
			files.set(configPath, options.corruptCommit ? 'broken' : serialize());
			return true;
		}
	};
	const connect = () => options.connectionFails ? null : { defer(object, method, args, callback) {
		assert.equal(object, 'file');
		assert.equal(method, 'exec');
		assert.equal(args.command, '/bin/sh');
		assert.equal(args.params[0], '-c');
		const command = args.params[1];
		commands.push(command);
		if (options.deferFails) return null;
		pending.push(() => {
			let response = options.command?.(command) || { code: 0, output: '' };
			if (command.includes('/usr/bin/opennds -v') && !response.ubusStatus)
				response = options.versionResult || { code: 1, output: 'This is openNDS version ' + (options.version || '11.0.0') + '\n' };
			callback(response.ubusStatus || 0, { code: response.code, stdout: response.output, stderr: response.stderr });
		});
		return { deferred: true };
	} };
	let lastFsError = null;
	const fs_error = () => { const error = lastFsError; lastFsError = null; return error; };
	const open = (name, mode) => {
		if (mode === 'r') {
			// The SDK's ucode open() does not set fs.error() when open(2) fails.
			if (options.readOpenFails || !files.has(name)) return null;
			return { read: () => { if (options.readFails) { lastFsError = 'Input/output error'; return null; } return files.get(name); }, close: () => !options.readCloseFails };
		}
		if (options.openFails) return null;
		if (mode === 'wx' && files.has(name)) return null;
		if (mode === 'wx' && options.backupFails) return null;
		return {
			write: value => { files.set(name, value); return options.writeFails ? 0 : Buffer.byteLength(value); },
			flush: () => !options.flushFails,
			close: () => !options.closeFails
		};
	};
	const stat = name => {
		if (options.statError) { lastFsError = options.statError; return null; }
		if (!files.has(name)) { lastFsError = 'No such file or directory'; return null; }
		return { type: 'file' };
	};
	const rename = (from, to) => { if (options.renameFails) return false; files.set(to, files.get(from)); files.delete(from); return true; };
	const sprintf = (format, ...values) => format.replace(/%[Jsd]/g, token => token === '%J' ? JSON.stringify(values.shift()) : String(values.shift()));
	const type = value => value === null || value === undefined ? 'null' : Array.isArray(value) ? 'array' : typeof value;
	const int = value => Number.parseInt(value);
	const rawMethods = new Function('connect', 'open', 'access', 'mkdir', 'rename', 'unlink', 'uci', 'int', 'match', 'sprintf', 'trim', 'length', 'type', 'replace', 'json', 'split', 'push', 'index', 'die', 'fs_error', 'stat', 'keys', 'time',
		read(backendPath).replace(/^import .*;\s*$/gm, ''))(
		connect, open, name => name === '/etc/opennds' ? !options.noDirectory : !options.missingTemplate, () => !options.mkdirFails, rename, name => files.delete(name), { cursor: () => cursor }, int,
		(value, pattern) => String(value).match(pattern.source === '[[:cntrl:]]' ? /[\x00-\x1f\x7f]/ : pattern), sprintf, value => value.trim(), value => typeof value === 'string' ? Buffer.byteLength(value) : value.length,
		type, (value, search, replacement) => value.split(search).join(replacement), JSON.parse, (value, separator) => value.split(separator), (array, value) => array.push(value), (value, search) => value.indexOf(search), message => { throw new Error(message); }, fs_error, stat, Object.keys, () => 1793836800
	)['luci.opennds'];
	const flush = () => { while (pending.length) pending.shift()(); };
	// Drain the synthetic event loop for existing unit tests. Concurrency tests
	// use rawMethods and explicitly deliver pending replies instead.
	const methods = Object.fromEntries(Object.entries(rawMethods).map(([name, method]) => [name, {
		...method, call(request = {}) {
			let reply;
			const returned = method.call({ ...request, reply(value) { assert.equal(reply, undefined); reply = value; } });
			flush();
			return reply ?? returned;
		}
	}]));
	return { methods, rawMethods, pending, flush, files, config, commands, updates };
}

const theme = () => ({ title: '访客 Wi-Fi', subtitle: 'Welcome', logo: 'wifi', primaryColor: '#0284c7', btnText: '连接', terms: 'Read & accept the terms.', footer: 'Guest network' });
const fixture = { mac: '02:00:00:00:00:01', ip: '192.0.2.10', state: 'Preauthenticated' };
const running = () => ({ running: true, pid: '123', data: { clients: { [fixture.mac]: { ...fixture } }, interface: 'br-lan', gateway_port: '2050', version: 'test-version', uptime: '1m' } });
const click = button => button.attrs.click({ preventDefault() {}, currentTarget: button });

function configuration(config, values = {}, parseError, hints = { hosts: {} }, diagnostic = { major: 11 }) {
	const options = [], inputs = {}, rpcCalls = [];
	config['.name'] = config['.name'] || 'setup';
	const uci = {
		load: () => hints.uciFails ? Promise.reject(new Error('Unable to load UCI')) : Promise.resolve(config),
		get: (_, __, name) => config[name],
		set: (_, __, name, value) => { config[name] = value; },
		unset: (_, __, name) => { delete config[name]; },
		sections: (_, __, callback) => callback(config)
	};
	const section = { tab() {}, taboption(_, type, name, title, description) {
		const option = { name, type, description, choices: [], deps: [], depends(key, value) { this.deps.push({ key, value }); }, value(value, label) { this.choices.push({ value, label }); },
			cfgvalue: () => config[name], formvalue: () => inputs[name] };
		options.push(option);
		return option;
	} };
	const form = { Map: class {
		section() { return section; }
		render() {
			for (const option of options) inputs[option.name] = Object.hasOwn(values, option.name) ? values[option.name] : option.cfgvalue(config['.name']) ?? option.default;
			this.options = options; this.view = view; this.rpcCalls = rpcCalls;
			return this;
		}
		parse() {
			if (parseError) return Promise.reject(new Error(parseError));
			config.login_option_enabled = inputs.login_option_enabled;
			// Mirror LuCI: hidden retained fields are skipped; an active field
			// is only written when its form value differs from cfgvalue().
			const port = options.find(option => option.name === 'fasport');
			if (inputs.login_option_enabled === '0') {
				if (!inputs.fasport) delete config.fasport;
				else if (inputs.fasport !== port.cfgvalue(config['.name'])) config.fasport = inputs.fasport;
			}
			return Promise.resolve();
		}
	}, Flag: 'Flag', Value: 'Value', ListValue: 'ListValue', DynamicList: 'DynamicList', NamedSection: 'NamedSection' };
	const rpc = { declare: declaration => { rpcCalls.push(declaration); return () => declaration.method === 'check_config'
		? Promise.resolve(diagnostic) : hints.failed ? Promise.reject(new Error('Host hints unavailable')) : Promise.resolve(hints.hosts); } };
	const view = new Function('view', 'form', 'uci', 'rpc', 'widgets', '_', 'E', 'nds', read(views + 'config.js'))(
		{ extend: value => value }, form, uci, rpc, {}, value => value, (tag, attrs, children) => ({ tag, attrs, children }), common(rpc, {}, () => {}));
	return view.render([config, hints, diagnostic]);
}

function statusHelper(output, status = 'Version: test-version\n', options = {}) {
	let stdout = '', closed = 0;
	const commands = [];
	const popen = command => {
		commands.push(command);
		const mode = command.includes('ndsctl json') ? 'json' : 'status';
		if (options.openFails === mode) return null;
		return { read: () => mode === 'json' ? output : status, close: () => { closed++; return options[mode + 'Code'] ?? 0; } };
	};
	new Function('popen', 'die', 'type', 'json', 'length', 'printf', 'split', 'match', 'push', 'trim', 'join', 'sprintf',
		read('root/usr/libexec/luci-opennds-status.uc').replace(/^import .*;\s*$/gm, ''))(
		popen, message => { throw new Error(message); },
		value => value == null ? 'null' : Array.isArray(value) ? 'array' : typeof value === 'number' ? Number.isInteger(value) ? 'int' : 'double' : typeof value,
		JSON.parse, value => typeof value === 'string' ? Buffer.byteLength(value) : value.length,
		(format, value) => { stdout += format.replace('%s', value); }, (value, separator) => value.split(separator),
		(value, pattern) => value.match(pattern), (array, value) => array.push(value), value => value.trim(),
		(separator, array) => array.join(separator), (_, value) => JSON.stringify(value));
	return { stdout, commands, closed, data: JSON.parse(stdout) };
}

test('JavaScript, backend logic and JSON parse; shell scripts pass syntax checks', () => {
	for (const file of ['config.js', 'overview.js', 'studio.js']) new Function(read(views + file));
	new Function(read('htdocs/luci-static/resources/opennds.js'));
	for (const file of ['root/usr/share/rpcd/acl.d/luci-app-opennds.json', 'root/usr/share/luci/menu.d/luci-app-opennds.json', 'root/usr/share/ucitrack/luci-app-opennds.json']) JSON.parse(read(file));
	backend();
	for (const file of ['root/usr/lib/opennds/theme_luci.sh', 'root/etc/uci-defaults/80_luci-app-opennds', 'root/usr/libexec/luci-opennds-restart', 'tests/run-native.sh', 'tests/portal-shell.sh']) {
		const result = spawnSync(shell, ['-n', file], { cwd: root, encoding: 'utf8' });
		assert.equal(result.status, 0, result.stderr || String(result.error));
	}
});

test('menu aliases resolve through the path consumed by the LuCI dispatcher', () => {
	const menu = JSON.parse(read('root/usr/share/luci/menu.d/luci-app-opennds.json'));
	const action = menu['admin/services/opennds'].action;
	assert.equal(action.type, 'alias');
	assert.equal(typeof action.path, 'string', 'LuCI alias dispatch reads action.path');
	const request = [...action.path.split('/'), ...[]];
	assert.deepEqual(request, ['admin', 'services', 'opennds', 'overview']);
	const target = menu[request.join('/')];
	assert.equal(target.action.type, 'view');
	assert.ok(fs.existsSync(path.join(root, 'htdocs/luci-static/resources/view', target.action.path + '.js')));
});

test('backend regular expressions compile as POSIX ERE used by ucode', () => {
	const source = read(backendPath) + '\n' + read('root/usr/libexec/luci-opennds-status.uc');
	const literals = [...source.matchAll(/match\([^,\n]+,\s*(\/(?:\\.|[^\/\n])+\/[gis]*)\)/g),
		...source.matchAll(/\['[a-z_]+',\s*(\/(?:\\.|[^\/\n])+\/[gis]*)\]/g)];
	let checked = 0;
	for (const literal of literals) {
		const pattern = new Function('return ' + literal[1])().source.replaceAll('\\/', '/');
		const result = spawnSync(shell, ['-c', 'grep -E -- "$TEST_REGEX" </dev/null'], { encoding: 'utf8', env: { ...process.env, TEST_REGEX: pattern } });
		assert.equal(result.status, 1, pattern + ': ' + result.stderr);
		assert.equal(result.stderr, '', pattern);
		checked++;
	}
	assert.ok(checked >= 8);
});

test('packaging has no daemon config, shared key, trusted MAC samples or duplicate build invocation', () => {
	assert.equal(fs.existsSync(path.join(root, 'root/etc/config/opennds')), false);
	assert.doesNotMatch(read('root/etc/uci-defaults/80_luci-app-opennds'), /^\s*(?:option faskey|list trustedmac)/m);
	assert.doesNotMatch(read('Makefile'), /\$\(call BuildPackage/);
	assert.match(read('Makefile'), /^# call BuildPackage\b/m);
	assert.match(read('Makefile'), /\+jsonfilter/);
	assert.match(read('root/lib/upgrade/keep.d/luci-app-opennds'), /portal_theme\.json/);
});

test('form preserves hidden FAS values and uses daemon defaults', () => {
	const options = [];
	const section = { tab() {}, taboption(_, type, name) { const option = { name, type, deps: [], depends(key, value) { this.deps.push({ key, value }); }, value() {} }; options.push(option); return option; } };
	const form = { Map: class { section() { return section; } render() { return options; } }, Flag: 'Flag', Value: 'Value', ListValue: 'ListValue', DynamicList: 'DynamicList' };
	new Function('view', 'form', 'uci', 'rpc', 'widgets', '_', read(views + 'config.js'))({ extend: value => value }, form, { sections() {}, get() {} }, {}, {}, value => value).render();
	for (const name of ['fasremotefqdn', 'fasremoteip', 'fasport', 'faspath', 'fas_secure_enabled', 'faskey', 'themespec_path']) assert.equal(options.find(option => option.name === name).retain, true, name);
	assert.equal(options.find(option => option.name === 'sessiontimeout').default, '1440');
	assert.equal(options.find(option => option.name === 'checkinterval').default, '15');
	assert.equal(options.find(option => option.name === 'login_option_enabled').default, '1');
	assert.equal(options.find(option => option.name === 'fasport').default, undefined);
	assert.notEqual(options.find(option => option.name === 'gatewayport').validate('', '080'), true);

	// gatewayname: rejects single quotes and line breaks, accepts normal text
	const gatewayname = options.find(option => option.name === 'gatewayname');
	assert.notEqual(gatewayname.validate('', "Bill's Cafe"), true, 'single quote must be rejected');
	assert.notEqual(gatewayname.validate('', 'Line\nBreak'), true, 'newline must be rejected');
	assert.notEqual(gatewayname.validate('', 'Return\rChar'), true, 'carriage return must be rejected');
	assert.equal(gatewayname.validate('', 'Normal Gateway Name'), true, 'normal text must pass');
	assert.equal(gatewayname.validate('', ''), true, 'empty string must pass validation (rmempty handles it)');

	// faspath: must start with / and contain no spaces; empty is allowed
	const faspath = options.find(option => option.name === 'faspath');
	assert.equal(faspath.validate('', '/fas/auth.php'), true, 'valid path must pass');
	assert.equal(faspath.validate('', ''), true, 'empty path must pass');
	assert.notEqual(faspath.validate('', 'no-leading-slash'), true, 'path without leading / must be rejected');
	assert.notEqual(faspath.validate('', '/path with spaces'), true, 'path with spaces must be rejected');
});

test('trusted MAC picker reads host hints through the read-only LuCI RPC', async () => {
	const app = configuration({}, {}, null, { hosts: { [fixture.mac]: { name: 'Guest' } } });
	await app.view.load();
	assert.deepEqual(app.rpcCalls.find(call => call.method === 'getHostHints'),
		{ object: 'luci-rpc', method: 'getHostHints', reject: true, expect: { '': {} } });
	assert.ok(app.rpcCalls.some(call => call.method === 'check_config' && call.reject));
});

test('trusted MAC picker shows the device name or a single IP while preserving stored MAC spelling', () => {
	const mac = 'AA:BB:CC:DD:EE:02';
	const saved = mac.toLowerCase();
	const config = { trustedmac: [saved, fixture.mac] };
	const hosts = { [mac]: { name: 'Printer', ipaddrs: ['192.0.2.20'], ipv4: ['192.0.2.20', '192.0.2.21'], ip6addrs: ['2001:db8::20'] },
		[fixture.mac]: { ipv4: '192.0.2.10', ipv6: ['2001:db8::10'] } };
	const picker = configuration(config, {}, null, { hosts }).options.find(option => option.name === 'trustedmac');
	assert.equal(picker.type, 'DynamicList');
	assert.equal(picker.datatype, 'macaddr');
	assert.equal(picker.choices.length, 2);
	assert.equal(picker.choices.find(choice => choice.value === saved).label.children[0], saved + '(Printer)');
	assert.equal(picker.choices.find(choice => choice.value === fixture.mac).label.children[0], fixture.mac + '(192.0.2.10)');
	assert.deepEqual(config.trustedmac, [saved, fixture.mac]);
});

test('trusted MAC picker falls back to IPv6 or a bare MAC and has a localized unselected prompt', () => {
	for (const [host, detail] of [
		[{ name: '  ', ipaddrs: ['', null, '192.0.2.10', '192.0.2.11'] }, '(192.0.2.10)'],
		[{ ip6addrs: ['2001:db8::10', '2001:db8::11'] }, '(2001:db8::10)'],
		[{ ipv6: '2001:db8::10' }, '(2001:db8::10)'],
		[{}, '']
	]) {
		const picker = configuration({}, {}, null, { hosts: { [fixture.mac]: host } }).options.find(option => option.name === 'trustedmac');
		assert.equal(picker.choices[0].label.children[0], fixture.mac + detail);
		assert.equal(i18n(picker.placeholder), '-- 请选择 --');
		assert.equal(picker.default, undefined, 'the prompt must not become a saved MAC value');
	}
});

test('trusted MAC picker skips malformed records and deduplicates MAC addresses without case sensitivity', () => {
	const hosts = { 'AA:BB:CC:DD:EE:02': null, 'aa:bb:cc:dd:ee:02': { name: 'Valid after invalid record' },
		'AA:BB:CC:DD:EE:03': {}, 'aa:bb:cc:dd:ee:03': { name: 'Duplicate' },
		'00:11:22:33:44:55': 'invalid host', '00:11:22:33:44:66': [], 'not-a-mac': {} };
	const picker = configuration({}, {}, null, { hosts }).options.find(option => option.name === 'trustedmac');
	assert.deepEqual(picker.choices.map(choice => choice.value.toLowerCase()).sort(), ['aa:bb:cc:dd:ee:02', 'aa:bb:cc:dd:ee:03']);
});

test('trusted MAC picker renders untrusted hostnames as DOM text', () => {
	const name = '<img src=x onerror=alert(1)>';
	const picker = configuration({}, {}, null, { hosts: { [fixture.mac]: { name, ipaddrs: [fixture.ip] } } }).options.find(option => option.name === 'trustedmac');
	const label = picker.choices[0].label;
	assert.equal(label.tag, 'span');
	assert.equal(label.children.length, 1);
	assert.equal(typeof label.children[0], 'string');
	assert.ok(label.children[0].includes(name));
});

test('trusted MAC picker keeps manual entries when hints are empty or unavailable', async () => {
	for (const failed of [false, true]) {
		const config = { trustedmac: [fixture.mac] };
		const form = configuration(config, {}, null, { hosts: {}, failed });
		const picker = form.options.find(option => option.name === 'trustedmac');
		const data = await form.view.load();
		assert.equal(picker.choices.length, 0);
		assert.equal(picker.datatype, 'macaddr');
		assert.notEqual(picker.readonly, true);
		assert.deepEqual(config.trustedmac, [fixture.mac]);
		if (failed) {
			assert.equal(data[1].failed, true);
			assert.match(picker.description, /Failed to read discovered devices/);
		} else assert.doesNotMatch(picker.description, /Failed to read discovered devices/);
	}
});

test('host hint fallback does not hide UCI configuration load failures', async () => {
	await assert.rejects(configuration({}, {}, null, { hosts: {}, uciFails: true }).view.load(), /Unable to load UCI/);
});

test('host hints use a declared runtime dependency and a read-only ACL grant', () => {
	const acl = JSON.parse(read('root/usr/share/rpcd/acl.d/luci-app-opennds.json'))['luci-app-opennds'];
	assert.deepEqual(acl.read.ubus['luci-rpc'], ['getHostHints']);
	assert.equal(acl.write.ubus['luci-rpc'], undefined);
	assert.match(read('Makefile'), /\+rpcd-mod-luci\b/);
});

test('native v11 counters and indexed trusted MACs render without duplicate entries', () => {
	const app = frontend('overview.js');
	const data = { clients: { [fixture.mac]: { state: 'Authenticated', download_this_session: '2048', upload_this_session: '1024' } }, trusted: ['AA:BB:CC:DD:EE:FF', 'aa:bb:cc:dd:ee:ff'] };
	const page = app.view.render([{ running: true, data }, []]);
	const table = page.querySelector('#opennds-client-table');
	assert.equal(table.rows.length, 3);
	assert.match(table.rows[1].cells[4].innerText, /2.0 MB \/ ↑ 1.0 MB/);
	assert.equal(table.rows[2].cells[4].innerText, i18n('Trusted client (no traffic records)'));
	assert.equal(page.querySelector('#val-auth-count').innerText, '1');
});

for (const response of [{ code: 1, output: 'Client not found' }, new Error('RPC unavailable')]) {
	test('failed client action is reported as an error: ' + (response.message || response.output), async () => {
		const ui = frontend('overview.js', { client_action: response });
		ui.view.render([running(), []]);
		const button = ui.button('放行 (Auth)');
		await click(button);
		assert.equal(button.disabled, false);
		assert.deepEqual(ui.notifications.map(value => value.level), ['danger']);
		assert.equal(ui.calls.find(call => call.method === 'client_action').args[2], -1);
		assert.equal(ui.button('封禁 (Block)'), undefined);
	});
}

test('failed reload closes the modal and never reports success', async () => {
	const ui = frontend('overview.js', { reload_service: { code: 1, output: 'Reload failed' } });
	ui.view.render([running(), []]);
	await click(ui.button('重启服务'));
	assert.equal(ui.ui.modal, false);
	assert.deepEqual(ui.notifications.map(value => value.level), ['danger']);
});

test('stopped daemon clears clients, counters, PID, uptime and the running state', async () => {
	const ui = frontend('overview.js', { status: { running: false, data: {} }, get_log: { lines: ['New log entry'] } });
	const page = ui.view.render([running(), []]);
	const table = page.querySelector('#opennds-client-table');
	assert.equal(table.rows[1].cells[0].innerText, fixture.ip);
	await ui.polls[0]();
	assert.match(page.querySelector('#val-daemon-state').innerText, /Stopped/);
	assert.equal(page.querySelector('#val-auth-count').innerText, '0');
	assert.equal(page.querySelector('#val-preauth-count').innerText, '0');
	assert.equal(page.querySelector('#val-pid').innerText, 'PID: -');
	assert.equal(page.querySelector('#val-uptime').innerText, '-');
	assert.equal(page.querySelector('#opennds-log').innerText, 'New log entry');
	assert.doesNotMatch(table.innerText, /192\.0\.2\.10/);
});

test('RPC outage during polling displays unavailable instead of retaining old clients', async () => {
	const ui = frontend('overview.js', { status: new Error('RPC unavailable'), get_log: { lines: [] } });
	const page = ui.view.render([running(), []]);
	await ui.polls[0]();
	assert.equal(page.querySelector('#val-daemon-state').innerText, '无法获取状态');
	assert.equal(page.querySelector('#opennds-status-error').innerText, 'RPC unavailable');
	assert.doesNotMatch(page.querySelector('#opennds-client-table').innerText, /192\.0\.2\.10/);
});

for (const response of [{ code: 2, message: 'Write failed' }, new Error('RPC unavailable')]) {
	test('portal save failure restores the button and modal: ' + response.message, async () => {
		const ui = frontend('studio.js', { save_portal: response });
		ui.view.render({ exists: true, config: { ...theme(), footer: 'Saved footer' } });
		const button = ui.button('保存并生成门户模板');
		await click(button);
		assert.equal(button.disabled, false);
		assert.equal(ui.ui.modal, false);
		assert.deepEqual(ui.notifications.map(value => value.level), ['danger']);
		assert.equal(ui.calls[0].args[0].footer, 'Saved footer');
	});
}

test('successful action refreshes the list and respects the global timeout', async () => {
	const ui = frontend('overview.js', { client_action: { code: 0 }, status: running(), get_log: { lines: [] } });
	ui.view.render([running(), []]);
	await click(ui.button('放行 (Auth)'));
	assert.deepEqual(ui.notifications.map(value => value.level), ['success']);
	assert.ok(ui.calls.some(call => call.method === 'status'));
});

test('client action supports trust and sends correct action and MAC', async () => {
	const ui = frontend('overview.js', { client_action: { code: 0 }, status: running(), get_log: { lines: [] } });
	ui.view.render([running(), []]);
	const button = ui.button('设为信任');
	assert.ok(button, 'Trust button must be present for untrusted clients');
	await click(button);
	assert.deepEqual(ui.notifications.map(value => value.level), ['info']);
	const actionCall = ui.calls.find(call => call.method === 'client_action');
	assert.equal(actionCall.args[0], 'trust');
	assert.equal(actionCall.args[1], fixture.mac);
});

test('repeated render on overview does not leak poll listeners', () => {
	const ui = frontend('overview.js');
	ui.view.render([running(), []]);
	assert.equal(ui.polls.length, 1);
	assert.equal(ui.removedPolls(), 0);
	ui.view.render([running(), []]);
	assert.equal(ui.polls.length, 2);
	assert.equal(ui.removedPolls(), 1, 'Previous poller must be removed on subsequent render');
});

test('overview poll unregisters when view container is disconnected', async () => {
	const ui = frontend('overview.js', { status: running(), get_log: { lines: [] } });
	const page = ui.view.render([running(), []]);
	assert.equal(ui.removedPolls(), 0);
	page.isConnected = false;
	await ui.polls[0]();
	assert.equal(ui.removedPolls(), 1, 'Poller must be removed when viewContainer is disconnected');
});

test('successful portal save reports success and restores the controls', async () => {
	const ui = frontend('studio.js', { save_portal: { code: 0, saved: true, applied: true } });
	ui.view.render({ exists: true, config: theme() });
	const button = ui.button('保存并生成门户模板');
	await click(button);
	assert.deepEqual(ui.notifications.map(value => value.level), ['success']);
	assert.equal(ui.ui.modal, false);
	assert.equal(button.disabled, false);
});

test('backend rejects unsupported commands and shell injection without launching a process', () => {
	const service = backend();
	assert.notEqual(service.methods.client_action.call({ args: { action: 'block', mac: fixture.mac } }).code, 0);
	assert.notEqual(service.methods.client_action.call({ args: { action: 'auth', mac: fixture.mac + '; id' } }).code, 0);
	assert.equal(service.commands.length, 0);
});

test('service apply uses restart and the JSON ucitrack trigger', () => {
	assert.equal(JSON.parse(read('root/usr/share/ucitrack/luci-app-opennds.json')).exec, '/usr/libexec/luci-opennds-restart');
	assert.doesNotMatch(read('root/etc/uci-defaults/80_luci-app-opennds'), /uci -q/);
	assert.match(read('root/usr/libexec/luci-opennds-restart'), /\/etc\/init\.d\/opennds restart/);
});

test('backend preserves explicit zero duration and uses empty duration to inherit the daemon setting', () => {
	const service = backend();
	service.methods.client_action.call({ args: { action: 'auth', mac: fixture.mac, duration: 0 } });
	assert.match(service.commands.pop(), / 0 2>&1; exit \$\?$/);
	service.methods.client_action.call({ args: { action: 'auth', mac: fixture.mac, duration: -1 } });
	assert.match(service.commands.pop(), / "" 2>&1; exit \$\?$/);
	assert.notEqual(service.methods.client_action.call({ args: { action: 'auth', mac: fixture.mac, duration: -2 } }).code, 0);
	assert.notEqual(service.methods.client_action.call({ args: { action: 'auth', mac: fixture.mac, duration: 'invalid' } }).code, 0);
});

test('status combines daemon metadata and clients without exposing faskey', () => {
	const sample = statusHelper(JSON.stringify({ clients: { [fixture.mac]: fixture }, trusted: [] }),
		'Version: test-version\nUptime: 2h 1m\nGateway Name: [ Guest&#39;s &amp; Wi-Fi ]\nManaged interface: br-guest - IP address range: 192.0.2.0/24\nMHD Server [ version 1.0 ] listening on: http://192.0.2.1:2080\n');
	const service = backend({ command: command => command.includes('pidof') ? { code: 0, output: '321' } : { code: 0, output: sample.stdout } });
	const result = service.methods.status.call();
	assert.equal(result.running, true);
	assert.equal(result.data.version, 'test-version');
	assert.equal(result.data.uptime, '2h 1m');
	assert.equal(result.data.interface, 'br-guest');
	assert.equal(result.data.gateway_port, '2080');
	assert.equal(result.data.gateway_name, "Guest's &amp; Wi-Fi");
	assert.equal(result.data.clients[fixture.mac].ip, fixture.ip);
	assert.doesNotMatch(JSON.stringify(result), /device-specific-test-key/);
});

test('ndsctl failure does not incorrectly report a live daemon as stopped', () => {
	const service = backend({ command: command => command.includes('pidof opennds') ? { code: 0, output: '321' } : { code: 1, output: 'Unavailable' } });
	const result = service.methods.status.call();
	assert.equal(result.running, true);
	assert.match(result.error, /Unavailable/);
	assert.deepEqual(result.data.clients, {});
});

for (const failure of ['openFails', 'writeFails', 'closeFails', 'renameFails']) {
	test('portal ' + failure + ' preserves the previous theme and does not commit UCI', () => {
		const service = backend({ [failure]: true });
		const previous = service.files.get(portalPath);
		assert.notEqual(service.methods.save_portal.call({ args: { config: theme() } }).code, 0);
		assert.equal(service.files.get(portalPath), previous);
		assert.equal(service.updates.length, 0);
		assert.ok(!service.commands.some(command => command.includes('/etc/init.d/opennds')));
	});
}

test('portal commit and reload failures report partial success accurately', () => {
	const failedCommit = backend({ commitFails: true });
	const first = failedCommit.methods.save_portal.call({ args: { config: theme() } });
	assert.notEqual(first.code, 0); assert.equal(first.saved, true); assert.equal(first.applied, false);
	assert.ok(!failedCommit.commands.some(command => command.includes('/etc/init.d/opennds')));
	const failedReload = backend({ command: command => command.includes('/etc/init.d/opennds') ? { code: 1, output: 'Reload failed' } : { code: 0, output: '' } });
	const second = failedReload.methods.save_portal.call({ args: { config: theme() } });
	assert.notEqual(second.code, 0); assert.equal(second.saved, true); assert.equal(second.applied, false);
});

test('portal validation rejects invalid CSS and oversized input before changing files or UCI', () => {
	for (const invalid of [{ primaryColor: 'red;background:url(x)' }, { title: 'x'.repeat(121) }, { logo: '<svg>' }, { title: 'bad\nname' }, { terms: 'bad\x00terms' }]) {
		const service = backend();
		assert.notEqual(service.methods.save_portal.call({ args: { config: { ...theme(), ...invalid } } }).code, 0);
		assert.equal(service.updates.length, 0);
		assert.equal(service.commands.length, 0);
	}
});

test('successful portal save selects the installed ThemeSpec and preserves the device key', () => {
	const service = backend();
	const result = service.methods.save_portal.call({ args: { config: theme() } });
	assert.equal(result.code, 0);
	assert.equal(result.applied, true);
	assert.equal(service.config.login_option_enabled, '3');
	assert.equal(service.config.themespec_path, '/usr/lib/opennds/theme_luci.sh');
	assert.equal(service.config.faskey, 'device-specific-test-key');
	assert.deepEqual(JSON.parse(service.files.get(portalPath)), theme());
	assert.equal(service.files.has(portalPath + '.tmp'), false);
});

test('saving a local portal disables external FAS and preserves its port for switching back', () => {
	const service = backend({ config: { login_option_enabled: '0', fasport: '8443', faspath: '/fas/auth.php', fasremotefqdn: 'portal.example.invalid' } });
	assert.equal(service.methods.save_portal.call({ args: { config: theme() } }).code, 0);
	assert.equal(service.config.fasport, '443');
	assert.equal(service.config.luci_fasport, '8443');
	assert.equal(service.config.faspath, '/fas/auth.php');
	assert.equal(service.config.fasremotefqdn, 'portal.example.invalid');
	assert.equal(service.methods.save_portal.call({ args: { config: theme() } }).code, 0);
	assert.equal(service.config.luci_fasport, '8443', 'Repeated saves must not replace the saved port with the local initialization port');
});

for (const mode of ['1', '2', '3']) {
	test('configuration switches external FAS to local mode ' + mode + ' and restores its port', async () => {
		const config = { login_option_enabled: '0', fasport: '443', faspath: '/fas/auth.php', faskey: 'existing-device-key' };
		await configuration(config, { login_option_enabled: mode }).parse();
		assert.equal(config.fasport, '443');
		assert.equal(config.luci_fasport, '443');
		await configuration(config).parse();
		assert.equal(config.luci_fasport, '443', 'Saving a local mode again must preserve the external port');
		await configuration(config, { login_option_enabled: '0' }).parse();
		assert.equal(config.fasport, '443', 'Restore even when the displayed port did not change');
		assert.equal(config.luci_fasport, undefined);
		assert.equal(config.faspath, '/fas/auth.php');
		assert.equal(config.faskey, 'existing-device-key');
	});
}

test('FAS restoration respects changed ports and uses the v11 default when cleared', async () => {
	for (const port of ['8443', '']) {
		const config = { login_option_enabled: '3', fasport: '443', luci_fasport: '443' };
		await configuration(config, { login_option_enabled: '0', fasport: port }).parse();
		assert.equal(config.fasport, port || '443');
		assert.equal(config.luci_fasport, undefined);
	}
});

test('invalid gateway form input never normalizes or disables FAS', async () => {
	const config = { login_option_enabled: '0', fasport: '443' };
	await assert.rejects(configuration(config, { login_option_enabled: '3' }, 'Invalid input').parse(), /Invalid input/);
	assert.equal(config.fasport, '443');
	assert.equal(config.luci_fasport, undefined);
});

const v11 = { major: 11, version: '11.0.0' };
const legacyConfig = { '.name': 'cfg000001', '.anonymous': true };
const stopped = command => command.includes('pidof') ? { code: 1, output: '' } : { code: 0, output: '' };

test('non-v11 daemons cannot edit gateway settings or save a portal', async () => {
	for (const version of ['10.0.0', '12.0.0']) {
		const service = backend({ version });
		const original = service.files.get(portalPath);
		const diagnostic = service.methods.check_config.call();
		assert.match(diagnostic.error, /openNDS v11 is required/);
		await assert.rejects(configuration({}, {}, null, undefined, diagnostic).view.load(), /openNDS v11 is required/);
		assert.notEqual(service.methods.save_portal.call({ args: { config: theme() } }).code, 0);
		assert.equal(service.files.get(portalPath), original);
		assert.equal(service.updates.length, 0);
		assert.ok(!service.commands.some(command => command.includes('init.d/opennds restart')));
	}
});

test('configuration inspection rejects unnamed, missing and ambiguous sections without writing', () => {
	for (const options of [{ config: legacyConfig }, { noSection: true }, { loadFails: true },
		{ config: { '.name': 'custom' } }, { sections: [{ '.type': 'opennds', '.name': 'setup' }, { '.type': 'opennds', '.name': 'other' }] }]) {
		const service = backend(options), before = service.files.get(configPath);
		assert.ok(service.methods.check_config.call().error);
		assert.notEqual(service.methods.save_portal.call({ args: { config: theme() } }).code, 0);
		assert.equal(service.files.get(configPath), before);
		assert.equal(service.updates.length, 0);
	}
});
test('v11 gateway form uses native local FAS initialization and preserves the real external port', async () => {
	const config = { '.name': 'setup', login_option_enabled: '0', fasport: '8443', faskey: 'unchanged' };
	await configuration(config, { login_option_enabled: '3' }, null, undefined, v11).parse();
	assert.equal(config.fasport, '443');
	assert.equal(config.luci_fasport, '8443');
	await configuration(config, {}, null, undefined, v11).parse();
	assert.equal(config.luci_fasport, '8443', 'Local sentinel port must not replace the real external port');
	await configuration(config, { login_option_enabled: '0' }, null, undefined, v11).parse();
	assert.equal(config.fasport, '8443');
	assert.equal(config.luci_fasport, undefined);
	assert.equal(config.faskey, 'unchanged');
	const port = configuration(config, {}, null, undefined, v11).options.find(option => option.name === 'fasport');
	assert.notEqual(port.validate('setup', '0'), true);
	assert.equal(port.validate('setup', '443'), true);
	assert.equal(port.validate('setup', ''), true);
});

test('v11 designer preserves a stored FAS port and rejects an unnamed configuration', () => {
	const service = backend({ version: '11.0.0', config: { '.name': 'setup', '.anonymous': false, login_option_enabled: '3', fasport: '443', luci_fasport: '8443' } });
	assert.equal(service.methods.save_portal.call({ args: { config: theme() } }).code, 0);
	assert.equal(service.config.fasport, '443');
	assert.equal(service.config.luci_fasport, '8443');
	const legacy = backend({ config: legacyConfig });
	const before = legacy.files.get(portalPath);
	assert.notEqual(legacy.methods.save_portal.call({ args: { config: theme() } }).code, 0);
	assert.equal(legacy.files.get(portalPath), before);
});

test('configuration inspection is read-only and no upgrade RPC is exposed', () => {
	const acl = JSON.parse(read('root/usr/share/rpcd/acl.d/luci-app-opennds.json'))['luci-app-opennds'];
	assert.ok(acl.read.ubus['luci.opennds'].includes('check_config'));
	assert.ok(!acl.read.ubus['luci.opennds'].includes('upgrade_config'));
	assert.ok(!acl.write.ubus['luci.opennds'].includes('upgrade_config'));
	assert.equal(backend().methods.upgrade_config, undefined);
});

test('file writes use checked close instead of relying on the SDK flush return value', () => {
	const service = backend({ flushFails: true });
	assert.equal(service.methods.save_portal.call({ args: { config: theme() } }).code, 0);
	assert.doesNotMatch(read(backendPath), /fp\.flush\(/);
});

test('corrupt portal JSON rejects the designer load before defaults can be saved', async () => {
	const service = backend();
	service.files.set(portalPath, '{broken json');
	const app = frontend('studio.js', { get_portal: service.methods.get_portal.call() });
	await assert.rejects(app.view.load(), /Invalid portal JSON/);
	assert.ok(!app.calls.some(call => call.method === 'save_portal'));
	assert.equal(service.files.get(portalPath), '{broken json');
});

test('missing portal uses defaults while file access and read errors reject loading', async () => {
	const missing = backend();
	missing.files.delete(portalPath);
	assert.deepEqual(await frontend('studio.js', { get_portal: missing.methods.get_portal.call() }).view.load(), { exists: false });
	for (const options of [{ readOpenFails: true }, { readFails: true }, { readCloseFails: true }]) {
		const service = backend(options);
		const app = frontend('studio.js', { get_portal: service.methods.get_portal.call() });
		await assert.rejects(app.view.load(), /Unable to read portal configuration/);
		assert.equal(service.updates.length, 0);
	}
});

test('portal stat errors remain visible when open provides no error information', async () => {
	for (const reason of ['Permission denied', 'Not a directory', 'Input/output error']) {
		const service = backend({ readOpenFails: true, statError: reason });
		const previous = service.files.get(portalPath);
		const result = service.methods.get_portal.call();
		assert.match(result.error, new RegExp(reason));
		assert.notEqual(result.exists, false);
		assert.equal(service.files.get(portalPath), previous);
		assert.equal(service.updates.length, 0);
		await assert.rejects(frontend('studio.js', { get_portal: result }).view.load(), /Unable to read portal configuration/);
	}
});

test('backtick expansion is included in the portal size limit before any writes', () => {
	const service = backend();
	const previous = service.files.get(portalPath);
	assert.notEqual(service.methods.save_portal.call({ args: { config: { ...theme(), terms: '`'.repeat(2000) } } }).code, 0);
	assert.equal(service.files.get(portalPath), previous);
	assert.equal(service.updates.length, 0);
	assert.equal(service.commands.length, 0);
});

test('portal size accounts for both occurrences of the escaped title', () => {
	const service = backend({ config: { max_page_size: '6000' } });
	assert.notEqual(service.methods.save_portal.call({ args: { config: { ...theme(), title: "'".repeat(100), terms: 'A'.repeat(1000) } } }).code, 0);
	assert.equal(service.updates.length, 0);
});

test('log execution failures remain visible on initial load and polling', async () => {
	for (const command of [() => ({ code: 1, output: 'logread failed' }), () => ({ ubusStatus: 7 })]) {
		const service = backend({ command });
		const app = frontend('overview.js', { status: { running: false, data: {} }, get_log: service.methods.get_log.call({ args: { lines: 30 } }) });
		const page = app.view.render(await app.view.load());
		assert.match(page.querySelector('#opennds-log').innerText, new RegExp(i18n('Failed to read log')));
		await app.polls[0]();
		assert.match(page.querySelector('#opennds-log').innerText, new RegExp(i18n('Failed to read log')));
	}
});

test('status compaction runs once outside rpcd before command output reaches its buffer', () => {
	const service = backend({ command: command => command.includes('pidof') ? { code: 0, output: '321' } : { code: 0, output: '{"clients":{},"trusted":[],"metadata":{}}' } });
	service.methods.status.call();
	assert.equal(service.commands.length, 2);
	assert.match(service.commands[1], /ucode \/usr\/libexec\/luci-opennds-status\.uc /);
	assert.doesNotMatch(service.commands[1], /ndsctl (json|status)/);
});

test('1000 client records retain their counters and trusted MACs below the rpcd buffer limit', () => {
	const clients = {};
	for (let i = 0; i < 1000; i++) {
		const mac = '02:00:00:00:' + (i >> 8).toString(16).padStart(2, '0') + ':' + (i & 255).toString(16).padStart(2, '0');
		clients[mac] = { mac, ip: '192.0.2.10', state: 'Authenticated', session_start: '1793664000', download_this_session: String(i * 1024), upload_this_session: String(i * 512),
			gatewayname: 'Guest WiFi', gatewayaddress: '192.0.2.1:2050', version: 'test-version', token: 'private-token', custom: 'x'.repeat(600) };
	}
	const raw = JSON.stringify({ clients, trusted: Object.keys(clients) });
	assert.ok(Buffer.byteLength(raw) > 256 * 1024);
	const helper = statusHelper(raw);
	assert.equal(helper.closed, 2);
	assert.ok(Buffer.byteLength(helper.stdout) < 256 * 1024);
	assert.doesNotMatch(helper.stdout, /private-token|custom|gatewayaddress/);
	const compact = JSON.parse(helper.stdout);
	assert.equal(Object.keys(compact.clients).length, 1000);
	assert.deepEqual(compact.trusted, Object.keys(clients));
	for (const [mac, client] of Object.entries(clients)) {
		assert.equal(compact.clients[mac].ip, client.ip);
		assert.equal(compact.clients[mac].state, client.state);
		assert.equal(compact.clients[mac].session_start, client.session_start);
		assert.equal(compact.clients[mac].download_this_session, client.download_this_session);
		assert.equal(compact.clients[mac].upload_this_session, client.upload_this_session);
	}
	const service = backend({ command: command => command.includes('pidof') ? { code: 0, output: '321' } : command.includes('luci-opennds-status.uc') ? { code: 0, output: helper.stdout } : { code: 1, output: 'Unexpected command' } });
	assert.equal(Object.keys(service.methods.status.call().data.clients).length, 1000);
});

test('large ndsctl status output emits only gateway metadata', () => {
	const metadata = 'Version: test-version\nUptime: 2h\nGateway Name: [ Guest ]\nManaged interface: br-guest\nMHD Server [ version 1.0 ] listening on: http://192.0.2.1:2050\n';
	const output = metadata + 'Client details and counters\n'.repeat(12000);
	assert.ok(Buffer.byteLength(output) > 256 * 1024);
	assert.deepEqual(statusHelper('{}', output).data.metadata,
		{ version: 'test-version', uptime: '2h', gateway_name: 'Guest', interface: 'br-guest', gateway_port: '2050' });
});

test('status helper isolates JSON and metadata failures and enforces its output limit', () => {
	for (const raw of ['broken', '[]', '{"clients":[]}', '{"trusted":{}}']) {
		const result = statusHelper(raw).data;
		assert.match(result.error, /ndsctl json failed/);
		assert.equal(result.metadata.version, 'test-version');
		assert.deepEqual(result.clients, {});
	}
	const clients = JSON.stringify({ clients: { [fixture.mac]: fixture } });
	for (const failure of [{ statusCode: 1 }, { openFails: 'status' }]) {
		const result = statusHelper(clients, '', failure).data;
		assert.match(result.error, /ndsctl status failed/);
		assert.equal(result.clients[fixture.mac].ip, fixture.ip);
	}
	for (const failure of [{ jsonCode: -9 }, { openFails: 'json' }])
		assert.match(statusHelper('{}', '', failure).data.error, /ndsctl json failed/);
	assert.throws(() => statusHelper(JSON.stringify({ clients: { [fixture.mac]: { ip: 'x'.repeat(250000) } } })), /output limit/);
});

test('invalid max_page_size is reported before writing or reloading', () => {
	const service = backend({ config: { max_page_size: 'invalid' } });
	assert.notEqual(service.methods.save_portal.call({ args: { config: theme() } }).code, 0);
	assert.equal(service.updates.length, 0);
	assert.equal(service.commands.length, 0);
});

test('ubus status errors remain visible during initial load and polling', async () => {
	const app = frontend('overview.js', { status: 4, get_log: 4 });
	const page = app.view.render(await app.view.load());
	assert.equal(page.querySelector('#val-daemon-state').innerText, i18n('Status unavailable'));
	assert.match(page.querySelector('#opennds-status-error').innerText, /ubus status 4/);
	assert.equal(page.querySelector('#opennds-log').innerText, i18n('Failed to read log') + ': ubus status 4');
	await app.polls[0]();
	assert.equal(page.querySelector('#val-daemon-state').innerText, i18n('Status unavailable'));
	assert.match(page.querySelector('#opennds-status-error').innerText, /ubus status 4/);
});

test('portal read permission errors reject loading instead of selecting default branding', async () => {
	const app = frontend('studio.js', { get_portal: 4 });
	await assert.rejects(app.view.load(), /ubus status 4/);
});

test('ubus action and restart errors restore controls without success notifications', async () => {
	const app = frontend('overview.js', { client_action: 4, reload_service: 7 });
	app.view.render([running(), []]);
	const auth = app.button('Auth');
	await click(auth);
	assert.equal(auth.disabled, false);
	await click(app.button('Restart Service'));
	assert.equal(app.ui.modal, false);
	assert.deepEqual(app.notifications.map(n => n.level), ['danger', 'danger']);
});

test('ubus portal write errors restore controls without success notifications', async () => {
	const app = frontend('studio.js', { save_portal: 4 });
	app.view.render({ exists: true, config: theme() });
	const save = app.button('Save & Generate Portal');
	await click(save);
	assert.equal(save.disabled, false);
	assert.equal(app.ui.modal, false);
	assert.deepEqual(app.notifications.map(n => n.level), ['danger']);
});

test('pending command does not block portal reads or unrelated requests', () => {
	const service = backend();
	const replies = [];
	const deferred = service.rawMethods.reload_service.call({ reply: result => replies.push(result) });
	assert.equal(deferred.deferred, true);
	assert.equal(replies.length, 0, 'Restart must return before its command finishes');
	assert.equal(service.rawMethods.get_portal.call().exists, true);
	assert.equal(replies.length, 0, 'Portal read must finish while the restart is still pending');
	service.flush();
	assert.equal(replies.length, 1);
	assert.equal(replies[0].code, 0);
	assert.doesNotMatch(read(backendPath), /\bpopen\(/);
	for (const dependency of ['rpcd-mod-file', 'ucode-mod-ubus', 'coreutils-timeout']) assert.ok(read('Makefile').includes('+' + dependency));
});

test('overlapping restarts and portal saves are rejected without overwriting branding', () => {
	const service = backend();
	const replies = [];
	service.rawMethods.reload_service.call({ reply: result => replies.push(result) });
	const before = service.files.get(portalPath);
	assert.notEqual(service.rawMethods.save_portal.call({ args: { config: theme() } }).code, 0);
	assert.equal(service.files.get(portalPath), before);
	assert.equal(service.updates.length, 0);
	const overlapping = [];
	service.rawMethods.reload_service.call({ reply: result => overlapping.push(result) });
	assert.notEqual(overlapping[0].code, 0);
	assert.equal(service.commands.length, 1);
	service.flush();
	assert.equal(replies[0].code, 0);
	assert.equal(service.methods.save_portal.call({ args: { config: theme() } }).code, 0);
});

test('status waits for PID and the combined asynchronous sample before responding', () => {
	const service = backend({ command: command => command.includes('pidof') ? { code: 0, output: '321' } :
		{ code: 0, output: '{"clients":{},"trusted":[],"metadata":{"version":"test-version"}}' } });
	const replies = [];
	service.rawMethods.status.call({ reply: result => replies.push(result) });
	assert.equal(service.commands.length, 1);
	service.pending.shift()();
	assert.equal(service.commands.length, 2);
	assert.equal(replies.length, 0);
	service.pending.shift()();
	assert.equal(service.commands.length, 2);
	assert.equal(replies.length, 1);
	assert.equal(replies[0].data.version, 'test-version');
});

test('missing execution service and ubus timeouts are reported as failures', () => {
	for (const options of [{ connectionFails: true }, { deferFails: true }, { command: () => ({ ubusStatus: 7 }) }]) {
		const service = backend(options);
		const status = service.methods.status.call();
		assert.equal(status.unavailable, true);
		assert.notEqual(service.methods.reload_service.call().code, 0);
		const saved = service.methods.save_portal.call({ args: { config: theme() } });
		assert.notEqual(saved.code, 0);
		assert.notEqual(saved.saved, true);
		assert.equal(JSON.parse(service.files.get(portalPath)).title, 'Previous theme');
	}
});

test('portal apostrophes remain literal in JSON and safe in the daemon gateway name', () => {
	const service = backend();
	const config = { ...theme(), title: "Bill's & Jane's WiFi" };
	assert.equal(service.methods.save_portal.call({ args: { config } }).code, 0);
	assert.equal(service.config.gatewayname, 'Bill&#39;s & Jane&#39;s WiFi');
	assert.equal(JSON.parse(service.files.get(portalPath)).title, config.title);
});

test('portal directory creation failure preserves configuration and skips restart', () => {
	const service = backend({ noDirectory: true, mkdirFails: true });
	const previous = service.files.get(portalPath);
	assert.notEqual(service.methods.save_portal.call({ args: { config: theme() } }).code, 0);
	assert.equal(service.files.get(portalPath), previous);
	assert.equal(service.updates.length, 0);
	assert.equal(service.commands.length, 0);
});

test('get_log clamps out-of-range and invalid count parameters to the default', () => {
	const logOutput = 'test log line 1\ntest log line 2\n';
	for (const badCount of [0, -1, 501, 'abc', null, undefined]) {
		const service = backend({ command: () => ({ code: 0, output: logOutput }) });
		service.methods.get_log.call({ args: { lines: badCount } });
		assert.match(service.commands[0], / -l 50 /, 'count ' + JSON.stringify(badCount) + ' must fall back to 50');
	}
	const service = backend({ command: () => ({ code: 0, output: logOutput }) });
	service.methods.get_log.call({ args: { lines: 100 } });
	assert.match(service.commands[0], / -l 100 /, 'valid count 100 must be passed through');
});



function withTemporaryFiles(callback) {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'luci-opennds-test-'));
	try { callback(directory); }
	finally { for (const name of fs.readdirSync(directory)) fs.unlinkSync(path.join(directory, name)); fs.rmdirSync(directory); }
}

const readyGatewayDevice = { up: true, ipv4: true };
const initialInterfaceCases = [
	{ name: 'prefers guest and resolves its actual device',
		networks: { guest_other: { device: 'br-other', up: true }, guest: { device: 'phy0-ap1', up: true } },
		devices: { 'phy0-ap1': readyGatewayDevice, 'br-other': readyGatewayDevice, 'br-guest': readyGatewayDevice, 'br-lan': readyGatewayDevice }, expected: 'phy0-ap1' },
	{ name: 'recognizes a guest network suffix', networks: { wan: { device: 'eth1', up: true }, wifi_guest: { device: 'br-visitors', up: true } },
		devices: { eth1: readyGatewayDevice, 'br-visitors': readyGatewayDevice, 'br-lan': readyGatewayDevice }, expected: 'br-visitors' },
	{ name: 'uses the network assigned to the guest firewall zone', networks: { visitors: { device: 'br-visitors', up: true } },
		zones: [{ section: 'guest_zone', name: 'guest', networks: 'visitors' }],
		devices: { 'br-visitors': readyGatewayDevice, 'br-lan': readyGatewayDevice }, expected: 'br-visitors' },
	{ name: 'recognizes a ready br-guest device', devices: { 'br-guest': readyGatewayDevice, 'br-lan': readyGatewayDevice }, expected: 'br-guest' },
	{ name: 'falls back when the guest has only IPv6', networks: { guest: { device: 'br-guest', up: true } },
		devices: { 'br-guest': { up: true, ipv4: false }, 'br-lan': readyGatewayDevice }, expected: 'br-lan' },
	{ name: 'falls back when the guest is down', networks: { guest: { device: 'br-guest', up: false } },
		devices: { 'br-guest': { up: false, ipv4: true }, 'br-lan': readyGatewayDevice }, expected: 'br-lan' },
	{ name: 'does not choose WAN when no gateway is ready', networks: { wan: { device: 'eth1', up: true } },
		devices: { eth1: readyGatewayDevice }, expected: null },
	{ name: 'rejects a fallback without IPv4', devices: { 'br-lan': { up: true, ipv4: false } }, expected: null }
];

for (const scenario of initialInterfaceCases) {
test('initial interface selection: ' + scenario.name, () => {
	withTemporaryFiles(directory => {
		const functionsFile = path.join(directory, 'functions.sh'), networkFile = path.join(directory, 'network.sh');
		const quote = value => "'" + String(value).replaceAll("'", "'\\''") + "'";
		const assign = value => 'IFS= read -r "$1" <<\'MOCK_VALUE\'\n' + value + '\nMOCK_VALUE\n';
		const networks = Object.entries(scenario.networks || {}), zones = scenario.zones || [];
		const forNetwork = networks.map(([name]) => '"$1" ' + quote(name)).join('\n') || ':';
		const forZone = zones.map(zone => '"$1" ' + quote(zone.section)).join('\n') || ':';
		const zoneProperties = zones.flatMap(zone => [[zone.section + ':name', zone.name], [zone.section + ':network', zone.networks]]);
		const config = 'config_load() { mock_package="$1"; }\n' +
			'config_foreach() { case "$mock_package:$2" in\nnetwork:interface)\n' + forNetwork + '\n;;\nfirewall:zone)\n' + forZone + '\n;;\nesac\n}\n' +
			'config_get() { case "$2:$3" in\n' + zoneProperties.map(([key, value]) => quote(key) + ')\n' + assign(value) + ';;').join('\n') + '\n*) return 1;;\nesac\n}\n';
		const ipCases = Object.entries(scenario.devices).flatMap(([name, state]) => [
			["link show dev " + name, '3: ' + name + ': <BROADCAST,MULTICAST' + (state.up ? ',UP' : '') + '> mtu 1500\n'],
			["-4 addr show dev " + name, state.ipv4 ? '    inet 192.0.2.1/24 scope global ' + name + '\n' : '    inet6 fd00::1/64 scope global\n']
		]);
		const ip = 'ip() { case "$*" in\n' + ipCases.map(([key, value]) => quote(key) + ') printf %s ' + quote(value) + ';;').join('\n') + '\n*) return 1;;\nesac\n}\n';
		const network = 'network_is_up() { case "$1" in\n' + networks.map(([name, state]) => quote(name) + ') return ' + (state.up ? '0' : '1') + ';;').join('\n') + '\n*) return 1;;\nesac\n}\n' +
			'network_get_device() { case "$2" in\n' + networks.map(([name, state]) => quote(name) + ')\n' + assign(state.device) + ';;').join('\n') + '\n*) return 1;;\nesac\n}\n';
		fs.writeFileSync(functionsFile, config + ip); fs.writeFileSync(networkFile, network);
		const source = read('examples/initial/select-interface.sh').replace('. /lib/functions.sh', '. "$TEST_FUNCTIONS"').replace('. /lib/functions/network.sh', '. "$TEST_NETWORK_FUNCTIONS"');
		const result = spawnSync(shell, [], { input: source, encoding: 'utf8', env: { ...process.env, TEST_FUNCTIONS: shellPath(functionsFile), TEST_NETWORK_FUNCTIONS: shellPath(networkFile) } });
		if (scenario.expected) {
			assert.equal(result.status, 0, result.stderr || String(result.error));
			assert.equal(result.stdout.trim(), scenario.expected);
		} else {
			assert.notEqual(result.status, 0);
			assert.equal(result.stdout, '');
			assert.match(result.stderr, /No ready IPv4/);
		}
	});
});
}

for (const original of [null, '', "config opennds 'setup'\n\toption faskey 'keep-device-key'\n"]) {
	test('initializer preserves configuration and reloads JSON ucitrack: ' + (original === null ? 'missing' : original ? 'existing' : 'empty'), () => {
		withTemporaryFiles(directory => {
			const config = path.join(directory, 'opennds'), template = path.join(directory, 'theme.sh');
			const trigger = path.join(directory, 'ucitrack'), trace = path.join(directory, 'trace');
			if (original !== null) fs.writeFileSync(config, original);
			fs.writeFileSync(template, '');
			fs.writeFileSync(trigger, '#!/bin/sh\nprintf "%s" "$1" > "$TEST_TRACE"\n');
			fs.chmodSync(trigger, 0o755);
			const script = read('root/etc/uci-defaults/80_luci-app-opennds')
				.replaceAll('/etc/config/opennds', '"$TEST_CONFIG"')
				.replace('chmod 0755 /usr/lib/opennds/theme_luci.sh /usr/libexec/luci-opennds-restart', 'chmod 0755 "$TEST_THEME"')
				.replaceAll('/etc/init.d/ucitrack', '"$TEST_UCITRACK"').replace('/etc/init.d/rpcd reload', 'true');
			const result = spawnSync(shell, [], { input: script, encoding: 'utf8',
				env: { ...process.env, TEST_CONFIG: shellPath(config), TEST_THEME: shellPath(template), TEST_UCITRACK: shellPath(trigger), TEST_TRACE: shellPath(trace) } });
			assert.equal(result.status, 0, result.stderr);
			assert.equal(fs.readFileSync(config, 'utf8'), original || "config opennds 'setup'\n");
			assert.equal(fs.readFileSync(trace, 'utf8'), 'reload');
		});
	});
}

function portalExports(config) {
	const names = { title: 'portal_title', subtitle: 'portal_subtitle', btnText: 'portal_button', terms: 'portal_terms', footer: 'portal_footer', primaryColor: 'portal_color', logo: 'portal_logo' };
	return Object.entries(config).map(([field, value]) => 'export ' + names[field] + "='" + value.replaceAll("'", "'\"'\"'") + "';").join('\n');
}
const jsonfilterMock = 'jsonfilter() { printf "%s\\n" "$TEST_EXPORT"; }\n';

test('designer field events update the native DOM model and save all seven current values', async () => {
	const app = frontend('studio.js', { save_portal: { code: 0 } });
	const page = app.view.render({ exists: true, config: { ...theme(), terms: 'Stored\nterms' } });
	const inputs = Object.fromEntries(app.nodes.filter(node => node.name).map(node => [node.name, node]));
	assert.equal(Object.keys(inputs).length, 7);
	assert.equal(inputs.terms.value, 'Stored\nterms');
	const changed = { ...theme(), title: 'Updated title', subtitle: 'New notice', terms: 'Line one\nLine two', footer: 'New footer', btnText: 'Go', logo: 'hotel', primaryColor: '#654321' };
	for (const [name, value] of Object.entries(changed)) {
		inputs[name].value = value;
		inputs[name].dispatch(name === 'logo' ? 'change' : 'input');
	}
	for (const name of ['title', 'subtitle', 'terms', 'footer'])
		assert.equal(page.querySelector('#sim-' + name).innerText, changed[name]);
	assert.equal(page.querySelector('#sim-btn').innerText, 'Go');
	assert.equal(page.querySelector('#sim-btn').style.backgroundColor, '#654321');
	assert.equal(page.querySelector('#sim-logo-wrap').innerText, 'HOTEL');
	await click(app.button('Save & Generate Portal'));
	assert.deepEqual(app.calls.find(call => call.method === 'save_portal').args, [changed]);
});

test('client action factories retain distinct action and MAC closures for every state', async () => {
	const clients = {};
	['Preauthenticated', 'Authenticated', 'Trusted', 'Blocked'].forEach((state, i) => {
		clients['02:00:00:00:00:0' + (i + 1)] = { state };
	});
	const status = { running: true, data: { clients, trusted: [] } };
	const app = frontend('overview.js', { status, get_log: { lines: [] }, client_action: { code: 0 } });
	const page = app.view.render([status, []]);
	const rows = page.querySelector('#opennds-client-table').rows.slice(1);
	const expected = [['auth', 'trust'], ['trust', 'deauth'], ['untrust'], ['auth', 'trust']];
	for (let i = 0; i < rows.length; i++) {
		const buttons = rows[i].cells[5].children.filter(node => node && node.tag === 'button');
		assert.equal(buttons.length, expected[i].length);
		for (const button of buttons) await click(button);
	}
	assert.deepEqual(app.calls.filter(call => call.method === 'client_action').map(call => call.args),
		expected.flatMap((actions, i) => actions.map(action => [action, Object.keys(clients)[i], -1])));
});

test('shared action runner blocks double clicks and recovers from synchronous request errors', async () => {
	const app = frontend('studio.js'), button = { disabled: false };
	const api = common({ declare: () => () => {} }, app.ui, (tag, attrs, children) => ({ innerText: children.join('') }));
	let resolve, calls = 0;
	const operation = { title: 'Pending', message: 'Wait', success: 'Done', request: () => { calls++; return new Promise(done => { resolve = done; }); } };
	const event = { preventDefault() {}, currentTarget: button };
	const pending = api.run(event, operation);
	await Promise.resolve();
	await api.run(event, operation);
	assert.equal(calls, 1);
	assert.equal(button.disabled, true);
	resolve({ code: 0 });
	await pending;
	assert.equal(button.disabled, false);
	assert.equal(app.ui.modal, false);
	await api.run(event, { request() { throw new Error('Synchronous failure'); } });
	assert.equal(button.disabled, false);
	assert.equal(app.notifications.at(-1).level, 'danger');
	assert.match(app.notifications.at(-1).text, /Synchronous failure/);
});

test('backend preserves the successful half of a status sample and keeps configuration fallbacks', () => {
	for (const sample of [
		{ metadata: { version: '11.0.0' }, error: 'ndsctl json failed' },
		{ clients: { [fixture.mac]: fixture }, error: 'ndsctl status failed' }
	]) {
		const service = backend({ config: { gatewayinterface: 'br-guest' }, command: command => command.includes('pidof') ?
			{ code: 0, output: '321' } : { code: 0, output: JSON.stringify(sample) } });
		const result = service.methods.status.call();
		assert.equal(result.running, true);
		assert.equal(result.error, sample.error);
		assert.equal(result.data.interface, 'br-guest');
		assert.equal(result.data.version, sample.metadata?.version);
		assert.deepEqual(result.data.clients, sample.clients || {});
	}
});

test('real shell template escapes branding and tokens, and retains the native authentication callback', () => {
	withTemporaryFiles(directory => {
		const native = path.join(directory, 'native.sh');
		fs.writeFileSync(native, 'generate_splash_sequence() { continue_form; }\nlanding_page() { printf NATIVE_AUTH_CALLBACK; footer; }\n');
		const template = read('root/usr/lib/opennds/theme_luci.sh').replace('. /usr/lib/opennds/theme_click-to-continue-basic.sh', '. "$TEST_NATIVE"');
		const env = { ...process.env, TEST_NATIVE: shellPath(native), TEST_TITLE: '<script>alert(1)</script> & "Wi-Fi"', TEST_SUBTITLE: 'literal $(echo INJECTED) and apostrophe\'', TEST_COLOR: '#123abc' };
		const execute = entry => spawnSync(shell, [], { input: template + '\n' + jsonfilterMock + '\nfas=\'token"&<\'\nheader\n' + entry, encoding: 'utf8',
			env: { ...env, TEST_EXPORT: portalExports({ ...theme(), title: env.TEST_TITLE, subtitle: env.TEST_SUBTITLE, primaryColor: env.TEST_COLOR, logo: 'coffee' }) } });
		const result = execute('generate_splash_sequence\n');
		assert.equal(result.status, 0, result.stderr || String(result.error));
		assert.match(result.stdout, /&lt;script&gt;alert\(1\)&lt;\/script&gt; &amp; &quot;Wi-Fi&quot;/);
		assert.match(result.stdout, /literal \$\(echo INJECTED\) and apostrophe&#39;/);
		assert.match(result.stdout, /token&quot;&amp;&lt;/);
		assert.match(result.stdout, /name="landing" value="yes"/);
		assert.match(result.stdout, /background:#123abc/);
		assert.match(result.stdout, /CAFE/);
		assert.doesNotMatch(result.stdout, /<script>/);
		assert.match(execute('landing_page\n').stdout, /NATIVE_AUTH_CALLBACK/);
	});
});

test('accepted escape-heavy portal renders a complete page within the configured size', () => {
	const config = { ...theme(), title: '`'.repeat(100), terms: '`'.repeat(700) };
	assert.equal(backend().methods.save_portal.call({ args: { config } }).code, 0);
	const template = read('root/usr/lib/opennds/theme_luci.sh').replace('. /usr/lib/opennds/theme_click-to-continue-basic.sh', 'generate_splash_sequence() { continue_form; }');
	const result = spawnSync(shell, [], { input: template + '\n' + jsonfilterMock + '\nfas=token\nheader\ngenerate_splash_sequence\n',
		encoding: 'utf8', env: { ...process.env, TEST_EXPORT: portalExports(config) } });
	assert.equal(result.status, 0, result.stderr);
	assert.ok(Buffer.byteLength(result.stdout) < 10240);
	assert.equal((result.stdout.match(/&#96;/g) || []).length, 900, 'Title is rendered twice and terms once');
	assert.match(result.stdout, /<\/html>\s*$/);
});
