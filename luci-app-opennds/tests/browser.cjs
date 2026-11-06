// Optional local check: uses a real browser and the official LuCI DOM factory;
// RPC responses are local fixtures, not a router or authentication test.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const playwrightModule = process.env.OPENNDS_PLAYWRIGHT || 'playwright-core';
const { chromium } = require(playwrightModule);
const { PNG } = require(path.join(path.dirname(require.resolve(playwrightModule)), 'lib/utilsBundle.js'));

const app = path.resolve(__dirname, '..');
const output = path.resolve(process.env.OPENNDS_BROWSER_OUTPUT || path.join(app, '../artifacts/browser'));
const assets = process.env.OPENNDS_LUCI_ASSETS;
assert.ok(assets, 'OPENNDS_LUCI_ASSETS must contain official openwrt-24.10 luci.js and cascade.css');
fs.mkdirSync(output, { recursive: true });
const luci = fs.readFileSync(path.join(assets, 'luci.js'), 'utf8');
const begin = luci.indexOf('const DOM = Class.singleton('), end = luci.indexOf('\n\t});', begin);
assert.ok(begin >= 0 && end > begin, 'Unable to locate official DOM factory');
const domFactory = luci.slice(begin, end + '\n\t});'.length) + '\nreturn DOM.create.bind(DOM);';
const pollBegin = luci.indexOf('const Poll = Class.singleton('), pollEnd = luci.indexOf('\n\t});', pollBegin);
assert.ok(pollBegin >= 0 && pollEnd > pollBegin, 'Unable to locate official poll loop');
const pollFactory = luci.slice(pollBegin, pollEnd + '\n\t});'.length) + '\nreturn Poll;';
const translations = Object.fromEntries([...fs.readFileSync(path.join(app, 'po/zh_Hans/opennds.po'), 'utf8')
	.matchAll(/msgid "([^\n]*)"\r?\nmsgstr "([^\n]*)"/g)].filter(m => m[1] && m[2]).map(m => [m[1], m[2]]));
const theme = { title: 'Guest Wi-Fi', subtitle: 'Welcome', logo: 'wifi', primaryColor: '#0284c7', btnText: 'Connect', terms: 'Stored\nterms', footer: 'Guest footer' };
const mac = '02:00:00:00:00:01';
const status = { running: true, pid: '123', data: { clients: { [mac]: { ip: '192.0.2.10', state: 'Preauthenticated', download_this_session: 2048, upload_this_session: 1024 } }, trusted: [], version: '11.0.0', interface: 'br-guest', gateway_name: 'Guest', gateway_port: '2050', uptime: '1h' } };
let failActions = false, saved, calls = [];
const html = `<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/cascade.css"><div id="maincontent"></div>
<script>
const translate = text => (${JSON.stringify(translations)})[text] || text;
const E = new Function('Class', 'domParser', 'LuCI', ${JSON.stringify(domFactory)})(
  { singleton: value => value }, new DOMParser(), { prototype: { error: function(_, message) { throw Error(message); } } });
const rpc = { declare: spec => (...args) => fetch('/rpc', { method:'POST', body:JSON.stringify({method:spec.method,args}) }).then(r=>r.json()).then(result=>{
  if(result.ubus_status) throw Error('ubus status '+result.ubus_status); return result;
}) };
const ui = { showModal(title, content) { this.hideModal(); const modal=E('div',{id:'modal'},[E('h3',{},[title])].concat(content)); document.body.appendChild(modal); },
  hideModal() { document.getElementById('modal')?.remove(); }, addNotification(_,node,level) {node.dataset.level=level;node.className='notification';document.body.appendChild(node);} };
const poll=new Function('Class','env','window','document',${JSON.stringify(pollFactory)})(
  {singleton:value=>value},{pollinterval:5},window,document);
poll.start();
window.activePollCount=()=>poll.queue.length;
(async()=>{
 const name=new URLSearchParams(location.search).get('view')||'studio';
 const baseline=new URLSearchParams(location.search).has('baseline');
 const common=await fetch('/source/opennds.js').then(r=>r.text());
 const nds=new Function('baseclass','rpc','ui','E','_',common)({extend:value=>value},rpc,ui,E,translate);
 const source=await fetch('/source/'+name+'.js'+(baseline?'?baseline=1':'')).then(r=>r.text());
 const view=new Function('view','dom','rpc','ui','poll','uci','E','_','L','document','nds',source)(
  {extend:value=>value},{},rpc,ui,poll,{unload(){}},E,translate,{url:value=>'/'+value},document,nds);
 const data=await view.load(); const page=view.render(data); document.getElementById('maincontent').appendChild(page); window.ready=true;
})().catch(error=>{window.fixtureError=error.stack;console.error(error);});
</script>`;

const server = http.createServer(async (req, res) => {
	try {
		const url = new URL(req.url, 'http://localhost');
		if (url.pathname === '/rpc') {
			let body = ''; for await (const data of req) body += data;
			const call = JSON.parse(body); calls.push(call);
			const result = call.method === 'status' ? status : call.method === 'get_log' ? { lines: [] } :
				call.method === 'get_portal' ? { exists: true, config: theme } : failActions ? { code: 1, message: 'Fixture failure' } : { code: 0 };
			if (call.method === 'save_portal' && !failActions) saved = call.args[0];
			res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(result)); return;
		}
		if (url.pathname === '/cascade.css') { res.setHeader('Content-Type', 'text/css'); res.end(fs.readFileSync(path.join(assets, 'cascade.css'))); return; }
		if (url.pathname.startsWith('/source/')) {
			const file = path.basename(url.pathname);
			assert.ok(['opennds.js', 'overview.js', 'studio.js'].includes(file));
			const root = url.searchParams.has('baseline') ? process.env.OPENNDS_BASELINE : app;
			assert.ok(root, 'Missing baseline directory');
			const resource = path.join(root, 'htdocs/luci-static/resources', file === 'opennds.js' ? file : 'view/opennds/' + file);
			res.setHeader('Content-Type', 'text/plain'); res.end(fs.readFileSync(resource)); return;
		}
		res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(html);
	} catch (error) { res.statusCode = 500; res.end(error.message); }
});

(async () => {
	await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
	let browser;
	const errors = [], findings = [];
	try {
		browser = await chromium.launch({ executablePath: process.env.OPENNDS_BROWSER || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
		const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
		page.on('pageerror', error => errors.push(error.message));
		const base = 'http://127.0.0.1:' + server.address().port;
		for (const view of ['studio', 'overview']) {
			for (const before of process.env.OPENNDS_BASELINE ? [true, false] : [false]) {
				await page.goto(base + '/?view=' + view + (before ? '&baseline=1' : ''));
				await page.waitForFunction(() => window.ready || window.fixtureError);
				assert.equal(await page.evaluate(() => window.fixtureError), undefined);
				await page.screenshot({ path: path.join(output, view + (before ? '-before' : '-after') + '.png'), fullPage: true });
			}
			if (process.env.OPENNDS_BASELINE) {
				const hash = suffix => createHash('sha256').update(fs.readFileSync(path.join(output, view + suffix + '.png'))).digest('hex');
				const image = suffix => PNG.sync.read(fs.readFileSync(path.join(output, view + suffix + '.png')));
				const before = image('-before'), after = image('-after');
				assert.equal(after.width, before.width); assert.equal(after.height, before.height);
				let changedPixels = 0, significantPixels = 0;
				for (let i = 0; i < before.data.length; i += 4) {
					const delta = Math.max(...[0, 1, 2, 3].map(channel => Math.abs(before.data[i + channel] - after.data[i + channel])));
					if (delta) changedPixels++;
					if (delta > 1) significantPixels++;
				}
				assert.equal(significantPixels, 0, view + ': initial appearance changed beyond one-level antialiasing noise');
				findings.push({ view, identicalInitialScreenshot: hash('-before') === hash('-after'), changedPixels, significantPixels });
			}
		}
		await page.goto(base + '/?view=studio'); await page.waitForFunction(() => window.ready);
		await page.locator('[name=title]').fill('Changed <title>');
		await page.locator('[name=terms]').fill('First line\nSecond line');
		await page.locator('[name=logo]').selectOption('hotel');
		await page.locator('[name=primaryColor]').evaluate(input => { input.value = '#654321'; input.dispatchEvent(new Event('input', { bubbles: true })); });
		assert.equal(await page.locator('#sim-title').innerText(), 'Changed <title>');
		assert.equal(await page.locator('#sim-terms').innerText(), 'First line\nSecond line');
		assert.equal(await page.locator('#sim-logo-wrap').innerText(), 'HOTEL');
		assert.equal(await page.locator('#sim-btn').evaluate(node => node.style.backgroundColor), 'rgb(101, 67, 33)');
		const save = page.getByRole('button', { name: translations['Save & Generate Portal'] || 'Save & Generate Portal' });
		await save.click(); await page.waitForFunction(() => document.querySelector('.notification[data-level=success]'));
		assert.equal(saved.title, 'Changed <title>'); assert.equal(saved.terms, 'First line\nSecond line'); assert.equal(Object.keys(saved).length, 7);
		failActions = true; await save.click(); await page.waitForFunction(() => document.querySelector('.notification[data-level=danger]'));
		assert.equal(await save.isEnabled(), true); assert.equal(await page.locator('#modal').count(), 0);
		failActions = false; calls = [];
		await page.goto(base + '/?view=overview'); await page.waitForFunction(() => window.ready);
		assert.equal(await page.evaluate(() => window.activePollCount()), 1, 'Polling must survive the initial detached render');
		await page.getByRole('button', { name: translations.Auth || 'Auth', exact: true }).click();
		await page.waitForFunction(() => document.querySelector('.notification[data-level=success]'));
		assert.deepEqual(calls.find(call => call.method === 'client_action').args, ['auth', mac, -1]);
		await page.setViewportSize({ width: 390, height: 844 });
		await page.goto(base + '/?view=studio'); await page.waitForFunction(() => window.ready);
		assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
		await page.screenshot({ path: path.join(output, 'studio-mobile.png'), fullPage: true });
		assert.deepEqual(errors, []);
		fs.writeFileSync(path.join(output, 'browser-results.json'), JSON.stringify({ passed: true, browserVersion: browser.version(), checks: ['official LuCI DOM', 'official LuCI polling', 'initial detached render', 'field events', 'seven-field payload', 'save failure recovery', 'client action', '390px layout'], comparisons: findings }, null, 2));
		console.log(JSON.stringify({ passed: true, comparisons: findings, output }));
	} finally { if (browser) await browser.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
