'use strict';
'require view';
'require form';
'require uci';
'require rpc';
'require opennds as nds';
'require tools.widgets as widgets';

function unsigned(value, minimum, maximum) {
	return value === '' || value == null || (/^[0-9]+$/).test(value) &&
		Number.isSafeInteger(Number(value)) && Number(value) >= minimum && Number(value) <= maximum;
}

function absolutePath(value) {
	return !value || (/^\/(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\/?$/).test(value);
}

function ruleValid(value) {
	value = value.replace(/[ \t]+/g, ' ');
	var rule = (/^(allow|block|passthrough)(?: (all|tcp|udp))?(?: port ([0-9]+(?:-[0-9]+)?))?(?: (to|from) ([A-Za-z0-9._/-]+))?$/).exec(value);
	// Native v11 loses the address in "block to X" and the protocol without a port.
	if (!rule || !rule[2] || rule[2] !== 'all' && !rule[3] || rule[3] && rule[2] !== 'tcp' && rule[2] !== 'udp') return false;
	if (rule[3]) {
		var ports = rule[3].split('-');
		if (!ports.every(function(port) { return unsigned(port, 1, 65535); }) || Number(ports[0]) > Number(ports[ports.length - 1])) return false;
	}
	if (!rule[5]) return true;
	var address = rule[5].split('/');
	if ((/^[0-9.]+$/).test(address[0]))
		return address.length <= 2 && address[0].split('.').length === 4 &&
			address[0].split('.').every(function(part) { return part !== '' && unsigned(part, 0, 255); }) &&
			(address.length === 1 || address[1] !== '' && unsigned(address[1], 0, 32));
	return address.length === 1 && address[0].length <= 253 && address[0].split('.').every(function(label) {
		return (/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/).test(label);
	});
}

function preemptiveValid(value) {
	var found = Object.create(null);
	var valid = value.split(';').every(function(part) {
		var pair = part.split('=');
		if (pair.length !== 2 || found[pair[0]]) return false;
		found[pair[0]] = true;
		if (pair[0] === 'mac') return (/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/i).test(pair[1]);
		if (pair[0] === 'custom') return (/^[A-Za-z0-9_.:@+/-]*$/).test(pair[1]);
		return ['sessiontimeout', 'uploadrate', 'downloadrate', 'uploadquota', 'downloadquota'].indexOf(pair[0]) >= 0 &&
			pair[1] !== '' && unsigned(pair[1], 0, 4294967295);
	});
	return valid && !!found.mac;
}

function customValid(value, kind) {
	var pair = (/^([A-Za-z_][A-Za-z0-9_]*)=(.+)$/).exec(value);
	if (!pair || (/[\s,'"`$\\<>|&]/).test(value) || (/%(?![0-9A-Fa-f]{2})/).test(value)) return false;
	if (kind === 'images' || kind === 'files')
		return (/^[A-Za-z][A-Za-z0-9_]*_[A-Za-z0-9]+$/).test(pair[1]) && (/^(https?:\/\/[^/]+\/|file:\/\/\/).+/).test(pair[2]);
	if (kind === 'variables' && pair[1] === 'input')
		return pair[2].split(';').every(function(field) {
			return (/^[A-Za-z_][A-Za-z0-9_]*:[^:;]+:(text|email|tel|number|password|date|url)$/).test(field);
		});
	return true;
}

// Keep native TextValue as the form's single source of truth and validator.
// Only the selected row is rewritten; advanced syntax and ordering survive.
function visualList(option, kind) {
	option.description = (option.description || '').replace('<br />' + _('One entry per line. Order is preserved; an empty field removes the custom list.'), '');
	option.renderWidget = function(section_id, option_index, cfgvalue) {
		var native = form.TextValue.prototype.renderWidget.call(this, section_id, option_index, cfgvalue);
		var input = native.querySelector('textarea') || native;
		var rows = [], list = E('div', { 'class': 'opennds-rule-list' });
		var readonly = this.readonly != null ? this.readonly : this.map.readonly;
		var error = E('p', { 'role': 'alert', 'style': 'color:var(--error-color,#b91c1c)' });
		var sync = function() {
			input.value = rows.map(function(row) { return row.value; }).join('\n');
			input.dispatchEvent(new Event('input', { bubbles: true }));
			input.dispatchEvent(new Event('change', { bubbles: true }));
		};
		function field(label, control) {
			control.setAttribute('aria-label', label);
			control.disabled = !!readonly;
			return E('label', { 'style': 'display:flex;flex-direction:column;gap:4px;min-width:0' }, [label, control]);
		}
		function select(values, value) {
			var node = E('select', { 'class': 'cbi-input-select', 'style': 'width:100%' }, values.map(function(item) {
				return E('option', { 'value': item[0] }, [item[1]]);
			}));
			node.value = value;
			return node;
		}
		function text(value, placeholder) {
			var node = E('input', { 'type': 'text', 'class': 'cbi-input-text', 'placeholder': placeholder || '', 'style': 'width:100%;box-sizing:border-box' });
			node.value = value || '';
			return node;
		}
		function add(value) {
			var row = { value: value }, controls = [];
			var match = kind === 'rule' ? (/^(allow|block) (all|tcp|udp)(?: port ([0-9]+(?:-[0-9]+)?))?(?: to ([A-Za-z0-9._/-]+))?$/).exec(value) : null;
			var pairs = {};
			if (kind === 'device') value.split(';').forEach(function(part) { var pair = part.split('='); pairs[pair[0]] = pair[1]; });
			var supported = kind === 'rule' ? !!match && ruleValid(value) : preemptiveValid(value);
			var node = E('div', { 'style': 'padding:12px 0;border-bottom:1px solid #ddd' });
			if (supported || !value) {
				if (kind === 'rule') {
					var action = select([['allow', _('Allow')], ['block', _('Deny')]], match ? match[1] : 'allow');
					var protocol = select([['tcp', 'TCP'], ['udp', 'UDP'], ['both', _('TCP and UDP')], ['all', _('All protocols')]], match ? match[2] : 'tcp');
					var port = text(match && match[3], '443 / 8000-8010');
					var address = text(match && match[4], _('Any address'));
					controls = [field(_('Action'), action), field(_('Protocol'), protocol), field(_('Port or range'), port), field(_('Destination IP or subnet'), address)];
					var update = function() {
						port.disabled = !!readonly || protocol.value === 'all';
						row.value = (protocol.value === 'both' ? ['tcp', 'udp'] : [protocol.value]).map(function(name) {
							return action.value + ' ' + name + (name === 'all' ? '' : ' port ' + port.value.trim()) + (address.value.trim() ? ' to ' + address.value.trim() : '');
						}).join('\n');
						error.innerText = row.value.split('\n').every(ruleValid) ? '' : _('Enter a port from 1 to 65535, or an ascending range, and a valid destination.');
						sync();
					};
					port.disabled = !!readonly || protocol.value === 'all';
					[action, protocol, port, address].forEach(function(control) { control.addEventListener('change', update); control.addEventListener('input', update); });
				} else {
					var names = ['mac', 'sessiontimeout', 'uploadrate', 'downloadrate', 'uploadquota', 'downloadquota', 'custom'];
					var labels = [_('MAC address'), _('Session duration (minutes)'), _('Upload speed (kbit/s)'), _('Download speed (kbit/s)'), _('Upload quota (kB)'), _('Download quota (kB)'), _('Device note')];
					var inputs = names.map(function(name, i) { var control = text(pairs[name], name === 'mac' ? 'AA:BB:CC:DD:EE:FF' : _('Inherit default')); controls.push(field(labels[i], control)); return control; });
					var update = function() {
						row.value = names.map(function(name, i) { return inputs[i].value.trim() ? name + '=' + inputs[i].value.trim() : ''; }).filter(Boolean).join(';');
						error.innerText = preemptiveValid(row.value) ? '' : _('Enter a valid MAC address and non-negative integer limits.');
						sync();
					};
					inputs.forEach(function(control) { control.addEventListener('input', update); });
				}
				node.appendChild(E('div', { 'style': 'display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,150px),1fr));gap:10px' }, controls));
			} else {
				node.appendChild(E('p', {}, [_('Advanced entry: preserved unchanged. Edit it in Expert Configuration.')]));
				node.appendChild(E('code', { 'style': 'white-space:pre-wrap;overflow-wrap:anywhere' }, [value]));
			}
			node.appendChild(E('button', { 'type': 'button', 'class': 'cbi-button cbi-button-remove', 'disabled': readonly ? '' : null,
				'style': 'margin-top:8px', 'click': function() { rows.splice(rows.indexOf(row), 1); node.remove(); error.innerText = ''; sync(); }
			}, [_('Remove')]));
			rows.push(row); list.appendChild(node);
		}
		(cfgvalue || '').split('\n').filter(function(line) { return line.trim(); }).forEach(add);
		// Raw values remain inspectable, but edits go through the visual controls.
		input.readOnly = true;
		return E('div', {}, [list, error, E('button', { 'type': 'button', 'class': 'cbi-button cbi-button-add', 'disabled': readonly ? '' : null,
			'click': function() { add(''); sync(); }
		}, [kind === 'rule' ? _('Add rule') : _('Add device')]), E('details', { 'style': 'margin-top:10px' }, [E('summary', {}, [_('Show native entries')]), native])]);
	};
	return option;
}

return view.extend({
	load: function() {
		var callHostHints = rpc.declare({
			object: 'luci-rpc',
			method: 'getHostHints',
			reject: true,
			expect: { '': {} }
		});
		return Promise.all([
			uci.load('opennds'),
			callHostHints().then(function(hosts) { return { hosts: hosts }; })
				.catch(function() { return { hosts: {}, failed: true }; }),
			nds.checkConfig().then(function(result) {
				if (result.error || result.major !== 11) throw new Error(result.error || _('Unable to check openNDS configuration.'));
				return result;
			})
		]);
	},

	render: function(data) {
		var m, s, o;
		var hints = data && data[1] || { hosts: {} };

		m = new form.Map('opennds', _('openNDS Gateway Configuration'),
			_('Configure network interfaces, authentication policies, FAS, rate limits, and access controls for openNDS.'));

		/* =========================================================
		 * Main Section: openNDS Configuration Tabs
		 * ========================================================= */
		s = m.section(form.NamedSection, 'setup', 'opennds', _('Gateway & Authentication Parameters'));
		s.addremove = false;

		s.tab('general', _('General Settings'));
		s.tab('auth', _('Authentication & FAS'));
		s.tab('traffic', _('Traffic Control & Quotas'));
		s.tab('access', _('Access Control & Walled Garden'));
		s.tab('portal', _('Portal & Resources'));
		s.tab('advanced', _('Advanced & Logging'));

		function numberOption(tab, name, title, description, placeholder, minimum, maximum) {
			var option = s.taboption(tab, form.Value, name, title, description);
			option.placeholder = placeholder;
			option.rmempty = true;
			option.retain = true;
			option.validate = function(section_id, value) {
				return unsigned(value, minimum, maximum) ? true : _('Enter an integer in the allowed range.');
			};
			return option;
		}
		function pathOption(tab, name, title, description, placeholder) {
			var option = s.taboption(tab, form.Value, name, title, description);
			option.placeholder = placeholder;
			option.rmempty = true;
			option.retain = true;
			option.validate = function(section_id, value) { return absolutePath(value) ? true : _('Enter an absolute path without spaces or shell characters.'); };
			return option;
		}
		function listOption(tab, name, title, description, validate) {
			var option = s.taboption(tab, form.TextValue, name, title,
				'<span style="overflow-wrap:anywhere">' + description + '<br />' +
				_('One entry per line. Order is preserved; an empty field removes the custom list.') + '</span>');
			option.rows = 4;
			option.wrap = true;
			option.rmempty = true;
			option.retain = true;
			option.cfgvalue = function(section_id) {
				var stored = uci.get('opennds', section_id, name);
				return Array.isArray(stored) ? stored.join('\n') : stored || '';
			};
			option.validate = function(section_id, value) {
				if (value === option.cfgvalue(section_id)) return true;
				var lines = (value || '').split('\n');
				var existing = (option.cfgvalue(section_id) || '').split('\n').map(function(line) { return line.trim(); });
				for (var i = 0; i < lines.length; i++) {
					if (!lines[i].trim() || validate(lines[i].trim())) continue;
					var index = existing.indexOf(lines[i].trim());
					if (index < 0) return _('Invalid entry at line') + ' ' + (i + 1);
					existing.splice(index, 1);
				}
				return true;
			};
			option.write = function(section_id, value) {
				var lines = (value || '').split(/\r?\n/).filter(function(line) { return line.trim(); });
				if (lines.length) uci.set('opennds', section_id, name, lines);
				else uci.unset('opennds', section_id, name);
			};
			return option;
		}
		function inheritedSwitch(tab, name, title, description) {
			var option = s.taboption(tab, form.ListValue, name, title, description);
			option.value('', _('Inherit default (enabled)'));
			option.value('1', _('Enabled'));
			option.value('0', _('Disabled'));
			option.rmempty = true;
			return option;
		}
		var features = [];
		function feature(tab, name, title, choices, initial, disable) {
			var option = s.taboption(tab, form.ListValue, name, title);
			choices.forEach(function(choice) { option.value(choice[0], choice[1]); });
			option._featureValue = initial;
			option.cfgvalue = function() { return option._featureValue; };
			option.write = option.remove = function() {};
			option.rmempty = false;
			features.push({ option: option, initial: initial, disable: disable });
			return option;
		}
		function hasList(name) { var value = uci.get('opennds', 'setup', name); return Array.isArray(value) ? value.length > 0 : !!value; }
		var switches = [['0', _('Disabled')], ['1', _('Enabled')]];

		/* ---------------------------------------------------------
		 * Tab 1: General Settings
		 * --------------------------------------------------------- */
		o = s.taboption('general', form.Flag, 'enabled', _('Enable openNDS daemon'),
			_('Controls whether the daemon is allowed to run. Service autostart can be configured in System → Startup.'));
		o.rmempty = false;
		o.default = '1';

		o = s.taboption('general', form.Flag, 'fwhook_enabled', _('Firewall reload hook (fwhook_enabled)'),
			_('Re-inject openNDS rules when OpenWrt firewall (FW4/nftables) restarts. Required to prevent rule loss.'));
		o.default = '1';
		o.rmempty = false;

		o = s.taboption('general', widgets.DeviceSelect, 'gatewayinterface', _('Gateway interface (gatewayinterface)'),
			_('Network interface where openNDS listens and intercepts HTTP traffic (default is br-lan).'));
		o.default = 'br-lan';
		o.rmempty = false;

		o = s.taboption('general', form.Value, 'gatewayname', _('Gateway name (gatewayname)'),
			_('Hotspot/venue name displayed on the portal authentication page (default is openNDS).'));
		o.default = 'openNDS';
		o.placeholder = 'openNDS';
		o.rmempty = false;
		o.validate = function(section_id, value) {
			// Parentheses let the SDK's jsmin recognize this regular expression.
			return (/['\r\n]/).test(value || '') ? _('Name cannot contain line breaks or single quotes. Use &#39; for single quotes.') : true;
		};
		inheritedSwitch('general', 'enable_serial_number_suffix', _('Append device serial number'),
			_('Append a MAC-derived suffix to the gateway name. Empty inherits enabled. Changing it also changes the FAS gateway identifier.'));

		o = s.taboption('general', form.Value, 'gatewayport', _('Gateway web server port (gatewayport)'),
			_('Port for openNDS embedded web server, default 2050 (port 80 is prohibited).'));
		o.datatype = 'port';
		o.default = '2050';
		o.validate = function(section_id, value) {
			return Number(value) === 80 ? _('Gateway port cannot be 80.') : true;
		};

		o = s.taboption('general', form.Value, 'gatewayfqdn', _('Gateway FQDN (gatewayfqdn)'),
			_('Virtual domain used by clients to access the portal (default status.client).'));
		o.default = 'status.client';

		o = s.taboption('general', form.Value, 'maxclients', _('Maximum client capacity (maxclients)'),
			_('Maximum concurrent connected clients allowed before queuing new connections.'));
		o.datatype = 'range(10, 1000)';
		o.default = '250';

		o = s.taboption('general', form.Value, 'checkinterval', _('Check interval (seconds)'),
			_('Interval for polling client timeouts and quota consumption.'));
		o.datatype = 'and(uinteger,min(1))';
		o.default = '15';

		o = s.taboption('general', form.ListValue, 'debuglevel', _('Debug log level (debuglevel)'));
		o.value('0', _('0 - Silent (errors only)'));
		o.value('1', _('1 - Normal notices (default)'));
		o.value('2', _('2 - Detailed status (INFO)'));
		o.value('3', _('3 - Full trace (DEBUG)'));
		o.default = '1';

		/* ---------------------------------------------------------
		 * Tab 2: Authentication & FAS
		 * --------------------------------------------------------- */
		o = s.taboption('auth', form.ListValue, 'login_option_enabled', _('Authentication policy (login_option_enabled)'),
			_('Specify the authentication workflow: Click to Continue, User Login, FAS, or Custom ThemeSpec.'));
		o.value('1', _('1. Dynamic Click to Continue'));
		o.value('2', _('2. Username / Email Login'));
		o.value('0', _('3. External FAS server'));
		o.value('3', _('4. Custom ThemeSpec script'));
		o.default = '1';

		// FAS Settings (Dependencies: login_option_enabled == '0')
		o = s.taboption('auth', form.Value, 'fasremotefqdn', _('Remote FAS FQDN (fasremotefqdn)'),
			_('Fully qualified domain name of remote FAS server, without http:// or https:// prefix.'));
		o.depends('login_option_enabled', '0');
		o.retain = true;
		o.placeholder = 'portal.mydomain.com';
		o.datatype = 'hostname';

		o = s.taboption('auth', form.Value, 'fasremoteip', _('Remote FAS IP (fasremoteip)'),
			_('IPv4 address of remote FAS server. Defaults to gateway IP if unset.'));
		o.depends('login_option_enabled', '0');
		o.retain = true;
		o.datatype = 'ip4addr';
		o.placeholder = '198.51.100.1';

		o = s.taboption('auth', form.Value, 'fasport', _('FAS port (fasport)'),
			_('Port on which FAS server listens (typically 80 or 443).'));
		o.depends('login_option_enabled', '0');
		o.retain = true;
		o.datatype = 'port';
		o.placeholder = '443';
		o.validate = function(section_id, value) {
			return value !== '' && value != null && Number(value) === 0
				? _('For openNDS v11, select a local authentication mode instead of setting FAS port to 0.') : true;
		};
		var fasPort = o;
		fasPort.cfgvalue = function(section_id) {
			var port = uci.get('opennds', section_id, 'fasport');
			var mode = uci.get('opennds', section_id, 'login_option_enabled') || '1';
			return mode !== '0' ? uci.get('opennds', section_id, 'luci_fasport') || '' : port;
		};

		o = s.taboption('auth', form.Value, 'faspath', _('FAS path (faspath)'),
			_('Path from FAS web root to login script.'));
		o.depends('login_option_enabled', '0');
		o.retain = true;
		o.placeholder = '/fas/auth.php';
		o.validate = function(section_id, value) {
			return !value || /^\/[^\s]*$/.test(value) ? true : _('Path must start with / and contain no spaces.');
		};

		o = s.taboption('auth', form.ListValue, 'fas_secure_enabled', _('FAS security level (fas_secure_enabled)'),
			_('FAS protocol and token security level. Levels 3 and 4 enforce HTTPS and authmon.'));
		o.depends('login_option_enabled', '0');
		o.retain = true;
		o.value('0', _('0 - Plaintext HTTP (insecure, testing only)'));
		o.value('1', _('1 - Basic SHA256 hash token (HTTP)'));
		o.value('2', _('2 - AES-256-CBC encryption (HTTP, requires php-openssl)'));
		o.value('3', _('3 - AES-256-CBC + HTTPS + authmon (recommended for production)'));
		o.value('4', _('4 - SHA256 hash token + HTTPS + authmon'));
		o.default = '1';

		o = s.taboption('auth', form.Value, 'faskey', _('FAS pre-shared key (faskey)'),
			_('Pre-shared key between openNDS and FAS for encryption and signature validation.'));
		o.depends('login_option_enabled', '0');
		o.retain = true;
		o.password = true;
		o.validate = function(section_id, value) {
			return !/\s/.test(value || '') ? true : _('Key cannot contain whitespace.');
		};

		numberOption('auth', 'reauth_interval', _('Minimum reauthentication interval (seconds)'),
			_('Wait after deauthentication before accepting another login. Empty or 0 disables the delay. Requires the plugin BinAuth hook.'), '0', 0, 4294967295);
		o = numberOption('auth', 'nat_traversal_poll_interval', _('Authmon polling interval (seconds)'),
			_('Native Authmon accepts 1–59 seconds. Empty uses 5 seconds; 60 falls back to 5 in this version.'), '5', 1, 59);
		o.depends({ login_option_enabled: '0', fas_secure_enabled: '3' });
		o.depends({ login_option_enabled: '0', fas_secure_enabled: '4' });

		/* ---------------------------------------------------------
		 * Tab 3: Traffic Control & Quotas
		 * --------------------------------------------------------- */
		var traffic = [
			['sessiontimeout', _('Session timeout (minutes)'), _('Client session timeout before requiring re-authentication. 0 means unlimited (default 1440 min).'), '1440'],
			['authidletimeout', _('Authenticated idle timeout (minutes)'), _('Idle timeout before disconnecting inactive authenticated clients (default 120 min).'), '120'],
			['preauthidletimeout', _('Preauthenticated idle timeout (minutes)'), _('Timeout for clients in preauth state before dropping connection (default 30 min).'), '30'],
			['downloadrate', _('Download rate limit (downloadrate - kb/s)'), _('Client download rate limit calculated over rate check window, 0 for unlimited.'), '0'],
			['uploadrate', _('Upload rate limit (uploadrate - kb/s)'), _('Client upload rate limit calculated over rate check window, 0 for unlimited.'), '0'],
			['ratecheckwindow', _('Rate check window (ratecheckwindow)'), _('Window multiplier for average rate calculation (duration = checkinterval * ratecheckwindow). Set 0 to disable.'), '2', 'range(0, 10)'],
			['downloadquota', _('Download quota (downloadquota - kB)'), _('Client download quota limit before requiring re-authentication, 0 for unlimited.'), '0'],
			['uploadquota', _('Upload quota (uploadquota - kB)'), _('Client upload quota limit before requiring re-authentication, 0 for unlimited.'), '0']
		];
		var speedInputs = {};
		traffic.forEach(function(field) {
			if (field[0] === 'downloadrate') {
				var speedToggle = feature('traffic', '_luci_rates', _('Limit default connection speed'), switches,
				uci.get('opennds', 'setup', 'ratecheckwindow') !== '0' && (Number(uci.get('opennds', 'setup', 'uploadrate')) > 0 || Number(uci.get('opennds', 'setup', 'downloadrate')) > 0) ? '1' : '0', function() {
					uci.set('opennds', 'setup', 'uploadrate', '0'); uci.set('opennds', 'setup', 'downloadrate', '0');
				});
				speedToggle.validate = function(section_id, value) {
					return value !== '1' || Number(speedInputs.uploadrate.formvalue(section_id)) > 0 || Number(speedInputs.downloadrate.formvalue(section_id)) > 0
						? true : _('Set a positive upload or download speed.');
				};
			}
			var direction, choice;
			if (field[0] === 'uploadquota' || field[0] === 'downloadquota') {
				direction = field[0] === 'uploadquota' ? 'upload' : 'download';
				var quota = uci.get('opennds', 'setup', field[0]);
				var throttle = uci.get('opennds', 'setup', 'fup_' + direction + '_throttle_rate');
				choice = feature('traffic', '_luci_' + direction + '_quota', direction === 'upload' ? _('Upload allowance') : _('Download allowance'),
					[['0', _('Unlimited')], ['stop', _('Stop access when exceeded')], ['throttle', _('Reduce speed when exceeded')]],
					Number(quota) > 0 ? Number(throttle) > 0 ? 'throttle' : 'stop' : '0', function() { uci.set('opennds', 'setup', field[0], '0'); });
			}
			var option = s.taboption('traffic', form.Value, field[0], field[1], field[2]);
			option.default = field[3];
			option.datatype = field[4] || 'uinteger';
			option.retain = true;
			if (field[0] === 'uploadrate' || field[0] === 'downloadrate' || field[0] === 'ratecheckwindow') option.depends('_luci_rates', '1');
			if (field[0] === 'uploadrate' || field[0] === 'downloadrate') speedInputs[field[0]] = option;
			if (field[0] === 'ratecheckwindow') {
				option.depends('_luci_upload_quota', 'throttle');
				option.depends('_luci_download_quota', 'throttle');
				option.validate = function(section_id, value) {
					return unsigned(value, 1, 10) && Number(value) > 0 ? true : _('Use a rate check window from 1 to 10 when speed limits are enabled.');
				};
			}
			if (choice) {
				option.depends('_luci_' + direction + '_quota', 'stop');
				option.depends('_luci_' + direction + '_quota', 'throttle');
				option.validate = function(section_id, value) { return unsigned(value, 1, Number.MAX_SAFE_INTEGER) && Number(value) > 0 ? true : _('Enter a positive allowance in kB.'); };
				var speed = numberOption('traffic', 'fup_' + direction + '_throttle_rate',
					direction === 'upload' ? _('Upload speed after quota (kbit/s)') : _('Download speed after quota (kbit/s)'),
					_('Speed used after this allowance is exhausted.'), '128', 0, Number.MAX_SAFE_INTEGER);
				speed.depends('_luci_' + direction + '_quota', 'throttle');
				var validate = speed.validate;
				speed.validate = function(section_id, value) {
					if (choice.formvalue(section_id) !== 'throttle') return validate(section_id, value);
					return validate(section_id, value) === true && Number(value) > 0 ? true : _('Enter a positive speed in kbit/s.');
				};
			}
		});

		/* ---------------------------------------------------------
		 * Tab 4: Access Control & Walled Garden (DynamicList on opennds)
		 * --------------------------------------------------------- */
		var trustedDescription = _('Clients matching these MAC addresses bypass portal authentication entirely.') + '<br />' +
			_('Choose a discovered device by name, MAC or IP address, or enter a MAC address manually.');
		if (hints.failed)
			trustedDescription += '<br /><strong>' + _('Failed to read discovered devices; enter MAC addresses manually or reload the page.') + '</strong>';
		o = s.taboption('access', form.DynamicList, 'trustedmac', _('Trusted MAC whitelist (trustedmac)'), trustedDescription);
		o.datatype = 'macaddr';
		o.placeholder = _('-- Select a device --');
		var hosts = hints.hosts || {};
		var storedMacs = Object.create(null), seenMacs = Object.create(null);
		if (Object.keys(hosts).length) {
			uci.sections('opennds', 'opennds', function(section) {
				var values = Array.isArray(section.trustedmac) ? section.trustedmac : [section.trustedmac];
				values.forEach(function(mac) {
					if (typeof mac === 'string') storedMacs[mac.toLowerCase()] = mac;
				});
			});
		}
		Object.keys(hosts).sort().forEach(function(mac) {
			if (!(/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/i).test(mac) || seenMacs[mac.toLowerCase()]) return;
			var host = hosts[mac];
			if (!host || typeof host !== 'object' || Array.isArray(host)) return;
			seenMacs[mac.toLowerCase()] = true;
			var detail = typeof host.name === 'string' ? host.name.trim() : '';
			if (!detail)
				detail = [].concat(host.ipaddrs || [], host.ipv4 || [], host.ip6addrs || [], host.ipv6 || [])
					.find(function(address) { return typeof address === 'string' && address.trim(); });
			var value = storedMacs[mac.toLowerCase()] || mac;
			o.value(value, E('span', {}, [value + (detail ? '(' + detail.trim() + ')' : '')]));
		});

		o = s.taboption('access', form.Flag, 'allow_preemptive_authentication', _('Allow devices to skip login with usage limits'),
			_('Unlike fully trusted devices, these devices still have session, speed and traffic limits.'));
		o.default = '1';
		o.rmempty = false;
		visualList(listOption('access', 'preemptivemac', _('Devices that skip login but keep usage limits'),
			_('Add a MAC address and optional limits. Empty or zero limits inherit the global settings.'), preemptiveValid), 'device').depends('allow_preemptive_authentication', '1');
		visualList(listOption('access', 'preauthenticated_users', _('Rules before authentication'),
			_('Rules for devices that have not logged in. Empty uses the native default policy.'), ruleValid), 'rule');
		visualList(listOption('access', 'authenticated_users', _('Rules after authentication'),
			_('Custom rules replace the default allow-all policy. Add an Allow / All protocols rule for other traffic if it should remain accessible.'), ruleValid), 'rule');
		visualList(listOption('access', 'users_to_router', _('Rules for access to the router'),
			_('Native DNS, DHCP, SSH and HTTPS management rules remain included.'), ruleValid), 'rule');
		[
			['walledgarden_fqdn_list', _('Walled garden FQDN list (walledgarden_fqdn_list)'), _('Domains accessible to preauthenticated clients before logging in.'), 'host(0)', 'captive.apple.com'],
			['walledgarden_port_list', _('Walled garden port list (walledgarden_port_list)'), _('Allowed ports for walled garden domains (typically 443; empty allows all ports).'), 'port', '443'],
			['blocklist_fqdn_list', _('Blocked FQDN list (blocklist_fqdn_list)'), _('Domains blocked even for authenticated clients.'), 'host(0)', 'unwanted-domain.com'],
			['blocklist_port_list', _('Blocked port list (blocklist_port_list)'), _('Ports blocked for blocklist domains (empty blocks all ports).'), 'port', '80']
		].forEach(function(field) {
			var group = field[0].indexOf('walledgarden') === 0 ? 'walledgarden' : 'blocklist';
			var choice;
			if (field[3] === 'host(0)') choice = feature('access', '_luci_' + group,
				group === 'walledgarden' ? _('Allow websites before login') : _('Block websites after login'), switches, hasList(field[0]) ? '1' : '0', function() {
					uci.unset('opennds', 'setup', group + '_fqdn_list'); uci.unset('opennds', 'setup', group + '_port_list');
				});
			var option = s.taboption('access', form.DynamicList, field[0], field[1], field[2]);
			option.datatype = field[3];
			option.placeholder = field[4];
			option.retain = true;
			option.depends('_luci_' + group, '1');
			if (choice) choice.validate = function(section_id, value) {
				var domains = option.formvalue(section_id);
				return value !== '1' || (Array.isArray(domains) ? domains.length > 0 : !!domains) ? true : _('Add at least one domain to enable this feature.');
			};
			if (field[3] === 'port') option.description = _('These ports apply to every domain in this group. Empty means all ports.');
		});

		// Portal and resources share the same UCI section as authentication.
		o = pathOption('portal', 'themespec_path', _('ThemeSpec script path (themespec_path)'),
			_('Absolute path to custom ThemeSpec script (default is /usr/lib/opennds/theme_click-to-continue-basic.sh).'), '/usr/lib/opennds/theme_click-to-continue-basic.sh');
		o.depends('login_option_enabled', '3');
		// Keep the existing ThemeSpec default when first selecting custom mode.
		o.default = '/usr/lib/opennds/theme_click-to-continue-basic.sh';
		o = pathOption('portal', 'statuspath', _('Status and error page script'),
			_('Empty uses the native status page. Explicit paths survive saving Portal Studio branding. The script must exist and be executable on the router.'), '/usr/lib/opennds/client_params.sh');
		o.value('/usr/lib/opennds/client_params.sh', _('Native status page'));
		o.value('/usr/lib/opennds/status_luci.sh', _('Plugin branded status page'));
		numberOption('portal', 'max_page_size', _('Maximum portal page size (bytes)'),
			_('Minimum 1024 bytes. Empty uses 10240. Larger pages consume more router memory; Portal Studio still checks its content against this limit.'), '10240', 1024, Number.MAX_SAFE_INTEGER);
		var resourceLists = ['parameters', 'variables', 'images', 'files'];
		o = feature('portal', '_luci_resources', _('Use custom portal resources'), switches,
			resourceLists.some(function(kind) { return hasList('fas_custom_' + kind + '_list'); }) ? '1' : '0', function() {
				resourceLists.forEach(function(kind) { uci.unset('opennds', 'setup', 'fas_custom_' + kind + '_list'); });
				uci.unset('opennds', 'setup', 'remotes_refresh_interval');
			});
		o.depends('login_option_enabled', '0'); o.depends('login_option_enabled', '3');
		o.retain = true;
		[
			['parameters', _('Custom FAS parameters'), _('Use name=value; encode spaces as %20 and single quotes as %27.')],
			['variables', _('Custom ThemeSpec variables'), _('Use name=value or input=phone:Phone%20number:tel;email:Email:email. Values are native definitions, not shell commands.')],
			['images', _('Custom portal images'), _('Use logo_png=https://example.com/logo.png. Native http://, https:// and file:/// URLs are accepted; encode URL separators such as & as %26.')],
			['files', _('Custom portal files'), _('Use advert_htm=https://example.com/advert.htm. Files are downloaded by the native theme when used.')]
		].forEach(function(field) {
			var option = listOption('portal', 'fas_custom_' + field[0] + '_list', field[1], field[2], function(value) { return customValid(value, field[0]); });
			option.depends({ login_option_enabled: '0', _luci_resources: '1' });
			option.depends({ login_option_enabled: '3', _luci_resources: '1' });
		});
		o = numberOption('portal', 'remotes_refresh_interval', _('Remote resource refresh interval (minutes)'),
			_('Empty or 0 disables periodic refresh. This applies to downloaded resources used by native themes.'), '0', 0, 4294967295);
		o.depends({ login_option_enabled: '0', _luci_resources: '1' });
		o.depends({ login_option_enabled: '3', _luci_resources: '1' });

		pathOption('advanced', 'log_mountpoint', _('Local authentication log mountpoint'),
			_('Empty uses /tmp. Select an existing writable RAM or external-storage mountpoint; avoid internal flash. This setting does not change syslog.'), '/tmp');
		numberOption('advanced', 'max_log_entries', _('Maximum local authentication log entries'),
			_('Empty uses 100 entries. 0 disables log rotation; ensure sufficient storage.'), '100', 0, Number.MAX_SAFE_INTEGER);
		pathOption('advanced', 'dhcp_leases_file', _('DHCP leases file'),
			_('Empty searches the native default lease files. Use an existing readable file for a custom dnsmasq instance.'), '/tmp/dhcp.leases');
		inheritedSwitch('advanced', 'fast_client_scan', _('Fast client interface scan'),
			_('Empty inherits enabled. Disable to search actual wireless interfaces; extended or mesh networks may scan more slowly.'));

		var previousMode = uci.get('opennds', 'setup', 'login_option_enabled') || '1';
		// Normalize after every option has parsed so hidden FAS fields cannot
		// reactivate an external portal while a local login mode is selected.
		var parse = m.parse;
		m.parse = function() {
			return parse.apply(this, arguments).then(function() {
				features.forEach(function(feature) {
					var value = feature.option.formvalue('setup');
					if (value === '0' && feature.initial !== '0') feature.disable();
					if (value === 'stop' && feature.initial !== 'stop') {
						var direction = feature.option.option || feature.option.name;
						direction = direction.indexOf('upload') >= 0 ? 'upload' : 'download';
						uci.set('opennds', 'setup', 'fup_' + direction + '_throttle_rate', '0');
					}
					if (value != null) { feature.initial = value; feature.option._featureValue = value; }
				});
				var mode = uci.get('opennds', 'setup', 'login_option_enabled') || '1';
				var port = fasPort.formvalue('setup');
				if (port == null) port = fasPort.cfgvalue('setup');
				if (mode === '0') {
					uci.set('opennds', 'setup', 'fasport', port || '443');
					uci.unset('opennds', 'setup', 'luci_fasport');
				} else {
					if (previousMode === '0') {
						if (port && port !== '0') uci.set('opennds', 'setup', 'luci_fasport', port);
						else uci.unset('opennds', 'setup', 'luci_fasport');
					}
					uci.set('opennds', 'setup', 'fasport', '443');
				}
				previousMode = mode;
			});
		};

		if (typeof window === 'undefined') return m.render();
		var dirty = false, saving = false, save = m.save, reset = m.reset;
		m.save = function() {
			saving = true;
			return save.apply(this, arguments).then(function(result) { dirty = false; return result; }).finally(function() { saving = false; });
		};
		m.reset = function() { return reset.apply(this, arguments).then(function(result) { dirty = false; return result; }); };
		if (this._unload) window.removeEventListener('beforeunload', this._unload);
		this._unload = function(event) { if (dirty || saving) { event.preventDefault(); event.returnValue = ''; } };
		window.addEventListener('beforeunload', this._unload);
		return m.render().then(function(root) {
			root.addEventListener('input', function() { dirty = true; });
			root.addEventListener('change', function() { dirty = true; });
			return root;
		});
	}
});
