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
		: path.join(root, name), 'utf8');
const backendPath = 'root/usr/share/rpcd/ucode/opennds.uc';
const portalPath = '/etc/opennds/portal_theme.json';
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

function frontend(file, responses = {}) {
	const nodes = [], notifications = [], calls = [], polls = [];
	let removedPolls = 0;
	const text = node => node == null ? '' : typeof node === 'object' ? node.innerText : String(node);
	class Element {
		constructor(tag, attrs = {}, children = []) {
			this.tag = tag; this.attrs = attrs; this.children = []; this.style = {}; this.rows = []; this.cells = [];
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
		addEventListener() {}
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
	const view = new Function('view', 'dom', 'rpc', 'ui', 'poll', 'E', '_', 'L', 'document', read(views + file))(
		{ extend: value => value }, {}, rpc, ui, { add: fn => polls.push(fn), remove: () => { removedPolls++; } }, E, i18n, { url: value => value },
		{ getElementById: id => nodes.find(node => node.attrs.id === id) }
	);
	return { view, nodes, notifications, calls, polls, removedPolls: () => removedPolls, ui, text, button: label => nodes.find(node => node.tag === 'button' && (text(node) === label || text(node) === i18n(label))) };
}

function backend(options = {}) {
	const files = new Map([[portalPath, JSON.stringify({ title: 'Previous theme' })]]);
	const config = { '.name': 'cfg000001', faskey: 'device-specific-test-key', gatewayinterface: 'br-lan', ...options.config };
	const commands = [], updates = [], pending = [];
	const cursor = {
		load: () => !options.loadFails,
		foreach: (_, __, callback) => { if (!options.noSection) callback(config); },
		set: (_, __, key, value) => { updates.push({ key, value }); if (options.setFails) return false; config[key] = value; return true; },
		commit: () => !options.commitFails
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
			const response = options.command?.(command) || { code: 0, output: '' };
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
	const rawMethods = new Function('connect', 'open', 'access', 'mkdir', 'rename', 'unlink', 'uci', 'int', 'match', 'sprintf', 'trim', 'length', 'type', 'replace', 'json', 'split', 'push', 'index', 'die', 'fs_error', 'stat',
		read(backendPath).replace(/^import .*;\s*$/gm, ''))(
		connect, open, name => name === '/etc/opennds' ? !options.noDirectory : !options.missingTemplate, () => !options.mkdirFails, rename, name => files.delete(name), { cursor: () => cursor }, int,
		(value, pattern) => String(value).match(pattern.source === '[[:cntrl:]]' ? /[\x00-\x1f\x7f]/ : pattern), sprintf, value => value.trim(), value => typeof value === 'string' ? Buffer.byteLength(value) : value.length,
		type, (value, search, replacement) => value.split(search).join(replacement), JSON.parse, (value, separator) => value.split(separator), (array, value) => array.push(value), (value, search) => value.indexOf(search), message => { throw new Error(message); }, fs_error, stat
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

function configuration(config, values = {}, parseError) {
	const options = [], inputs = {};
	config['.name'] = 'cfg000001';
	const uci = {
		get: (_, __, name) => config[name],
		set: (_, __, name, value) => { config[name] = value; },
		unset: (_, __, name) => { delete config[name]; },
		sections: (_, __, callback) => callback(config)
	};
	const section = { tab() {}, taboption(_, type, name) {
		const option = { name, type, deps: [], depends(key, value) { this.deps.push({ key, value }); }, value() {},
			cfgvalue: () => config[name], formvalue: () => inputs[name] };
		options.push(option);
		return option;
	} };
	const form = { Map: class {
		section() { return section; }
		render() {
			for (const option of options) inputs[option.name] = Object.hasOwn(values, option.name) ? values[option.name] : option.cfgvalue(config['.name']) ?? option.default;
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
	}, Flag: 'Flag', Value: 'Value', ListValue: 'ListValue', DynamicList: 'DynamicList' };
	const view = new Function('view', 'form', 'uci', 'rpc', 'widgets', '_', read(views + 'config.js'))(
		{ extend: value => value }, form, uci, {}, {}, value => value);
	return view.render();
}

function statusHelper(mode, output, options = {}) {
	let stdout = '', closed = false;
	const commands = [];
	const popen = (command, mode) => {
		commands.push(command);
		assert.equal(mode, 'r');
		if (options.openFails) return null;
		return { read: size => { assert.equal(size, 'all'); return output; }, close: () => { closed = true; return options.code ?? 0; } };
	};
	const execute = new Function('ARGV', 'popen', 'die', 'type', 'json', 'length', 'printf', 'split', 'match',
		read('root/usr/libexec/luci-opennds-status.uc').replace(/^import .*;\s*$/gm, ''));
	execute([mode], popen, message => { throw new Error(message); },
		value => value == null ? 'null' : Array.isArray(value) ? 'array' : typeof value === 'number' ? Number.isInteger(value) ? 'int' : 'double' : typeof value,
		JSON.parse, value => value.length,
		(format, value) => { stdout += format.replace(/%[Js]/, token => token === '%J' ? JSON.stringify(value) : value); },
		(value, separator) => value.split(separator), (value, pattern) => value.match(pattern));
	return { stdout, commands, closed };
}

test('JavaScript, backend logic and JSON parse; shell scripts pass syntax checks', () => {
	for (const file of ['config.js', 'overview.js', 'studio.js']) new Function(read(views + file));
	for (const file of ['root/usr/share/rpcd/acl.d/luci-app-opennds.json', 'root/usr/share/luci/menu.d/luci-app-opennds.json', 'root/usr/share/ucitrack/luci-app-opennds.json']) JSON.parse(read(file));
	backend();
	for (const file of ['root/usr/lib/opennds/theme_luci.sh', 'root/etc/uci-defaults/80_luci-app-opennds', 'root/usr/libexec/luci-opennds-restart']) {
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
	const literals = (read(backendPath) + '\n' + read('root/usr/libexec/luci-opennds-status.uc')).matchAll(/match\([^,\n]+,\s*(\/(?:\\.|[^\/\n])+\/[gis]*)\)/g);
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
	new Function('view', 'form', 'uci', 'rpc', 'widgets', '_', read(views + 'config.js'))({ extend: value => value }, form, {}, {}, {}, value => value).render();
	for (const name of ['fasremotefqdn', 'fasremoteip', 'fasport', 'faspath', 'fas_secure_enabled', 'faskey', 'themespec_path']) assert.equal(options.find(option => option.name === name).retain, true, name);
	assert.equal(options.find(option => option.name === 'sessiontimeout').default, '1440');
	assert.equal(options.find(option => option.name === 'checkinterval').default, '15');
	assert.equal(options.find(option => option.name === 'login_option_enabled').default, '0');
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

test('JSON counters are converted from kB to MB and trusted entries are merged', () => {
	const source = read(views + 'overview.js');
	const helpers = new Function('rpc', '_', source.slice(0, source.indexOf('return view.extend')) + '\nreturn { parseClientCounters, clientArray };')({ declare: () => {} }, value => value);
	assert.deepEqual(helpers.parseClientCounters({ download_this_session: '2048', upload_this_session: '1024' }), { rxMB: '2.0', txMB: '1.0' });
	const clients = helpers.clientArray({ clients: { [fixture.mac]: fixture }, trusted: [fixture.mac.toUpperCase(), '02:00:00:00:00:02'] });
	assert.equal(clients.length, 2);
	assert.ok(clients.every(client => client.state === 'Trusted'));
	assert.equal(fixture.state, 'Preauthenticated', 'RPC data must not be mutated');
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

test('service apply uses restart and both ucitrack formats point to a non-init trigger', () => {
	const service = backend();
	service.methods.reload_service.call();
	assert.match(service.commands[0], /^timeout -s KILL 15 \/etc\/init.d\/opennds restart /);
	assert.equal(JSON.parse(read('root/usr/share/ucitrack/luci-app-opennds.json')).exec, '/usr/libexec/luci-opennds-restart');
	withTemporaryFiles(directory => {
		const init = path.join(directory, 'init.sh');
		fs.writeFileSync(init, 'printf "%s" "$1"\n');
		const script = read('root/usr/libexec/luci-opennds-restart');
		assert.ok(script.includes('/etc/init.d/opennds'));
		const result = spawnSync(shell, [], { input: script.replace('/etc/init.d/opennds', 'sh "$TEST_INIT"'), encoding: 'utf8', env: { ...process.env, TEST_INIT: shellPath(init) } });
		assert.equal(result.status, 0, result.stderr);
		assert.equal(result.stdout, 'restart');
	});
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
	const service = backend({ command: command => command.includes('pidof opennds') ? { code: 0, output: '321' } : command.includes('luci-opennds-status.uc json') ? { code: 0, output: JSON.stringify({ clients: { [fixture.mac]: fixture }, trusted: [] }) } : { code: 0, output: 'Version: test-version\nUptime: 2h 1m\nGateway Name: [ Guest &amp; Wi-Fi ]\nManaged interface: br-guest - IP address range: 192.0.2.0/24\nMHD Server [ version 1.0 ] listening on: http://192.0.2.1:2080\n' } });
	const result = service.methods.status.call();
	assert.equal(result.running, true);
	assert.equal(result.data.version, 'test-version');
	assert.equal(result.data.uptime, '2h 1m');
	assert.equal(result.data.interface, 'br-guest');
	assert.equal(result.data.gateway_port, '2080');
	assert.equal(result.data.gateway_name, 'Guest & Wi-Fi');
	assert.equal(result.data.clients[fixture.mac].ip, fixture.ip);
	assert.doesNotMatch(JSON.stringify(result), /device-specific-test-key/);
});

test('ndsctl failure does not incorrectly report a live daemon as stopped', () => {
	const service = backend({ command: command => command.includes('pidof opennds') ? { code: 0, output: '321' } : { code: 1, output: 'Unavailable' } });
	const result = service.methods.status.call();
	assert.equal(result.running, true);
	assert.match(result.error, /ndsctl/);
	assert.deepEqual(result.data.clients, {});
});

for (const failure of ['openFails', 'writeFails', 'flushFails', 'closeFails', 'renameFails']) {
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
	const service = backend({ config: { fasport: '443', faspath: '/fas/auth.php', fasremotefqdn: 'portal.example.invalid' } });
	assert.equal(service.methods.save_portal.call({ args: { config: theme() } }).code, 0);
	assert.equal(service.config.fasport, '0');
	assert.equal(service.config.luci_fasport, '443');
	assert.equal(service.config.faspath, '/fas/auth.php');
	assert.equal(service.config.fasremotefqdn, 'portal.example.invalid');
	assert.equal(service.methods.save_portal.call({ args: { config: theme() } }).code, 0);
	assert.equal(service.config.luci_fasport, '443', 'Repeated saves must not replace the saved port with zero');
});

for (const mode of ['1', '2', '3']) {
	test('configuration switches external FAS to local mode ' + mode + ' and restores its port', async () => {
		const config = { login_option_enabled: '0', fasport: '443', faspath: '/fas/auth.php', faskey: 'existing-device-key' };
		await configuration(config, { login_option_enabled: mode }).parse();
		assert.equal(config.fasport, '0');
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

test('FAS restoration respects changed and explicitly cleared port values', async () => {
	for (const port of ['8443', '0', '']) {
		const config = { login_option_enabled: '3', fasport: '0', luci_fasport: '443' };
		await configuration(config, { login_option_enabled: '0', fasport: port }).parse();
		assert.equal(config.fasport, port || undefined);
		assert.equal(config.luci_fasport, undefined);
	}
});

test('invalid gateway form input never normalizes or disables FAS', async () => {
	const config = { login_option_enabled: '0', fasport: '443' };
	await assert.rejects(configuration(config, { login_option_enabled: '3' }, 'Invalid input').parse(), /Invalid input/);
	assert.equal(config.fasport, '443');
	assert.equal(config.luci_fasport, undefined);
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

test('status compaction runs outside rpcd before command output reaches its buffer', () => {
	const service = backend({ command: command => command.includes('pidof') ? { code: 0, output: '321' } : { code: 0, output: '{"clients":{},"trusted":[]}' } });
	service.methods.status.call();
	assert.match(service.commands[1], /ucode \/usr\/libexec\/luci-opennds-status\.uc json/);
	assert.match(service.commands[2], /ucode \/usr\/libexec\/luci-opennds-status\.uc status/);
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
	const helper = statusHelper('json', raw);
	assert.ok(helper.closed);
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
	const service = backend({ command: command => command.includes('pidof') ? { code: 0, output: '321' } : command.includes('luci-opennds-status.uc json') ? { code: 0, output: helper.stdout } : { code: 0, output: 'Version: test-version' } });
	assert.equal(Object.keys(service.methods.status.call().data.clients).length, 1000);
});

test('large ndsctl status output emits only gateway metadata', () => {
	const metadata = 'Version: test-version\nUptime: 2h\nGateway Name: [ Guest ]\nManaged interface: br-guest\nMHD Server [ version 1.0 ] listening on: http://192.0.2.1:2050\n';
	const output = metadata + 'Client details and counters\n'.repeat(12000);
	assert.ok(Buffer.byteLength(output) > 256 * 1024);
	assert.equal(statusHelper('status', output).stdout, metadata);
});

test('status helper rejects invalid JSON, failed commands and unsupported modes', () => {
	for (const raw of ['broken', '[]', '{"clients":[]}', '{"trusted":{}}']) assert.throws(() => statusHelper('json', raw));
	for (const code of [1, -9]) assert.throws(() => statusHelper('json', '{}', { code }), /ndsctl json failed/);
	assert.throws(() => statusHelper('json', null), /ndsctl json failed/);
	assert.throws(() => statusHelper('json', '{}', { openFails: true }), /Unable to execute/);
	assert.throws(() => statusHelper('json; id', '{}'), /Unsupported/);
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
	assert.equal(page.querySelector('#opennds-log').innerText, i18n('Failed to read log'));
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

test('status waits for sequential asynchronous command replies before responding', () => {
	const service = backend({ command: command => command.includes('pidof') ? { code: 0, output: '321' } : command.includes('luci-opennds-status.uc json') ? { code: 0, output: '{"clients":{},"trusted":[]}' } : { code: 0, output: 'Version: test-version' } });
	const replies = [];
	service.rawMethods.status.call({ reply: result => replies.push(result) });
	assert.equal(service.commands.length, 1);
	service.pending.shift()();
	assert.equal(service.commands.length, 2);
	assert.equal(replies.length, 0);
	service.pending.shift()();
	assert.equal(service.commands.length, 3);
	assert.equal(replies.length, 0);
	service.pending.shift()();
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
		assert.equal(saved.saved, true);
		assert.equal(saved.applied, false);
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

test('html_escape and html_unescape are strict inverses for all HTML-significant characters', () => {
	const replace = (value, search, replacement) => value.split(search).join(replacement);
	const html_escape = new Function('replace', `return ${read(backendPath).match(/function html_escape\(value\) \{[\s\S]*?\n\}/)[0]}`)(replace);
	const html_unescape = new Function('replace', `return ${read(backendPath).match(/function html_unescape\(value\) \{[\s\S]*?\n\}/)[0]}`)(replace);
	const cases = [
		'Simple text',
		'Backtick ` and literal entity &#96;',
		'<script>alert("XSS")</script>',
		"Quote ' and double \" and ampersand &",
		'Nested &amp; already &lt;escaped&gt;',
		'All together: <a href="x" title=\'y\'>&test</a>',
		''  // empty string
	];
	for (const input of cases) {
		const escaped = html_escape(input);
		const roundtrip = html_unescape(escaped);
		assert.equal(roundtrip, input, 'roundtrip failed for: ' + JSON.stringify(input));
		if (input.includes('<')) assert.doesNotMatch(escaped, /<(?!$)/, 'raw < must not survive escape');
	}
});

function withTemporaryFiles(callback) {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'luci-opennds-test-'));
	try { callback(directory); }
	finally { for (const name of fs.readdirSync(directory)) fs.unlinkSync(path.join(directory, name)); fs.rmdirSync(directory); }
}

for (const customTrigger of ['', '/usr/bin/custom-opennds-apply']) {
test('initializer preserves daemon config and existing custom triggers: ' + (customTrigger || 'migrate old init entry'), () => {
	withTemporaryFiles(directory => {
		const config = path.join(directory, 'config'), template = path.join(directory, 'theme.sh'), trace = path.join(directory, 'uci-trace');
		const original = "config opennds\n\toption faskey 'existing-device-key'\n\toption gatewayinterface 'custom-guest'\n";
		fs.writeFileSync(config, original); fs.writeFileSync(template, '#!/bin/sh\n');
		const script = read('root/etc/uci-defaults/80_luci-app-opennds').replaceAll('/etc/config/opennds', '"$TEST_CONFIG"').replace('chmod 0755 /usr/lib/opennds/theme_luci.sh /usr/libexec/luci-opennds-restart', 'chmod 0755 "$TEST_THEME"').replaceAll('/etc/init.d/ucitrack', '"$TEST_UCITRACK"').replace('/etc/init.d/rpcd reload', 'true');
		const uci = `uci() {
printf '%s\\n' "$*" >> "$TEST_TRACE"
case "$*" in
"-q get ucitrack.@opennds[0]") printf opennds;;
"-q get ucitrack.@opennds[0].exec") printf '%s' "$TEST_CUSTOM_TRIGGER";;
"-q get ucitrack.@opennds[0].init") printf opennds;;
esac
return 0
}\n`;
		const result = spawnSync(shell, [], { input: uci + script, encoding: 'utf8', env: { ...process.env, TEST_CONFIG: shellPath(config), TEST_THEME: shellPath(template), TEST_TRACE: shellPath(trace), TEST_CUSTOM_TRIGGER: customTrigger } });
		assert.equal(result.status, 0, result.stderr || String(result.error));
		assert.equal(fs.readFileSync(config, 'utf8'), original);
		const calls = fs.readFileSync(trace, 'utf8');
		if (customTrigger) assert.doesNotMatch(calls, /set ucitrack/);
		else assert.match(calls, /set ucitrack\.@opennds\[0\]\.exec=\/usr\/libexec\/luci-opennds-restart/);
	});
});
}

test('real shell template escapes branding and tokens, and retains the native authentication callback', () => {
	withTemporaryFiles(directory => {
		const native = path.join(directory, 'native.sh');
		fs.writeFileSync(native, 'generate_splash_sequence() { continue_form; }\nlanding_page() { printf NATIVE_AUTH_CALLBACK; footer; }\n');
		const template = read('root/usr/lib/opennds/theme_luci.sh').replace('. /usr/lib/opennds/theme_click-to-continue-basic.sh', '. "$TEST_NATIVE"');
		const jsonfilter = `jsonfilter() {
case "$4" in
@.title) printf '%s' "$TEST_TITLE";;
@.subtitle) printf '%s' "$TEST_SUBTITLE";;
@.btnText) printf '%s' 'Connect';;
@.terms) printf '%s' 'Terms & privacy';;
@.footer) printf '%s' 'Guest footer';;
@.primaryColor) printf '%s' "$TEST_COLOR";;
@.logo) printf '%s' 'coffee';;
esac
}\n`;
		const env = { ...process.env, TEST_NATIVE: shellPath(native), TEST_TITLE: '<script>alert(1)</script> & "Wi-Fi"', TEST_SUBTITLE: 'literal $(echo INJECTED) and apostrophe\'', TEST_COLOR: '#123abc' };
		const execute = entry => spawnSync(shell, [], { input: template + '\n' + jsonfilter + '\nfas=\'token"&<\'\nheader\n' + entry, encoding: 'utf8', env });
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
	const jsonfilter = `jsonfilter() {
case "$4" in
@.title) printf '%s' "$TEST_TITLE";;
@.subtitle) printf Welcome;;
@.btnText) printf Connect;;
@.terms) printf '%s' "$TEST_TERMS";;
@.footer) printf Footer;;
@.primaryColor) printf '#0284c7';;
@.logo) printf wifi;;
esac
}\n`;
	const result = spawnSync(shell, [], { input: template + '\n' + jsonfilter + '\nfas=token\nheader\ngenerate_splash_sequence\n',
		encoding: 'utf8', env: { ...process.env, TEST_TITLE: config.title, TEST_TERMS: config.terms } });
	assert.equal(result.status, 0, result.stderr);
	assert.ok(Buffer.byteLength(result.stdout) < 10240);
	assert.equal((result.stdout.match(/&#96;/g) || []).length, 900, 'Title is rendered twice and terms once');
	assert.match(result.stdout, /<\/html>\s*$/);
});
