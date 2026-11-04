'use strict';

import { popen } from 'fs';

// This runs in a child process, never in rpcd's event loop. Consume the full
// daemon response here and emit only the fields used by the overview, keeping
// 1000 client records below rpcd file.exec's 256 KiB output limit.
const mode = ARGV[0];
if (mode != 'json' && mode != 'status') die('Unsupported ndsctl status mode');

let pipe = popen('ndsctl ' + mode + ' 2>&1', 'r');
if (!pipe) die('Unable to execute ndsctl ' + mode);
let output = pipe.read('all');
let code = pipe.close();
if (code !== 0 || type(output) != 'string') die('ndsctl ' + mode + ' failed');

if (mode == 'json') {
	let raw = json(output);
	if (type(raw) != 'object' || (raw.clients != null && type(raw.clients) != 'object') ||
		(raw.trusted != null && type(raw.trusted) != 'array'))
		die('Invalid ndsctl JSON response');
	let clients = {};
	let fields = ['ip', 'state', 'session_start', 'download_this_session', 'upload_this_session'];
	for (let mac in (raw.clients || {})) {
		let client = raw.clients[mac];
		if (type(client) != 'object') continue;
		let clean = {};
		for (let i = 0; i < length(fields); i++) {
			let value = client[fields[i]];
			if (type(value) == 'string' || type(value) == 'int' || type(value) == 'double')
				clean[fields[i]] = value;
		}
		clients[mac] = clean;
	}
	printf('%J\n', { clients: clients, trusted: raw.trusted || [] });
} else {
	let lines = split(output, '\n');
	for (let i = 0; i < length(lines); i++) {
		if (match(lines[i], /^(Version:|Uptime:|Gateway Name:|Managed interface:|MHD Server )/))
			printf('%s\n', lines[i]);
	}
}
