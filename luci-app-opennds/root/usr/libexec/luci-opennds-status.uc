'use strict';

import { popen } from 'fs';

// Consume full daemon output outside rpcd, then return only overview fields.
function read_status(mode) {
	let pipe = popen('timeout -s KILL 5 ndsctl ' + mode + ' 2>&1', 'r');
	if (!pipe) die('Unable to execute ndsctl ' + mode);
	let output = pipe.read('all');
	let code = pipe.close();
	if (code !== 0 || type(output) != 'string') die('ndsctl ' + mode + ' failed');
	return output;
}

let result = { clients: {}, trusted: [], metadata: {} };
let errors = [];
try {
	let raw = json(read_status('json'));
	if (type(raw) != 'object' || (raw.clients != null && type(raw.clients) != 'object') ||
		(raw.trusted != null && type(raw.trusted) != 'array'))
		die('Invalid ndsctl JSON response');
	let fields = ['ip', 'state', 'session_start', 'download_this_session', 'upload_this_session'];
	for (let mac in (raw.clients || {})) {
		let client = raw.clients[mac];
		if (type(client) != 'object') continue;
		let clean = {};
		for (let i = 0; i < length(fields); i++) {
			let field = fields[i];
			let value = client[field];
			if (type(value) == 'string' || type(value) == 'int' || type(value) == 'double')
				clean[field] = value;
		}
		result.clients[mac] = clean;
	}
	result.trusted = raw.trusted || [];
} catch (e) {
	push(errors, 'ndsctl json failed');
}

try {
	let fields = [
		['version', /^Version: (.+)$/],
		['uptime', /^Uptime: (.+)$/],
		['gateway_name', /^Gateway Name: \[ (.*) \]$/],
		['interface', /^Managed interface: ([^ ]+)/],
		['gateway_port', /^MHD Server .*listening on: http:\/\/.*:([0-9]+)$/]
	];
	let lines = split(read_status('status'), '\n');
	for (let i = 0; i < length(lines); i++) {
		if (!match(lines[i], /^(Version:|Uptime:|Gateway Name:|Managed interface:|MHD Server )/)) continue;
		for (let j = 0; j < length(fields); j++) {
			let field = fields[j];
			let value = match(lines[i], field[1]);
			if (value) result.metadata[field[0]] = trim(value[1]);
		}
	}
} catch (e) {
	push(errors, 'ndsctl status failed');
}
if (length(errors)) result.error = join('; ', errors);
let output = sprintf('%J', result);
if (length(output) >= 250000) die('openNDS status exceeds the RPC output limit');
printf('%s\n', output);
