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
const reply = message => {
	if (message.method === 'list') return { jsonrpc: '2.0', id: message.id, result: {} };
	const [, object, method, args = {}] = message.params;
	let value = {};
	if (object === 'session') value = { access: true };
	else if (object === 'luci.opennds') value = { major: 11, version: '11.0.0' };
	else if (object === 'file') value = { entries: [] };
	else if (object === 'uci' && method === 'get') value = { values: args.config === 'opennds' ? { setup: settings } : {} };
	else if (object === 'uci' && method === 'set') { writes.push(args); Object.assign(settings, args.values); }
	else if (object === 'uci' && method === 'delete') { writes.push(args); for (const key of args.options || []) delete settings[key]; }
	return { jsonrpc: '2.0', id: message.id, result: [0, value] };
};
const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="/cascade.css"><div id="maincontent"><div id="view"></div></div>
<script src="/resources/cbi.js"></script><script src="/resources/luci.js"></script>
<script>
window._ = text => (${JSON.stringify(translations)})[text] || text;
document.addEventListener('luci-loaded', () => L.require('view.opennds.config').catch(error => { window.fixtureError=error.stack; }));
window.L = new LuCI({ base_url:'/resources', resource:'/resources', scriptname:'/cgi-bin/luci',
 ubuspath:'/ubus', sessionid:'fixture', requesttimeout:5, pollinterval:5, token:'fixture' });
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
			const source = name === 'view/opennds/config.js' ? path.join(app, 'htdocs/luci-static/resources', name) :
				name === 'opennds.js' ? path.join(app, 'htdocs/luci-static/resources/opennds.js') : path.join(assets, name);
			assert.ok(source.startsWith(app) || source.startsWith(path.resolve(assets)));
			res.setHeader('Content-Type', 'application/javascript'); res.end(fs.readFileSync(source)); return;
		}
		if (url.pathname === '/cascade.css') { res.setHeader('Content-Type', 'text/css'); res.end(fs.readFileSync(path.join(assets, 'cascade.css'))); return; }
		res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(html);
	} catch (error) { res.statusCode = 500; res.end(error.message); }
});
(async () => {
	await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
	let browser;
	const errors = [];
	try {
		browser = await chromium.launch({ executablePath: process.env.OPENNDS_BROWSER || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
		const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
		page.on('pageerror', error => errors.push(error.stack));
		await page.goto('http://127.0.0.1:' + server.address().port);
		await page.waitForSelector('.cbi-map', { timeout: 20000 });
		assert.equal(await page.evaluate(() => window.fixtureError), undefined);
		assert.deepEqual(writes, [], 'Rendering a real form must not write UCI');
		const field = name => page.locator('[id="widget.cbid.opennds.setup.' + name + '"]');
		const tab = async name => page.locator('.cbi-tabmenu').getByText(translations[name] || name, { exact: true }).click();
		const save = async () => {
			// A real Save click blurs the edited widget before LuCI replaces its DOM.
			await page.getByRole('button', { name: 'Save', exact: true }).focus();
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
		await field('authenticated_users').fill(rules);
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
		assert.deepEqual(errors, []);
		fs.writeFileSync(path.join(output, 'configuration-results.json'), JSON.stringify({ passed: true, browserVersion: browser.version(),
			checks: ['real LuCI form/UCI/RPC/validation', 'six tabs', 'read-only render', 'polling range', 'field dependencies',
				'native UCI set/delete', 'duplicate list ordering', 'encoded resources', 'hidden value retention', 'save and reload', '390px six-tab layout'],
			fixture: 'local ubus; DeviceSelect uses native form.Value', errors }, null, 2));
		console.log(JSON.stringify({ passed: true, writes: writes.length, output }));
	} finally { if (browser) await browser.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
