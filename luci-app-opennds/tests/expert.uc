'use strict';

import { readfile, writefile, mkdir, access, chmod, symlink } from 'fs';
import { cursor } from 'uci';

const source = readfile(ARGV[0]);
const fixture = ARGV[1];
const original = "# Preserve comments and unknown options\nconfig opennds 'setup'\n\toption enabled '0'\n\toption faskey 'fixture-key'\n\toption future_setting 'keep'\n";
let sequence = 0;
function service(restart_failure) {
	let directory = fixture + '/case-' + sequence++;
	assert(mkdir(directory, 0x1c0) && mkdir(directory + '/deltas', 0x1c0), 'Unable to create expert fixture');
	assert(writefile(directory + '/opennds', original), 'Unable to write expert fixture');
	let program = replace(source, "import { connect } from 'ubus';", `
		function connect() { return { defer: function(object, method, args, done) {
			if (index(args.params[1], 'opennds -v') >= 0) done(0, { code: 1, stdout: 'This is openNDS version 11.0.0' });
			else done(0, { code: ${restart_failure ? 1 : 0}, stdout: '' });
			return {};
		} }; }
	`);
	program = replace(program, "import * as uci from 'uci';", 'import { cursor as native_cursor } from "uci";\n' +
		'const uci = { cursor: function(confdir, savedir, override, flags) { return native_cursor(confdir || ' + sprintf('%J', directory) +
		', savedir || ' + sprintf('%J', directory + '/deltas') + ', override == null ? "" : override, flags); } };');
	program = replace(program, '/etc/config', directory);
	return { directory: directory, methods: loadstring(program, { raw_mode: true })()['luci.opennds'] };
}
function save(instance, content, apply, baseline) {
	let reply;
	let result = instance.methods.save_config.call({ args: { content: content, original: baseline == null ? original : baseline, apply: !!apply }, reply: function(value) { reply = value; } });
	return reply || result;
}
let instance = service();
assert(instance.methods.get_config.call().content == original, 'Expert reads must preserve raw content');
let updated = original + "\tlist authenticated_users 'passthrough all from 192.0.2.0/24'\n";
assert(save(instance, updated).code == 0, 'Valid expert configuration must save');
assert(readfile(instance.directory + '/opennds') == updated, 'Expert save must preserve comments and advanced options');
assert(!access(instance.directory + '/opennds_luci_pending', 'f'), 'Staged file must be removed after save');
assert(save(instance, original).code != 0 && readfile(instance.directory + '/opennds') == updated, 'Stale editor must not overwrite another save');
assert(save(instance, original, true, updated).applied, 'Explicit apply must restart after save');
for (let content in ["config opennds\n", "config opennds 'other'\n", "config opennds 'setup'\nconfig opennds 'second'\n", "config opennds 'setup'\noption value 'unterminated\n", "config opennds 'setup'\n\x00"]) {
	instance = service();
	assert(save(instance, content).code != 0, 'Invalid expert content must be rejected');
	assert(readfile(instance.directory + '/opennds') == original, 'Invalid save must preserve original bytes');
	assert(!access(instance.directory + '/opennds_luci_pending', 'f'), 'Rejected staged content must be cleaned up');
}
instance = service();
assert(writefile(instance.directory + '/opennds_luci_pending', 'existing'), 'Unable to create stale fixture');
assert(save(instance, updated).code != 0, 'Stale staged file must block overwrite');
assert(readfile(instance.directory + '/opennds_luci_pending') == 'existing', 'Exclusive creation must preserve stale files');
instance = service();
assert(symlink(instance.directory + '/opennds', instance.directory + '/opennds_luci_pending'), 'Unable to create staged symlink fixture');
assert(save(instance, updated).code != 0 && readfile(instance.directory + '/opennds') == original, 'Staged symlinks must not truncate configuration');
instance = service();
assert(chmod(instance.directory, 0x140), 'Unable to restrict expert directory');
let denied = save(instance, updated);
assert(chmod(instance.directory, 0x1c0), 'Unable to restore expert permissions');
assert(denied.code != 0 && readfile(instance.directory + '/opennds') == original, 'Denied writes must preserve original configuration');
let oversized = original;
while (length(oversized) <= 65536) oversized += oversized;
assert(save(instance, oversized).code != 0, 'Oversized expert payload must fail');
assert(writefile(instance.directory + '/opennds', oversized), 'Unable to create oversized configuration');
assert(instance.methods.get_config.call().error, 'Oversized reads must fail visibly');
instance = service();
let ctx = cursor(instance.directory, instance.directory + '/deltas', '');
assert(ctx.load('opennds') && ctx.set('opennds', 'setup', 'gatewayname', 'Pending') && ctx.save('opennds'), 'Unable to stage UCI changes');
assert(save(instance, updated).code != 0, 'Pending form changes must block expert saves');
assert(readfile(instance.directory + '/opennds') == original, 'Pending UCI changes must not be overwritten');
instance = service(true);
let result = save(instance, updated, true);
assert(result.code != 0 && result.saved && !result.applied, 'Restart failure must report partial success');
assert(readfile(instance.directory + '/opennds') == updated, 'Restart failure must not pretend file changes were rolled back');
print('Native expert configuration checks passed\n');
