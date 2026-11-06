'use strict';

import { readfile } from 'fs';

const source = readfile(ARGV[0]);
function sample(raw, status, json_code, status_code) {
	let output = '';
	let program = replace(source, "import { popen } from 'fs';", `
		function popen(command, mode) {
			let is_json = index(command, 'ndsctl json') >= 0;
			return { read: function() { return is_json ? ${sprintf('%J', raw)} : ${sprintf('%J', status)}; },
				close: function() { return is_json ? ${json_code || 0} : ${status_code || 0}; } };
		}
	`);
	program = replace(program, "printf('%s\\n', output);", 'return output;');
	return json(loadstring(program, { raw_mode: true })());
}
let clients = {};
for (let i = 0; i < 1000; i++) {
	let mac = sprintf('02:00:00:00:%02x:%02x', int(i / 256), i % 256);
	clients[mac] = { ip: '192.0.2.1', state: 'Authenticated', session_start: 1000, download_this_session: i * 1024,
		upload_this_session: i, token: 'never expose', custom: 'x' };
}
const status = 'Version: 11.0.0\nUptime: 1h\nGateway Name: [ Guest ]\nManaged interface: br-guest\nMHD Server [ version 1.0 ] listening on: http://192.0.2.1:2050\n';
let result = sample(sprintf('%J', { clients: clients, trusted: keys(clients) }), status);
assert(length(keys(result.clients)) == 1000 && length(sprintf('%J', result)) < 250000, '1000 native clients must fit');
assert(result.metadata.interface == 'br-guest' && result.metadata.gateway_port == '2050', 'Metadata must parse with POSIX ERE');
assert(index(sprintf('%J', result), 'never expose') < 0, 'Private fields must not escape');
result = sample('broken', status);
assert(result.error && result.metadata.version == '11.0.0', 'JSON failure must preserve metadata: ' + sprintf('%J', result));
result = sample(sprintf('%J', { clients: clients }), '', 0, 1);
assert(result.error && length(keys(result.clients)) == 1000, 'Metadata failure must preserve clients');
print('Native combined status checks passed\n');
