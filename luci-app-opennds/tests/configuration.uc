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
	for (let path in ['/usr/lib/opennds/theme_luci.sh', '/usr/lib/opennds/theme_click-to-continue-basic.sh', '/usr/bin/jsonfilter'])
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
assert(call(instance, 'save_portal', theme).code == 0, 'Repeated saves must succeed');

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
