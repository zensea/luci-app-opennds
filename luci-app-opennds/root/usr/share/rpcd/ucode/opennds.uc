'use strict';

import { open, access, mkdir, rename, unlink, stat, error as fs_error } from 'fs';
import { connect } from 'ubus';
import * as uci from 'uci';

const portal_file = '/etc/opennds/portal_theme.json';
const portal_script = '/usr/lib/opennds/theme_luci.sh';
const bus = connect(null, 18);
let restarting = false;

function execute(command, callback) {
	// file.exec waits for children outside rpcd's main loop. Keep the shell
	// alive to report signal exits correctly as a normal, nonzero exit code.
	let completed = false;
	let done = function(code, reply) {
		if (completed) return;
		completed = true;
		if (code != 0 || type(reply) != 'object') {
			callback({ code: -1, output: sprintf('Unable to execute command (ubus status %d)', code) });
			return;
		}
		callback({ code: reply.code == null ? -1 : reply.code,
			output: trim((reply.stdout || '') + (reply.stderr || '')) });
	};
	let pending = bus ? bus.defer('file', 'exec', {
		command: '/bin/sh', params: ['-c', command + ' 2>&1; exit $?']
	}, done) : null;
	if (!pending) done(-1, null);
	return pending;
}

function restart(callback) {
	if (restarting) {
		callback({ code: 1, output: 'openNDS restart already in progress' });
		return null;
	}
	restarting = true;
	return execute('timeout -s KILL 15 /etc/init.d/opennds restart', function(result) {
		restarting = false;
		callback(result);
	});
}

function settings() {
	let cursor = uci.cursor();
	if (!cursor.load('opennds')) die('Unable to load opennds configuration');
	let sections = [];
	cursor.foreach('opennds', 'opennds', function(s) {
		push(sections, s);
	});
	if (length(sections) != 1 || sections[0]['.name'] != 'setup' || sections[0]['.anonymous'])
		die("Expected exactly one named openNDS section: config opennds 'setup'");
	return { cursor: cursor, section: sections[0] };
}

function inspect_config(callback) {
	// opennds -v intentionally exits with status 1 in v11.
	return execute('timeout -s KILL 2 /usr/bin/opennds -v', function(command) {
		let version = match(command.output || '', /This is openNDS version ([0-9]+\.[0-9]+\.[0-9]+)/);
		if ((command.code != 0 && command.code != 1) || !version) {
			callback({ error: 'Unable to determine installed openNDS version' });
			return;
		}
		let result;
		try {
			if (int(split(version[1], '.')[0]) != 11) die('openNDS v11 is required');
			settings();
			result = { version: version[1], major: 11 };
		} catch (e) {
			result = { version: version[1], error: '' + e };
		}
		callback(result);
	});
}

function html_escape(value) {
	value = replace(value, '&', '&amp;');
	value = replace(value, '<', '&lt;');
	value = replace(value, '>', '&gt;');
	value = replace(value, '"', '&quot;');
	value = replace(value, '`', '&#96;');
	return replace(value, "'", '&#39;');
}

const methods = {
	status: {
		call: function(request) {
			return execute('timeout -s KILL 2 pidof opennds', function(process) {
				if (process.code != 0 && process.code != 1) {
					request.reply({ unavailable: true, error: process.output || 'Unable to query openNDS process' });
					return;
				}
				let pid = process.code == 0 ? process.output : '';
				let data = { clients: {}, trusted: [] };
				let result = { running: length(pid) > 0, pid: pid, data: data };
				try {
					let config = settings().section;
					data.interface = config.gatewayinterface || 'br-lan';
					data.gateway_name = replace(config.gatewayname || 'openNDS', '&#39;', "'");
					data.gateway_port = config.gatewayport || '2050';
				} catch (e) {
					result.error = '' + e;
				}
				if (!result.running) {
					return inspect_config(function(configuration) {
						result.configuration = configuration;
						data.version = configuration.version;
						request.reply(result);
					});
				}

				execute('timeout -s KILL 12 /usr/bin/ucode /usr/libexec/luci-opennds-status.uc', function(sample) {
					try {
						if (sample.code != 0) die(sample.output || 'Unable to collect openNDS status');
						let raw = json(sample.output);
						if (type(raw) != 'object') die('Invalid openNDS status response');
						data.clients = raw.clients || {};
						data.trusted = raw.trusted || [];
						for (let field in (raw.metadata || {})) data[field] = raw.metadata[field];
						data.gateway_name = replace(data.gateway_name || 'openNDS', '&#39;', "'");
						if (raw.error) result.error = raw.error;
					} catch (e) {
						result.error = '' + e;
					}
					request.reply(result);
				});
			});
		}
	},

	check_config: {
		call: function(request) { return inspect_config(function(result) { request.reply(result); }); }
	},

	client_action: {
		args: { action: '', mac: '', duration: -1 },
		call: function(request) {
			let args = request.args || {};
			let action = args.action;
			let mac = args.mac;
			if (type(mac) != 'string' || !match(mac, /^([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$/))
				return { code: 2, message: 'Invalid MAC address format' };
			if (action != 'auth' && action != 'deauth' && action != 'trust' && action != 'untrust')
				return { code: 3, message: 'Unsupported openNDS action' };
			let command = sprintf('timeout -s KILL 5 ndsctl %s "%s"', action, mac);
			if (action == 'auth') {
				// -1 inherits the daemon setting; 0 explicitly means unlimited.
				let duration = args.duration == null ? -1 : int(args.duration);
				if (duration != duration || duration < -1 || duration > 144000)
					return { code: 2, message: 'Invalid session duration' };
				command += duration == -1 ? ' ""' : sprintf(' %d', duration);
			}
			return execute(command, function(result) { request.reply(result); });
		}
	},

	reload_service: {
		call: function(request) {
			return restart(function(result) { request.reply(result); });
		}
	},

	get_log: {
		args: { lines: 0 },
		call: function(request) {
			let args = request.args || {};
			let count = int(args.lines || 50);
			if (count != count || count <= 0 || count > 500) count = 50;
			return execute(sprintf('timeout -s KILL 3 logread -e opennds -l %d', count), function(result) {
				if (result.code != 0) {
					request.reply({ code: result.code, error: result.output || 'Unable to read openNDS log' });
					return;
				}
				let lines = [];
				let raw = split(result.output, '\n');
				for (let i = 0; i < length(raw); i++)
					if (length(trim(raw[i]))) push(lines, raw[i]);
				request.reply({ lines: lines });
			});
		}
	},

	get_portal: {
		call: function(request) {
			fs_error();
			let fp = open(portal_file, 'r');
			if (!fp) {
				let reason = fs_error();
				// Some ucode versions do not record open(2) failures in fs.error().
				let info = stat(portal_file);
				let stat_reason = fs_error();
				if (!info && stat_reason == 'No such file or directory') return { exists: false };
				return { error: 'Unable to read portal configuration: ' + (reason || stat_reason || 'open failed') };
			}
			let content = fp.read('all');
			let read_error = fs_error();
			let closed = fp.close();
			if (read_error || type(content) != 'string' || !closed)
				return { exists: true, error: 'Unable to read portal configuration' };
			try {
				let config = json(content);
				if (type(config) != 'object') die('Invalid portal configuration');
				return { exists: true, config: config };
			} catch (e) {
				return { exists: true, error: 'Invalid portal JSON' };
			}
		}
	},

	save_portal: {
		args: { config: {} },
		call: function(request) {
			if (restarting) return { code: 1, message: 'openNDS configuration operation is in progress; try saving again later' };
			let args = request.args || {};
			let config = args.config;
			if (type(config) != 'object') return { code: 1, message: 'Missing config payload' };
			let fields = ['title', 'subtitle', 'logo', 'primaryColor', 'btnText', 'terms', 'footer'];
			let limits = [120, 240, 16, 7, 120, 2000, 160];
			let clean = {};
			let escaped_size = 0;
			for (let i = 0; i < length(fields); i++) {
				let field = fields[i];
				let value = config[field];
				if (type(value) != 'string' || length(value) > limits[i])
					return { code: 1, message: 'Invalid portal field: ' + field };
				let controls = replace(replace(replace(value, '\n', ''), '\r', ''), '\t', '');
				if (index(value, '\x00') >= 0 || match(controls, /[[:cntrl:]]/) || (field != 'terms' && controls != value))
					return { code: 1, message: 'Invalid control character in portal field: ' + field };
				clean[field] = value;
				// The title appears in both <title> and <h1> in theme_luci.sh.
				escaped_size += length(html_escape(value)) * (field == 'title' ? 2 : 1);
			}
			if (!length(trim(clean.title)) || !length(trim(clean.btnText)) ||
				!match(clean.primaryColor, /^#[0-9a-fA-F]{6}$/) ||
				!match(clean.logo, /^(wifi|coffee|hotel|business)$/) || escaped_size > 6000)
				return { code: 1, message: 'Invalid or oversized portal theme' };
			if (!access(portal_script, 'x') || !access('/usr/lib/opennds/theme_click-to-continue-basic.sh', 'r') || !access('/usr/bin/jsonfilter', 'x'))
				return { code: 2, message: 'Portal template or jsonfilter is not installed' };
			let current;
			try {
				current = settings();
			} catch (e) {
				return { code: 3, message: '' + e };
			}
			let page_size = int(current.section.max_page_size || 10240);
			if (page_size != page_size || page_size < 1024 || escaped_size + 4000 > page_size)
				return { code: 1, message: 'Portal content exceeds max_page_size; shorten the text' };
			if (!access('/etc/opennds', 'f') && !mkdir('/etc/opennds', 0x1ed)) // 0755
				return { code: 2, message: 'Unable to create portal directory' };

			return inspect_config(function(diagnostic) {
				if (diagnostic.error) {
					request.reply({ code: 3, message: diagnostic.error });
					return;
				}
				if (restarting) {
					request.reply({ code: 1, message: 'openNDS configuration operation is in progress; try saving again later' });
					return;
				}
				try {
					current = settings();
					let maximum = int(current.section.max_page_size || 10240);
					if (maximum != maximum || maximum < 1024 || escaped_size + 4000 > maximum)
						die('Portal content exceeds max_page_size; shorten the text');
				} catch (e) {
					request.reply({ code: 3, message: '' + e }); return;
				}
				// Atomic replacement prevents a failed write from truncating the active theme.
				let temporary = portal_file + '.tmp';
				let fp = open(temporary, 'w', 0x180); // 0600
				if (!fp) { request.reply({ code: 2, message: 'Unable to write portal configuration' }); return; }
				let content = sprintf('%J\n', clean);
				let written = fp.write(content);
				let closed = fp.close();
				if (written != length(content) || !closed || !rename(temporary, portal_file)) {
					unlink(temporary);
					request.reply({ code: 2, message: 'Unable to persist portal configuration' }); return;
				}

				try {
					let u = current.cursor;
					let section = current.section['.name'];
					if ((current.section.login_option_enabled || '1') == '0' && int(current.section.fasport) > 0 &&
						!u.set('opennds', section, 'luci_fasport', current.section.fasport))
						die('Unable to preserve FAS port');
					if (!u.set('opennds', section, 'gatewayname', replace(clean.title, "'", '&#39;')) ||
						!u.set('opennds', section, 'fasport', '443') ||
						!u.set('opennds', section, 'login_option_enabled', '3') ||
						!u.set('opennds', section, 'themespec_path', portal_script) || !u.commit('opennds'))
						die('Unable to commit opennds configuration');
				} catch (e) {
					request.reply({ code: 3, saved: true, applied: false, message: 'Theme saved, but gateway configuration failed: ' + e }); return;
				}
				return restart(function(reload) {
					if (reload.code != 0)
						request.reply({ code: reload.code, saved: true, applied: false, message: 'Theme saved, but openNDS restart failed', output: reload.output });
					else
						request.reply({ code: 0, saved: true, applied: true });
				});
			});
		}
	}
};

return { 'luci.opennds': methods };
