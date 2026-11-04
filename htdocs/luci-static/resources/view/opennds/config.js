'use strict';
'require view';
'require form';
'require uci';
'require rpc';
'require tools.widgets as widgets';

return view.extend({
	load: function() {
		return uci.load('opennds');
	},

	render: function() {
		var m, s, o;

		m = new form.Map('opennds', _('openNDS Gateway Configuration'),
			_('Configure network interfaces, authentication policies, FAS, rate limits, and access controls for openNDS.'));

		/* =========================================================
		 * Main Section: openNDS Configuration Tabs
		 * ========================================================= */
		s = m.section(form.TypedSection, 'opennds', _('Gateway & Authentication Parameters'));
		s.anonymous = true;
		s.addremove = false;

		s.tab('general', _('General Settings'));
		s.tab('auth', _('Authentication & FAS'));
		s.tab('traffic', _('Traffic Control & Quotas'));
		s.tab('access', _('Access Control & Walled Garden'));

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

		o = s.taboption('general', form.Flag, 'allow_preemptive_authentication', _('Allow preemptive authentication (allow_preemptive_authentication)'),
			_('Allow ndsctl to authorize connected clients that have not yet entered the preauth state.'));
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
			return /['\r\n]/.test(value || '') ? _('Name cannot contain line breaks or single quotes. Use &#39; for single quotes.') : true;
		};

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
		o.value('0', _('3. Use FAS configuration (defaults to click-to-continue if FAS disabled)'));
		o.value('3', _('4. Custom ThemeSpec script'));
		o.default = '0';

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
		var fasPort = o;
		fasPort.cfgvalue = function(section_id) {
			var port = uci.get('opennds', section_id, 'fasport');
			return port && port !== '0' ? port : uci.get('opennds', section_id, 'luci_fasport') || port;
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

		// ThemeSpec Settings (Dependencies: login_option_enabled == '3')
		o = s.taboption('auth', form.Value, 'themespec_path', _('ThemeSpec script path (themespec_path)'),
			_('Absolute path to custom ThemeSpec script (default is /usr/lib/opennds/theme_click-to-continue-basic.sh).'));
		o.depends('login_option_enabled', '3');
		o.retain = true;
		o.default = '/usr/lib/opennds/theme_click-to-continue-basic.sh';
		o.placeholder = '/usr/lib/opennds/theme_click-to-continue-basic.sh';

		/* ---------------------------------------------------------
		 * Tab 3: Traffic Control & Quotas
		 * --------------------------------------------------------- */
		o = s.taboption('traffic', form.Value, 'sessiontimeout', _('Session timeout (minutes)'),
			_('Client session timeout before requiring re-authentication. 0 means unlimited (default 1440 min).'));
		o.datatype = 'uinteger';
		o.default = '1440';

		o = s.taboption('traffic', form.Value, 'authidletimeout', _('Authenticated idle timeout (minutes)'),
			_('Idle timeout before disconnecting inactive authenticated clients (default 120 min).'));
		o.datatype = 'uinteger';
		o.default = '120';

		o = s.taboption('traffic', form.Value, 'preauthidletimeout', _('Preauthenticated idle timeout (minutes)'),
			_('Timeout for clients in preauth state before dropping connection (default 30 min).'));
		o.datatype = 'uinteger';
		o.default = '30';

		o = s.taboption('traffic', form.Value, 'downloadrate', _('Download rate limit (downloadrate - kb/s)'),
			_('Client download rate limit calculated over rate check window, 0 for unlimited.'));
		o.datatype = 'uinteger';
		o.default = '0';

		o = s.taboption('traffic', form.Value, 'uploadrate', _('Upload rate limit (uploadrate - kb/s)'),
			_('Client upload rate limit calculated over rate check window, 0 for unlimited.'));
		o.datatype = 'uinteger';
		o.default = '0';

		o = s.taboption('traffic', form.Value, 'ratecheckwindow', _('Rate check window (ratecheckwindow)'),
			_('Window multiplier for average rate calculation (duration = checkinterval * ratecheckwindow). Set 0 to disable.'));
		o.datatype = 'range(0, 10)';
		o.default = '2';

		o = s.taboption('traffic', form.Value, 'downloadquota', _('Download quota (downloadquota - kB)'),
			_('Client download quota limit before requiring re-authentication, 0 for unlimited.'));
		o.datatype = 'uinteger';
		o.default = '0';

		o = s.taboption('traffic', form.Value, 'uploadquota', _('Upload quota (uploadquota - kB)'),
			_('Client upload quota limit before requiring re-authentication, 0 for unlimited.'));
		o.datatype = 'uinteger';
		o.default = '0';

		/* ---------------------------------------------------------
		 * Tab 4: Access Control & Walled Garden (DynamicList on opennds)
		 * --------------------------------------------------------- */
		o = s.taboption('access', form.DynamicList, 'trustedmac', _('Trusted MAC whitelist (trustedmac)'),
			_('Clients matching these MAC addresses bypass portal authentication entirely.'));
		o.datatype = 'macaddr';
		o.placeholder = '00:1E:0B:44:99:A1';

		o = s.taboption('access', form.DynamicList, 'walledgarden_fqdn_list', _('Walled garden FQDN list (walledgarden_fqdn_list)'),
			_('Domains accessible to preauthenticated clients before logging in.'));
		o.datatype = 'host(0)';
		o.placeholder = 'captive.apple.com';

		o = s.taboption('access', form.DynamicList, 'walledgarden_port_list', _('Walled garden port list (walledgarden_port_list)'),
			_('Allowed ports for walled garden domains (typically 443; empty allows all ports).'));
		o.datatype = 'port';
		o.placeholder = '443';

		o = s.taboption('access', form.DynamicList, 'blocklist_fqdn_list', _('Blocked FQDN list (blocklist_fqdn_list)'),
			_('Domains blocked even for authenticated clients.'));
		o.datatype = 'host(0)';
		o.placeholder = 'unwanted-domain.com';

		o = s.taboption('access', form.DynamicList, 'blocklist_port_list', _('Blocked port list (blocklist_port_list)'),
			_('Ports blocked for blocklist domains (empty blocks all ports).'));
		o.datatype = 'port';
		o.placeholder = '80';

		// Normalize after every option has parsed so hidden FAS fields cannot
		// reactivate an external portal while a local login mode is selected.
		var parse = m.parse;
		m.parse = function() {
			return parse.apply(this, arguments).then(function() {
				uci.sections('opennds', 'opennds', function(section) {
					var sid = section['.name'];
					var port = fasPort.formvalue(sid);
					if (port == null) port = fasPort.cfgvalue(sid);
					if ((section.login_option_enabled || '0') === '0') {
						if (port) uci.set('opennds', sid, 'fasport', port);
						else uci.unset('opennds', sid, 'fasport');
						uci.unset('opennds', sid, 'luci_fasport');
					} else {
						if (port && port !== '0') uci.set('opennds', sid, 'luci_fasport', port);
						else uci.unset('opennds', sid, 'luci_fasport');
						uci.set('opennds', sid, 'fasport', '0');
					}
				});
			});
		};

		return m.render();
	}
});
