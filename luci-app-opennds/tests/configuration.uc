'use strict';

import { readfile, writefile, mkdir, chmod } from 'fs';
import { cursor } from 'uci';

const source = readfile(ARGV[0]);
const fixture = ARGV[1];
let sequence = 0;

function service(content, version, fail_commit) {
	const directory = fixture + '/case-' + sequence++;
	assert(mkdir(directory, 0x1c0) && mkdir(directory + '/deltas', 0x1c0), 'Unable to create fixture');
	assert(writefile(directory + '/opennds', content), 'Unable to create UCI configuration');
	const dependency = directory + '/dependency';
	assert(writefile(dependency, '#!/bin/sh\n') && chmod(dependency, 0x1c0), 'Unable to create dependency');
	let program = replace(source, "import { connect } from 'ubus';", `
		function connect() {
			return { defer: function(object, method, args, done) {
				if (index(args.params[1], 'opennds -v') >= 0)
					done(0, { code: 1, stdout: 'This is openNDS version ${version || '11.0.0'}' });
				else done(0, { code: 0, stdout: '' });
				return {};
			} };
		}
	`);
	program = replace(program, "import * as uci from 'uci';",
		'import { cursor as native_cursor } from "uci";\n' +
		'const uci = { cursor: function() { return native_cursor(' + sprintf('%J', directory) + ', ' + sprintf('%J', directory + '/deltas') + ', ""); } };');
	program = replace(program, "'/etc/opennds/portal_theme.json'", sprintf('%J', directory + '/portal_theme.json'));
	program = replace(program, "'/etc/opennds'", sprintf('%J', directory));
	for (let path in ['/usr/lib/opennds/theme_luci.sh', '/usr/lib/opennds/status_luci.sh', '/usr/lib/opennds/theme_click-to-continue-basic.sh', '/usr/bin/jsonfilter'])
		program = replace(program, "'" + path + "'", sprintf('%J', dependency));
	if (fail_commit) program = replace(program, "!u.commit('opennds')", 'true');
	return { directory: directory, methods: loadstring(program, { raw_mode: true })()['luci.opennds'] };
}

function call(instance, method, config) {
	let reply;
	let result = instance.methods[method].call({ args: { config: config }, reply: function(value) { reply = value; } });
	return reply || result;
}

const original = "config opennds 'setup'\n\toption faskey 'fixture-device-key'\n\toption gatewayinterface 'br-guest'\n" +
	"\toption login_option_enabled '0'\n\toption fasport '8443'\n\toption future_setting 'keep me'\n";
const theme = { title: "Guest's portal", subtitle: 'Welcome', logo: 'wifi', primaryColor: '#0284c7', btnText: 'Connect', terms: 'Terms', footer: 'Guest' };
let instance = service(original);
assert(call(instance, 'check_config').major == 11, 'Named v11 configuration must pass');
assert(readfile(instance.directory + '/opennds') == original, 'Inspection must not modify UCI');
assert(call(instance, 'save_portal', theme).code == 0, 'Native portal persistence must succeed');
assert(json(readfile(instance.directory + '/portal_theme.json')).title == theme.title, 'JSON must retain original text');
let ctx = cursor(instance.directory, instance.directory + '/deltas', '');
assert(ctx.load('opennds'), 'Saved UCI must parse');
let saved = ctx.get_all('opennds', 'setup');
assert(saved.faskey == 'fixture-device-key' && saved.future_setting == 'keep me', 'Unrelated options must survive');
assert(saved.gatewayinterface == 'br-guest' && saved.gatewayname == 'Guest&#39;s portal', 'Gateway settings must persist safely');
assert(saved.fasport == '443' && saved.luci_fasport == '8443' && saved.login_option_enabled == '3', 'Local FAS mode must preserve external port');
assert(saved.statuspath == instance.directory + '/dependency', 'Saving a theme must select its branded status page');
assert(call(instance, 'save_portal', theme).code == 0, 'Repeated saves must succeed');

const extended = original + "\toption statuspath '/mnt/usb/status.sh'\n\toption max_page_size '16384'\n";
instance = service(extended);
assert(call(instance, 'save_portal', theme).code == 0, 'Save with a custom status script must succeed');
ctx = cursor(instance.directory, instance.directory + '/deltas', '');
assert(ctx.load('opennds'), 'Custom status configuration must parse');
assert(ctx.get('opennds', 'setup', 'statuspath') == '/mnt/usb/status.sh', 'Portal save must preserve an explicit status script');
assert(ctx.get('opennds', 'setup', 'max_page_size') == '16384', 'Portal save must preserve the page size');
const values = {
	enable_serial_number_suffix: '0', reauth_interval: '60', nat_traversal_poll_interval: '59',
	fup_upload_throttle_rate: '64', fup_download_throttle_rate: '128',
	authenticated_users: ['block all to 192.0.2.10', 'allow all', 'allow all'],
	preauthenticated_users: ['allow tcp port 443 to 192.0.2.10'], users_to_router: ['allow tcp port 8080'],
	preemptivemac: ['mac=02:00:00:00:00:01;sessiontimeout=60;custom=room-1'],
	fas_custom_parameters_list: ['message=hello%20world%27s'], fas_custom_variables_list: ['input=phone:Phone%20number:tel'],
	fas_custom_images_list: ['logo_png=https://example.com/logo.png?v=1%26size=2'],
	fas_custom_files_list: ['advert_htm=file:///mnt/usb/advert.htm'], remotes_refresh_interval: '720',
	log_mountpoint: '/mnt/usb', max_log_entries: '0', dhcp_leases_file: '/tmp/dhcp.guest.leases', fast_client_scan: '0'
};
for (let key in values) assert(ctx.set('opennds', 'setup', key, values[key]), 'Unable to store ' + key);
assert(ctx.commit('opennds'), 'Extended UCI configuration must persist');
ctx = cursor(instance.directory, instance.directory + '/deltas', '');
assert(ctx.load('opennds'), 'Extended UCI configuration must reload');
for (let key in values) assert(sprintf('%J', ctx.get('opennds', 'setup', key)) == sprintf('%J', values[key]), 'UCI round-trip changed ' + key);
assert(ctx.get('opennds', 'setup', 'faskey') == 'fixture-device-key' && ctx.get('opennds', 'setup', 'future_setting') == 'keep me', 'Extended writes must retain existing keys');

for (let content in ["config opennds\n", "config opennds 'other'\n", "config opennds 'setup'\nconfig opennds 'other'\n", "config opennds 'setup'\noption bad 'unterminated\n"]) {
	instance = service(content);
	assert(call(instance, 'check_config').error, 'Unsupported configuration must be rejected');
	assert(call(instance, 'save_portal', theme).code != 0, 'Rejected configuration must not save a portal');
	assert(readfile(instance.directory + '/opennds') == content, 'Rejected UCI must remain unchanged');
}
for (let version in ['10.0.0', '12.0.0']) {
	instance = service(original, version);
	assert(call(instance, 'check_config').error, 'Only v11 is supported');
	assert(call(instance, 'save_portal', theme).code != 0, 'Unsupported daemon must not save');
}
instance = service(original, '11.0.0', true);
let partial = call(instance, 'save_portal', theme);
assert(partial.code != 0 && partial.saved && !partial.applied, 'Failed UCI commit must report saved theme accurately');
assert(readfile(instance.directory + '/opennds') == original, 'Failed commit must leave original UCI intact');
instance = service(original);
assert(chmod(instance.directory, 0x140), 'Unable to restrict portal directory');
let denied = call(instance, 'save_portal', theme);
assert(chmod(instance.directory, 0x1c0), 'Unable to restore permissions');
assert(denied.code != 0 && !denied.saved, 'Denied portal write must fail without false success');
assert(readfile(instance.directory + '/opennds') == original, 'Denied write must preserve UCI');
print('Native configuration and persistence checks passed\n');
