'use strict';

import { open, readfile, writefile, mkdir, chmod, stat, error as fs_error } from 'fs';

// Exercise the production method with real filesystem calls and temporary paths.
const source = readfile(ARGV[0]);
const begin = index(source, '\tget_portal: {');
const end = index(source, '\n\tsave_portal: {');
assert(begin >= 0 && end > begin, 'Unable to locate get_portal in the backend');
const method = substr(source, begin, end - begin);
const fixture = ARGV[1];

function read_portal(path) {
	const program = 'import { open, stat, error as fs_error } from "fs";\n' +
		'const portal_file = ' + sprintf('%J', path) + ';\n' +
		'return ({\n' + method + '\n}).get_portal.call;';
	const call = loadstring(program, { raw_mode: true })();
	return call({});
}

for (let path in [fixture + '/missing.json', fixture + '/missing-dir/portal_theme.json']) {
	fs_error();
	assert(open(path, 'r') == null, 'Missing fixture unexpectedly exists');
	printf('Native open failure: fs.error()=%J\n', fs_error());
	const result = read_portal(path);
	assert(result.exists == false && !result.error, 'Missing portal must use defaults');
}

const valid = fixture + '/valid.json';
assert(writefile(valid, '{"title":"Saved portal"}') != null, 'Unable to create fixture');
stat(fixture + '/missing.json'); // The method must also clear unrelated fs errors.
let result = read_portal(valid);
assert(result.exists == true && result.config.title == 'Saved portal', 'Saved portal must load');

const corrupt = fixture + '/corrupt.json';
assert(writefile(corrupt, '{invalid') != null, 'Unable to create corrupt fixture');
assert(read_portal(corrupt).error == 'Invalid portal JSON', 'Corrupt JSON must remain an error');

assert(chmod(valid, 0), 'Unable to restrict fixture permissions');
result = read_portal(valid);
assert(chmod(valid, 0x180), 'Unable to restore fixture permissions'); // 0600
assert(result.error, 'Unreadable existing portal must remain an error');
assert(readfile(valid) == '{"title":"Saved portal"}', 'Reading must preserve saved content');

const blocked = fixture + '/blocked';
assert(mkdir(blocked, 0x1c0), 'Unable to create restricted parent'); // 0700
assert(writefile(blocked + '/portal_theme.json', '{}') != null, 'Unable to create child fixture');
assert(chmod(blocked, 0), 'Unable to restrict parent permissions');
result = read_portal(blocked + '/portal_theme.json');
assert(chmod(blocked, 0x1c0), 'Unable to restore parent permissions');
assert(result.error, 'Inaccessible parent must remain an error');

result = read_portal(valid + '/portal_theme.json');
assert(result.error, 'Invalid parent path must remain an error');
result = read_portal(blocked);
assert(result.error, 'Directory path must remain an error');

print('Native portal filesystem checks passed\n');
