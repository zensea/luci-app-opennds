// Real OpenWrt 24.10 form, ui, validation, UCI and RPC modules; local ubus fixture.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const { chromium } = require(process.env.OPENNDS_PLAYWRIGHT || 'playwright-core');
const app = path.resolve(__dirname, '..');
const assets = process.env.OPENNDS_CONFIG_ASSETS;
const output = process.env.OPENNDS_BROWSER_OUTPUT || path.resolve(app, '../artifacts/configuration-browser');
assert.ok(assets, 'OPENNDS_CONFIG_ASSETS must contain official LuCI 24.10 runtime modules');
fs.mkdirSync(output, { recursive: true });
const translations = Object.fromEntries([...fs.readFileSync(path.join(app, 'po/zh_Hans/opennds.po'), 'utf8')
	.matchAll(/msgid "([^\n]*)"\r?\nmsgstr "([^\n]*)"/g)].filter(m => m[1] && m[2]).map(m => [m[1], m[2]]));
const settings = { '.name': 'setup', '.type': 'opennds', '.anonymous': false, '.index': 0,
	enabled: '0', login_option_enabled: '0', fasport: '8443', fas_secure_enabled: '4', faskey: 'fixture-key',
	gatewayinterface: 'br-guest', uploadquota: '100', future_setting: 'keep',
	authenticated_users: ['block all to 192.0.2.10', 'allow all', 'allow all'],
	fas_custom_parameters_list: ['message=hello%20world'], statuspath: '/mnt/usb/status.sh' };
let writes = [];
let rawContent, pendingUci = false, expertRestartFailure = false;
const rawConfiguration = () => Object.entries(settings).filter(([key]) => !key.startsWith('.')).reduce((text, [key, value]) =>
	text + (Array.isArray(value) ? value : [value]).map(item => '\t' + (Array.isArray(value) ? 'list' : 'option') + ' ' + key + " '" + String(item).replaceAll("'", "'\\''") + "'\n").join(''), "config opennds 'setup'\n");
const reply = message => {
	if (message.method === 'list') return { jsonrpc: '2.0', id: message.id, result: {} };
	const [, object, method, args = {}] = message.params;
	let value = {};
	if (object === 'session') value = { access: true };
	else if (object === 'luci.opennds' && method === 'get_config') value = { content: rawContent ??= rawConfiguration() };
	else if (object === 'luci.opennds' && method === 'save_config') {
		if (args.original !== rawContent) value = { code: 1, message: 'Configuration changed; reload before saving' };
		else { rawContent = args.content; value = { code: args.apply && expertRestartFailure ? 1 : 0, saved: true, applied: args.apply && !expertRestartFailure, message: 'Configuration saved, but service restart failed' }; }
	}
	else if (object === 'luci.opennds') value = { major: 11, version: '11.0.0' };
	else if (object === 'file') value = { entries: [] };
	else if (object === 'uci' && method === 'get') value = { values: args.config === 'opennds' ? { setup: settings } : {} };
	else if (object === 'uci' && method === 'set') { writes.push(args); Object.assign(settings, args.values); }
	else if (object === 'uci' && method === 'delete') { writes.push(args); for (const key of args.options || []) delete settings[key]; }
	else if (object === 'uci' && method === 'changes') value = { changes: pendingUci ? { opennds: [['set', 'setup', 'gatewayname', 'Pending']] } : {} };
	return { jsonrpc: '2.0', id: message.id, result: [0, value] };
};
const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="/cascade.css"><div id="maincontent"><div id="view"></div></div>
<script src="/resources/cbi.js"></script><script src="/resources/luci.js"></script>
<script>
window._ = text => (${JSON.stringify(translations)})[text] || text;
document.addEventListener('luci-loaded', () => L.require('view.opennds.config').catch(error => { window.fixtureError=error.stack; }));
window.L = new LuCI({ base_url:'/resources', resource:'/resources', scriptname:'/cgi-bin/luci',
 ubuspath:'/ubus', sessionid:'fixture', requesttimeout:5, pollinterval:5, token:'fixture', nodespec:{ satisfied:true, readonly:false } });
</script>`;
const server = http.createServer(async (req, res) => {
	try {
		const url = new URL(req.url, 'http://localhost');
		if (req.method === 'POST') {
			let body = ''; for await (const chunk of req) body += chunk;
			const message = JSON.parse(body);
			res.setHeader('Content-Type', 'application/json');
			res.end(JSON.stringify(Array.isArray(message) ? message.map(reply) : reply(message))); return;
		}
		if (url.pathname === '/resources/tools/widgets.js') {
			res.end("'require baseclass'; 'require form'; return baseclass.extend({ DeviceSelect: form.Value });"); return;
		}
		if (url.pathname.startsWith('/resources/')) {
			const name = url.pathname.slice('/resources/'.length);
			const source = ['view/opennds/config.js', 'view/opennds/expert.js'].includes(name) ? path.join(app, 'htdocs/luci-static/resources', name) :
				name === 'opennds.js' ? path.join(app, 'htdocs/luci-static/resources/opennds.js') : path.join(assets, name);
			assert.ok(source.startsWith(app) || source.startsWith(path.resolve(assets)));
			res.setHeader('Content-Type', 'application/javascript'); res.end(fs.readFileSync(source)); return;
		}
		if (url.pathname === '/cascade.css') { res.setHeader('Content-Type', 'text/css'); res.end(fs.readFileSync(path.join(assets, 'cascade.css'))); return; }
		let document = url.searchParams.has('expert') ? html.replace('view.opennds.config', 'view.opennds.expert') : html;
		if (url.searchParams.has('readonly')) document = document.replace('readonly:false', 'readonly:true');
		res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(document);
	} catch (error) { res.statusCode = 500; res.end(error.message); }
});
(async () => {
	await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
	let browser;
	const errors = [];
	try {
		browser = await chromium.launch({ executablePath: process.env.OPENNDS_BROWSER || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
		const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
		page.on('dialog', dialog => dialog.accept());
		page.on('pageerror', error => errors.push(error.stack));
		await page.goto('http://127.0.0.1:' + server.address().port);
		await page.waitForSelector('.cbi-map', { timeout: 20000 });
		assert.equal(await page.evaluate(() => window.fixtureError), undefined);
		assert.deepEqual(writes, [], 'Rendering a real form must not write UCI');
		const field = name => page.locator('[id="widget.cbid.opennds.setup.' + name + '"]');
		const label = text => translations[text] || text;
		const tab = async name => page.locator('.cbi-tabmenu').getByText(translations[name] || name, { exact: true }).click();
		const save = async () => {
			// A real Save click blurs the edited widget before LuCI replaces its DOM.
			await page.getByRole('button', { name: label('Save'), exact: true }).focus();
			return page.evaluate(() => L.dom.findClassInstance(document.querySelector('.cbi-map')).save(null, true));
		};
		assert.equal(await page.locator('.cbi-tabmenu li').count(), 6);
		await tab('Authentication & FAS');
		assert.equal(await field('nat_traversal_poll_interval').isVisible(), true);
		await field('nat_traversal_poll_interval').fill('60');
		let failed = false;
		try { await save(); } catch { failed = true; }
		assert.equal(failed, true, 'Invalid polling interval must block native form save');
		assert.deepEqual(writes, [], 'Invalid form values must not reach ubus UCI writes');
		await field('nat_traversal_poll_interval').fill('59');
		await field('reauth_interval').fill('60');
		await field('fas_secure_enabled').selectOption('1');
		await page.waitForTimeout(50);
		assert.equal(await field('nat_traversal_poll_interval').isVisible(), false);
		await field('fas_secure_enabled').selectOption('4');
		assert.equal(await field('nat_traversal_poll_interval').inputValue(), '59');
		await tab('Access Control & Walled Garden');
		const rules = 'block all to 192.0.2.20\nallow all\nallow all';
		const ruleWidget = page.locator('[data-field="cbid.opennds.setup.authenticated_users"]');
		await ruleWidget.getByRole('textbox', { name: label('Destination IP or subnet'), exact: true }).first().fill('192.0.2.20');
		assert.equal(await page.evaluate(() => { const event = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(event); return event.defaultPrevented; }), true, 'Unsaved visual drafts must warn before navigation');
		await tab('Portal & Resources');
		assert.equal(await field('themespec_path').isVisible(), false);
		await field('max_page_size').fill('16384');
		await field('fas_custom_parameters_list').fill('message=hello%20world%27s');
		await tab('Advanced & Logging');
		await field('max_log_entries').fill('0');
		await field('log_mountpoint').fill('/mnt/usb');
		await field('fast_client_scan').selectOption('0');
		await save();
		assert.deepEqual(settings.authenticated_users, rules.split('\n'));
		assert.deepEqual(settings.fas_custom_parameters_list, ['message=hello%20world%27s']);
		assert.equal(settings.max_page_size, '16384');
		assert.equal(settings.reauth_interval, '60');
		assert.equal(settings.nat_traversal_poll_interval, '59');
		assert.equal(settings.max_log_entries, '0');
		assert.equal(settings.fast_client_scan, '0');
		assert.equal(settings.statuspath, '/mnt/usb/status.sh');
		assert.equal(settings.enabled, '0');
		assert.equal(settings.faskey, 'fixture-key');
		assert.equal(settings.future_setting, 'keep');
		// Round-trip through native LuCI UCI save/load and a new browser render.
		await page.reload(); await page.waitForSelector('.cbi-map');
		await tab('Access Control & Walled Garden');
		assert.equal(await field('authenticated_users').inputValue(), rules);
		await page.screenshot({ path: path.join(output, 'configuration-access.png'), fullPage: true });
		await tab('Authentication & FAS');
		await field('login_option_enabled').selectOption('1');
		await tab('Portal & Resources');
		assert.equal(await field('fas_custom_parameters_list').isVisible(), false);
		await save();
		assert.deepEqual(settings.fas_custom_parameters_list, ['message=hello%20world%27s']);
		assert.equal(settings.nat_traversal_poll_interval, '59');
		await tab('Authentication & FAS');
		await field('login_option_enabled').selectOption('3');
		await tab('Portal & Resources');
		assert.equal(await field('themespec_path').isVisible(), true);
		await field('fas_custom_parameters_list').fill('');
		await save();
		assert.equal(settings.fas_custom_parameters_list, undefined, 'Explicitly clearing a visible list must remove it');
		// Feature choices must control visibility and the real native values.
		await tab('Traffic Control & Quotas');
		await field('_luci_download_quota').selectOption('throttle');
		await field('downloadquota').fill('512000');
		await field('fup_download_throttle_rate').fill('128');
		await save();
		assert.equal(settings.downloadquota, '512000');
		assert.equal(settings.fup_download_throttle_rate, '128');
		assert.equal(Object.keys(settings).some(key => key.startsWith('_luci_')), false);
		await field('_luci_download_quota').selectOption('stop');
		await save();
		assert.equal(settings.fup_download_throttle_rate, '0');
		await field('_luci_download_quota').selectOption('0');
		await save();
		assert.equal(settings.downloadquota, '0');
		assert.equal(await field('downloadquota').isVisible(), false);
		await tab('Access Control & Walled Garden');
		await field('_luci_walledgarden').selectOption('1');
		await field('walledgarden_fqdn_list').fill('example.com');
		await field('walledgarden_fqdn_list').press('Enter');
		await field('walledgarden_port_list').fill('443');
		await field('walledgarden_port_list').press('Enter');
		await save();
		assert.deepEqual(settings.walledgarden_fqdn_list, ['example.com']);
		assert.deepEqual(settings.walledgarden_port_list, ['443']);
		await field('_luci_walledgarden').selectOption('0');
		await save();
		assert.equal(settings.walledgarden_fqdn_list, undefined);
		assert.equal(settings.walledgarden_port_list, undefined);
		const advanced = 'allow tcp port 443 from 192.0.2.0/24';
		settings.authenticated_users.push(advanced);
		await page.reload(); await page.waitForSelector('.cbi-map');
		await tab('Access Control & Walled Garden');
		await ruleWidget.getByRole('button', { name: label('Add rule'), exact: true }).click();
		const row = ruleWidget.locator('.opennds-rule-list > div').last();
		await row.getByRole('combobox', { name: label('Protocol'), exact: true }).selectOption('both');
		await row.getByRole('textbox', { name: label('Port or range'), exact: true }).fill('8010-8000');
		let ruleRejected = false;
		try { await save(); } catch { ruleRejected = true; }
		assert.equal(ruleRejected, true, 'Invalid visual ranges must block saving');
		await row.getByRole('textbox', { name: label('Port or range'), exact: true }).fill('8000-8010');
		await row.getByRole('textbox', { name: label('Destination IP or subnet'), exact: true }).fill('192.0.2.30');
		const device = page.locator('[data-field="cbid.opennds.setup.preemptivemac"]');
		await device.getByRole('button', { name: label('Add device'), exact: true }).click();
		await device.getByRole('textbox', { name: label('MAC address'), exact: true }).fill('02:00:00:00:00:01');
		await device.getByRole('textbox', { name: label('Session duration (minutes)'), exact: true }).fill('60');
		await device.getByRole('textbox', { name: label('Device note'), exact: true }).fill('room-1');
		await save();
		assert.deepEqual(settings.authenticated_users, [...rules.split('\n'), advanced,
			'allow tcp port 8000-8010 to 192.0.2.30', 'allow udp port 8000-8010 to 192.0.2.30']);
		assert.deepEqual(settings.preemptivemac, ['mac=02:00:00:00:00:01;sessiontimeout=60;custom=room-1']);
		await page.screenshot({ path: path.join(output, 'visual-rules.png'), fullPage: true, animations: 'disabled' });
		await page.setViewportSize({ width: 390, height: 844 });
		for (const name of ['General Settings', 'Authentication & FAS', 'Traffic Control & Quotas', 'Access Control & Walled Garden', 'Portal & Resources', 'Advanced & Logging']) {
			await tab(name);
			if (!await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)) {
				fs.writeFileSync(path.join(output, 'overflow.json'), JSON.stringify(await page.locator('*').evaluateAll(nodes => nodes.filter(node => node.getBoundingClientRect().right > innerWidth).slice(-12).map(node => ({ tag: node.tagName, id: node.id, class: node.className, width: node.getBoundingClientRect().width, text: node.innerText?.slice(0,160) }))), null, 2));
				await page.screenshot({ path: path.join(output, 'overflow.png'), fullPage: true });
			}
			assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, name + ': horizontal overflow');
		}
		await page.screenshot({ path: path.join(output, 'configuration-mobile.png'), fullPage: true });
		await page.setViewportSize({ width: 1280, height: 1000 });
		await tab('Portal & Resources');
		fs.writeFileSync(path.join(output, 'fields.json'), JSON.stringify(await page.locator('input,select,textarea').evaluateAll(nodes => nodes.map(node => ({ id: node.id, name: node.name, tag: node.tagName }))), null, 2));
		await page.screenshot({ path: path.join(output, 'configuration-desktop.png'), fullPage: true });
		await page.goto('http://127.0.0.1:' + server.address().port + '/?expert');
		try { await page.waitForSelector('textarea', { timeout: 10000 }); }
		catch (error) { console.error(await page.evaluate(() => ({ fixtureError: window.fixtureError, text: document.body.innerText })), errors); throw error; }
		const editor = page.getByRole('textbox', { name: label('openNDS configuration file'), exact: true });
		const original = await editor.inputValue();
		const edited = original + '# Expert draft\n';
		await editor.fill(edited);
		assert.equal(await page.evaluate(() => { const event = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(event); return event.defaultPrevented; }), true, 'Unsaved expert drafts must warn before navigation');
		pendingUci = true;
		await page.getByRole('button', { name: label('Save'), exact: true }).click();
		await page.getByRole('status').filter({ hasText: label('Apply or discard pending gateway changes before editing the file.') }).waitFor();
		assert.equal(rawContent, original);
		pendingUci = false;
		await page.getByRole('button', { name: label('Save'), exact: true }).click();
		await page.waitForFunction(() => !document.querySelector('textarea').disabled);
		assert.equal(rawContent, edited);
		assert.equal(await page.evaluate(() => { const event = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(event); return event.defaultPrevented; }), false, 'Saved expert content must not leave a dirty navigation guard');
		expertRestartFailure = true;
		await editor.fill(edited + '# Second draft\n');
		await page.getByRole('button', { name: label('Save and apply'), exact: true }).click();
		await page.getByRole('status').filter({ hasText: 'Configuration saved, but service restart failed' }).waitFor();
		assert.equal(rawContent, edited + '# Second draft\n');
		assert.equal(await editor.isEnabled(), true);
		await editor.fill(edited + '# Stale draft\n');
		rawContent += '# Other administrator\n';
		await page.getByRole('button', { name: label('Save'), exact: true }).click();
		await page.getByRole('status').filter({ hasText: 'Configuration changed; reload before saving' }).waitFor();
		assert.equal(await editor.inputValue(), edited + '# Stale draft\n');
		await page.setViewportSize({ width: 390, height: 844 });
		assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'Expert editor mobile overflow');
		await page.screenshot({ path: path.join(output, 'expert-mobile.png'), fullPage: true, animations: 'disabled' });
		await page.goto('http://127.0.0.1:' + server.address().port + '/?expert&readonly');
		await page.waitForSelector('textarea');
		assert.equal(await editor.getAttribute('readonly'), '');
		assert.equal(await page.getByRole('button', { name: label('Save'), exact: true }).isDisabled(), true);
		assert.deepEqual(errors, []);
		fs.writeFileSync(path.join(output, 'configuration-results.json'), JSON.stringify({ passed: true, browserVersion: browser.version(),
			checks: ['real LuCI form/UCI/RPC/validation', 'six tabs', 'read-only render', 'polling range', 'field dependencies',
				'native UCI set/delete', 'duplicate list ordering', 'encoded resources', 'hidden value retention', 'save and reload', '390px six-tab layout',
				'quota actions', 'website switches', 'visual rule validation', 'TCP/UDP expansion', 'advanced rule preservation', 'device builder',
				'expert pending UCI protection', 'expert save and partial failure', 'stale expert draft retention', 'expert mobile layout'],
			fixture: 'local ubus; DeviceSelect uses native form.Value', errors }, null, 2));
		console.log(JSON.stringify({ passed: true, writes: writes.length, output }));
	} finally { if (browser) await browser.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
