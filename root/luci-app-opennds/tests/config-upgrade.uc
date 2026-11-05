'use strict';

import { readfile, writefile, mkdir, chmod, stat, glob } from 'fs';
import { cursor } from 'uci';

// Run the entire production backend with real UCI and filesystem operations.
// Only process execution is substituted: no router daemon or firewall is touched.
const source = readfile(ARGV[0]);
const fixture = ARGV[1];
let sequence = 0;

function service(content, version, fault) {
	const directory = fixture + '/case-' + sequence++;
	const deltas = directory + '/deltas';
	assert(mkdir(directory, 0x1c0) && mkdir(deltas, 0x1c0), 'Unable to create fixture directories');
	const path = directory + '/opennds';
	assert(writefile(path, content), 'Unable to create UCI fixture');
	const dependency = directory + '/test-dependency';
	assert(writefile(dependency, '#!/bin/sh\n') && chmod(dependency, 0x1c0), 'Unable to create dependency fixture');
	let program = replace(source, "import { connect } from 'ubus';", `
		const test_calls = [];
		function connect() {
			return { defer: function(object, method, args, done) {
				let command = args.params[1];
				push(test_calls, command);
				if (index(command, 'pidof') >= 0) done(0, { code: 1, stdout: '' });
				else if (index(command, 'opennds -v') >= 0) done(0, { code: 1, stdout: 'This is openNDS version ${version}' });
				else done(0, { code: 0, stdout: '' });
				return {};
			} };
		}
	`);
	program = replace(program, "import * as uci from 'uci';",
		'import { cursor as native_cursor } from "uci";\n' +
		'const uci = { cursor: function() { return native_cursor(' + sprintf('%J', directory) + ', ' + sprintf('%J', deltas) + ', ""); } };');
	program = replace(program, "const config_file = '/etc/config/opennds';", 'const config_file = ' + sprintf('%J', path) + ';');
	program = replace(program, "'/etc/opennds/portal_theme.json'", sprintf('%J', directory + '/portal_theme.json'));
	program = replace(program, "'/etc/opennds'", sprintf('%J', directory));
	for (let dependency_path in ['/usr/lib/opennds/theme_luci.sh', '/usr/lib/opennds/theme_click-to-continue-basic.sh', '/usr/bin/jsonfilter'])
		program = replace(program, "'" + dependency_path + "'", sprintf('%J', dependency));
	program = replace(program, "return { 'luci.opennds': methods };", 'return { methods: methods, calls: test_calls };');
	if (fault == 'commit') program = replace(program, "if (!u.commit('opennds'))", 'if (true)');
	if (fault == 'validation') program = replace(program, 'let checked = configuration_plan(diagnostic.version);', 'let checked = { status: { needs_upgrade: true } };');
	const instance = loadstring(program, { raw_mode: true })();
	return { path: path, directory: directory, deltas: deltas, methods: instance.methods, calls: instance.calls };
}

function call(instance, method) {
	let response;
	let result = instance.methods[method].call({ reply: function(value) {
		assert(response == null, 'Backend replied more than once');
		response = value;
	} });
	return response || result;
}

const original = "# Existing custom configuration\nconfig opennds\n" +
	"\toption gatewayinterface 'br-guest'\n\toption faskey 'private-fixture-key'\n" +
	"\toption login_option_enabled '3'\n\toption fasport '0'\n" +
	"\toption themespec_path '/usr/lib/opennds/theme_luci.sh'\n" +
	"\tlist trustedmac '02:00:00:00:00:01'\n\tlist trustedmac '02:00:00:00:00:02'\n" +
	"\toption future_setting 'keep me'\n";
let instance = service(original, '11.0.0');
assert(call(instance, 'status').configuration.can_upgrade, 'Stopped v11 must expose a repairable configuration');
assert(readfile(instance.path) == original, 'Detection must not write configuration');
let result = call(instance, 'upgrade_config');
assert(result.code == 0 && result.upgraded, 'Native UCI migration must succeed: ' + sprintf('%J', result));
assert(readfile(result.backup) == original, 'Backup must preserve every original byte');
assert((stat(result.backup).mode & 0x1ff) == 0x180, 'Backup permissions must be 0600');
let ctx = cursor(instance.directory, instance.deltas, '');
assert(ctx.load('opennds'), 'Migrated UCI must parse');
const upgraded = ctx.get_all('opennds', 'setup');
assert(upgraded && !upgraded['.anonymous'], 'Migrated section must really be named setup');
assert(upgraded.gatewayinterface == 'br-guest' && upgraded.faskey == 'private-fixture-key', 'Interface and key must be preserved');
assert(length(upgraded.trustedmac) == 2 && upgraded.future_setting == 'keep me', 'Lists and unknown options must be preserved');
assert(upgraded.fasport == '443' && upgraded.login_option_enabled == '3', 'Local portal mode must use v11 initialization');
const after = readfile(instance.path);
assert(!call(instance, 'check_config').needs_upgrade, 'Upgraded configuration must pass reinspection');
assert(call(instance, 'upgrade_config').code != 0, 'A repeated upgrade must be rejected');
assert(readfile(instance.path) == after, 'A repeated upgrade must not alter configuration');
let portal_reply;
instance.methods.save_portal.call({ args: { config: { title: 'Native portal', subtitle: 'Welcome', logo: 'wifi',
	primaryColor: '#0284c7', btnText: 'Connect', terms: 'Terms', footer: 'Guest' } }, reply: function(value) { portal_reply = value; } });
assert(portal_reply.code == 0 && portal_reply.saved, 'Native portal write must survive the SDK flush bug: ' + sprintf('%J', portal_reply));
assert(json(readfile(instance.directory + '/portal_theme.json')).title == 'Native portal', 'Native portal content must be persisted');

for (let version in ['10.3.1', '12.0.0']) {
	instance = service(original, version);
	assert(!call(instance, 'check_config').can_upgrade, 'Unmatched versions must not offer upgrade');
	assert(call(instance, 'upgrade_config').code != 0 && readfile(instance.path) == original, 'Unmatched versions must remain unchanged');
}

for (let content in [
	"config opennds\nconfig opennds\n",
	"config opennds\nconfig other 'setup'\n",
	"config opennds 'custom'\n",
	"config opennds\noption broken 'unterminated\n"
]) {
	instance = service(content, '11.0.0');
	assert(!call(instance, 'check_config').can_upgrade, 'Ambiguous or invalid UCI must not offer upgrade');
	assert(call(instance, 'upgrade_config').code != 0 && readfile(instance.path) == content, 'Unsafe configuration must remain unchanged');
}

instance = service(original, '11.0.0');
ctx = cursor(instance.directory, instance.deltas, '');
assert(ctx.set('opennds', '@opennds[0]', 'gatewayinterface', 'br-pending') && ctx.save('opennds'), 'Unable to stage pending changes');
assert(!call(instance, 'check_config').can_upgrade, 'Pending UCI changes must block migration');
assert(call(instance, 'upgrade_config').code != 0 && readfile(instance.path) == original, 'Pending configuration must be preserved');

for (let fault in ['commit', 'validation']) {
	instance = service(original, '11.0.0', fault);
	result = call(instance, 'upgrade_config');
	assert(result.code != 0 && !result.upgraded && result.restored, 'Failed upgrade must report rollback');
	assert(readfile(instance.path) == original && readfile(result.backup) == original, 'Failed upgrade must restore the exact original');
	assert(!length(filter(instance.calls, command => index(command, 'init.d/opennds restart') >= 0)), 'Failed upgrade must not restart service');
}

instance = service(original, '11.0.0');
assert(chmod(instance.directory, 0x140), 'Unable to make fixture directory read-only');
result = call(instance, 'upgrade_config');
assert(chmod(instance.directory, 0x1c0), 'Unable to restore fixture permissions');
assert(result.code != 0 && readfile(instance.path) == original, 'Backup failure must leave configuration untouched');

print('Native configuration upgrade checks passed\n');
