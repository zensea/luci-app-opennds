'use strict';

import { open, access, mkdir, rename, unlink, stat, error as fs_error } from 'fs';
import { connect } from 'ubus';
import * as uci from 'uci';

const portal_file = '/etc/opennds/portal_theme.json';
const portal_script = '/usr/lib/opennds/theme_luci.sh';
const config_file = '/etc/config/opennds';
const bus = connect(null, 18);
let restarting = false;
let upgrading = false;

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
	let section = null;
	let sections = [];
	cursor.foreach('opennds', 'opennds', function(s) {
		push(sections, s);
		if (!section || s['.name'] == 'setup') section = s;
	});
	if (!section) die('Missing opennds configuration section');
	return { cursor: cursor, section: section, sections: sections };
}

// These helpers also run against real filesystem fixtures in the native tests.
function read_config_text() {
	let fp = open(config_file, 'r');
	if (!fp) die('Unable to read openNDS configuration');
	fs_error();
	let content = fp.read(65537);
	let reason = fs_error();
	let closed = fp.close();
	if (reason || !closed || type(content) != 'string' || length(content) > 65536)
		die('Unable to read openNDS configuration, or file exceeds 64 KiB');
	return content;
}

function write_exclusive(path, content) {
	let fp = open(path, 'wx', 0x180); // 0600; never overwrite a prior backup or symlink.
	if (!fp) return false;
	let written = fp.write(content);
	let flushed = fp.flush();
	let closed = fp.close();
	if (written == length(content) && flushed && closed) return true;
	unlink(path);
	return false;
}

function backup_config(content) {
	for (let i = 0; i < 10; i++) {
		let path = sprintf('%s.before-v11-upgrade.%d.%d', config_file, time(), i);
		if (write_exclusive(path, content)) return path;
	}
	die('Unable to back up openNDS configuration');
}

function restore_config(content, backup) {
	let temporary = backup + '.restore';
	if (!write_exclusive(temporary, content)) return false;
	if (rename(temporary, config_file)) return true;
	unlink(temporary);
	return false;
}

function configuration_plan(version) {
	let current = settings();
	let section = current.section;
	let result = { version: version, major: int(split(version, '.')[0]), needs_upgrade: false, can_upgrade: false };
	if (result.major != 10 && result.major != 11) die('Unsupported openNDS version: ' + version);
	result.local_fasport = result.major == 11 ? '443' : '0';
	if (result.major != 11) return { status: result, current: current };
	let original = read_config_text();
	let legacy = section['.anonymous'] == true;
	if (length(current.sections) != 1 || (!legacy && section['.name'] != 'setup'))
		die('Configuration sections require manual review; automatic upgrade is unavailable');
	let named = false;
	current.cursor.foreach('opennds', null, function(s) {
		if (s['.name'] == 'setup' && s['.type'] != 'opennds') named = true;
	});
	if (named) die('The setup section name is already in use');
	let mode = section.login_option_enabled;
	let port = section.fasport;
	let values = {};
	if ((legacy || port == '0') && (mode == null || mode == '0') && (port == null || port == '0')) {
		values.login_option_enabled = '1'; // Preserve the old implicit click-to-continue mode.
		mode = '1';
	} else if (legacy && mode == null) {
		values.login_option_enabled = '0'; // Preserve an existing external FAS.
		mode = '0';
	}
	if ((mode == '1' || mode == '2' || mode == '3') && port == '0') values.fasport = '443';
	result.needs_upgrade = legacy || length(keys(values)) > 0;
	if (result.needs_upgrade) {
		let changes = current.cursor.changes('opennds');
		if (changes == null) die('Unable to check pending configuration changes');
		if (length(keys(changes))) die('Apply or discard pending openNDS changes before upgrading');
		result.can_upgrade = true;
		result.reason = legacy ? 'legacy_section' : 'legacy_local_fas';
	}
	return { status: result, current: current, original: original, legacy: legacy, values: values };
}

function inspect_config(callback) {
	// opennds -v intentionally exits with status 1 in both supported versions.
	return execute('timeout -s KILL 2 /usr/bin/opennds -v', function(command) {
		let version = match(command.output || '', /This is openNDS version ([0-9]+\.[0-9]+\.[0-9]+)/);
		if ((command.code != 0 && command.code != 1) || !version) {
			callback({ error: 'Unable to determine installed openNDS version', can_upgrade: false });
			return;
		}
		let result;
		try {
			result = configuration_plan(version[1]).status;
		} catch (e) {
			result = { version: version[1], error: '' + e, can_upgrade: false };
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

function html_unescape(value) {
	value = replace(value, '&#96;', '`');
	value = replace(value, '&#39;', "'");
	value = replace(value, '&quot;', '"');
	value = replace(value, '&gt;', '>');
	value = replace(value, '&lt;', '<');
	return replace(value, '&amp;', '&');
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
					data.gateway_name = html_unescape(config.gatewayname || 'openNDS');
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

				execute('timeout -s KILL 5 /usr/bin/ucode /usr/libexec/luci-opennds-status.uc json', function(clients) {
					try {
						if (clients.code != 0) die('ndsctl json failed');
						let raw = json(clients.output);
						if (type(raw) != 'object') die('Invalid ndsctl JSON response');
						data.clients = raw.clients || {};
						data.trusted = raw.trusted || [];
					} catch (e) {
						result.error = '' + e;
					}
					// Read daemon metadata separately from client records.
					execute('timeout -s KILL 5 /usr/bin/ucode /usr/libexec/luci-opennds-status.uc status', function(status) {
						if (status.code == 0) {
							let lines = split(status.output, '\n');
							for (let i = 0; i < length(lines); i++) {
								// ucode uses POSIX ERE; avoid JavaScript-only regex syntax.
								let version = match(lines[i], /^Version: (.+)$/);
								let uptime = match(lines[i], /^Uptime: (.+)$/);
								let name = match(lines[i], /^Gateway Name: \[ (.*) \]$/);
								let device = match(lines[i], /^Managed interface: ([^ ]+)/);
								let port = match(lines[i], /^MHD Server .*listening on: http:\/\/.*:([0-9]+)$/);
								if (version) data.version = trim(version[1]);
								if (uptime) data.uptime = trim(uptime[1]);
								if (name) data.gateway_name = html_unescape(name[1]);
								if (device) data.interface = device[1];
								if (port) data.gateway_port = port[1];
							}
						} else {
							result.error = result.error || 'ndsctl status failed: ' + status.output;
						}
						request.reply(result);
					});
				});
			});
		}
	},

	check_config: {
		call: function(request) { return inspect_config(function(result) { request.reply(result); }); }
	},

	upgrade_config: {
		call: function(request) {
			if (upgrading || restarting) return { code: 1, message: 'openNDS configuration operation is already in progress' };
			upgrading = true;
			return execute('timeout -s KILL 2 pidof opennds', function(process) {
				if (process.code != 1) {
					upgrading = false;
					request.reply({ code: 1, message: process.code == 0 ? 'Stop openNDS before upgrading its configuration' : 'Unable to query openNDS process' });
					return;
				}
				return inspect_config(function(diagnostic) {
					let backup;
					let original;
					let committing = false;
					try {
						if (diagnostic.error) die(diagnostic.error);
						// Rebuild the plan at click time; never trust a browser-supplied version or section.
						let plan = configuration_plan(diagnostic.version);
						if (!plan.status.can_upgrade) die('No supported configuration upgrade is required');
						original = plan.original;
						backup = backup_config(original);
						if (read_config_text() != original) die('Configuration changed during upgrade; retry after reviewing it');
						let u = plan.current.cursor;
						let sid = plan.current.section['.name'];
						if (plan.legacy) {
							if (!u.rename('opennds', sid, 'setup')) die('Unable to name the openNDS configuration section');
							sid = 'setup';
						}
						for (let key in plan.values)
							if (!u.set('opennds', sid, key, plan.values[key])) die('Unable to update openNDS configuration');
						committing = true;
						if (!u.commit('opennds')) die('Unable to commit upgraded configuration');
						let checked = configuration_plan(diagnostic.version);
						if (checked.status.needs_upgrade || !match(read_config_text(), /config opennds 'setup'/))
							die('Upgraded configuration failed validation');
					} catch (e) {
						let restored = !committing || restore_config(original, backup);
						upgrading = false;
						request.reply({ code: 2, upgraded: false, backup: backup, restored: restored,
							message: '' + e + (restored ? '' : '; automatic rollback failed, restore the backup manually') });
						return;
					}
					return restart(function(result) {
						upgrading = false;
						request.reply({ code: result.code, upgraded: true, backup: backup,
							message: result.code == 0 ? 'Configuration upgraded; verify daemon status' : 'Configuration upgraded, but openNDS restart failed', output: result.output });
					});
				});
			});
		}
	},

	client_action: {
		args: { action: '', mac: '', duration: -1 },
		call: function(request) {
			let args = request?.args || request || {};
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
			if (upgrading) return { code: 1, message: 'openNDS configuration upgrade is in progress' };
			return restart(function(result) { request.reply(result); });
		}
	},

	get_log: {
		args: { lines: 0 },
		call: function(request) {
			let args = request?.args || request || {};
			let count = int(args.lines || 50);
			if (count != count || count <= 0 || count > 500) count = 50;
			return execute(sprintf('timeout -s KILL 3 logread -e opennds -l %d', count), function(result) {
				if (result.code != 0) {
					request.reply({ code: result.code, error: result.output || 'Unable to read openNDS log' });
					return;
				}
				let lines = [];
				if (result.code == 0) {
					let raw = split(result.output, '\n');
					for (let i = 0; i < length(raw); i++) {
						if (length(trim(raw[i]))) push(lines, raw[i]);
					}
				}
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
			if (restarting || upgrading) return { code: 1, message: 'openNDS configuration operation is in progress; try saving again later' };
			let args = request?.args || request || {};
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
				if (diagnostic.error || diagnostic.needs_upgrade) {
					request.reply({ code: 3, message: diagnostic.error || 'Upgrade the openNDS configuration from Overview before saving the portal' });
					return;
				}
				if (restarting || upgrading) {
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
				let flushed = fp.flush();
				let closed = fp.close();
				if (written != length(content) || !flushed || !closed || !rename(temporary, portal_file)) {
					unlink(temporary);
					request.reply({ code: 2, message: 'Unable to persist portal configuration' }); return;
				}

				try {
					let u = current.cursor;
					let section = current.section['.name'];
					if ((current.section.login_option_enabled || (diagnostic.major == 11 ? '1' : '0')) == '0' && int(current.section.fasport) > 0 &&
						!u.set('opennds', section, 'luci_fasport', current.section.fasport))
						die('Unable to preserve FAS port');
					if (!u.set('opennds', section, 'gatewayname', replace(clean.title, "'", '&#39;')) ||
						!u.set('opennds', section, 'fasport', diagnostic.local_fasport) ||
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
