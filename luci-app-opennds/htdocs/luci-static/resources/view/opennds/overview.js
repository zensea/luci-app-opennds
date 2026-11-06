'use strict';
'require view';
'require poll';
'require opennds as nds';

var overviewPollCallback = null;

function clientsFrom(data) {
	var clients = [], byMac = Object.create(null);
	Object.keys(data.clients || {}).forEach(function(mac) {
		var client = Object.assign({}, data.clients[mac], { mac: mac });
		clients.push(client);
		if (!byMac[mac.toLowerCase()]) byMac[mac.toLowerCase()] = client;
	});
	(data.trusted || []).forEach(function(mac) {
		if (typeof mac !== 'string') return;
		var key = mac.toLowerCase();
		if (byMac[key]) byMac[key].state = 'Trusted';
		else {
			var client = { mac: mac, state: 'Trusted' };
			clients.push(client);
			byMac[key] = client;
		}
	});
	return clients;
}

function card(title, content, quick) {
	return E('div', {
		'class': 'cbi-section',
		'style': 'margin: 0; padding: 15px; border-radius: 8px;' + (quick ? 'display: flex; flex-direction: column; justify-content: space-between;' : '')
	}, [ E('div', { 'style': 'font-size: 12px; opacity: 0.75;' + (quick ? '' : 'margin-bottom: 5px;') }, [title]) ].concat(content));
}

function cell(row, content, style, className) {
	var node = row.insertCell(-1);
	node.className = 'td' + (className ? ' ' + className : '');
	node.style.cssText = style || '';
	if (typeof content === 'object') node.appendChild(content);
	else node.innerText = content;
	return node;
}

return view.extend({
	load: function() { return nds.loadOverview(); },

	render: function(snapshot) {
		var values = Object.create(null);
		function value(id, style, tag) {
			return values[id] = E(tag || 'span', { 'id': id, 'style': style || '' });
		}
		var root = E('div', { 'class': 'cbi-map' }, [
			E('h2', {}, [ _('openNDS Overview & Client Management') ]),
			E('div', { 'class': 'cbi-map-descr' }, [ _('Monitor daemon status, interface parameters, and manage connected clients in real time.') ])
		]);
		var mainStyle = 'display: flex; align-items: baseline; gap: 8px;';
		var detailStyle = 'font-size: 12px; margin-top: 8px; font-family: monospace; opacity: 0.85;';
		root.appendChild(E('div', {
			'style': 'display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 15px; margin-bottom: 20px;'
		}, [
			card(_('Daemon Status'), [
				E('div', { 'style': mainStyle }, [
					value('val-daemon-state', 'font-size: 18px; font-weight: bold;'),
					value('val-pid', 'font-size: 12px; font-family: monospace; opacity: 0.75;')
				]),
				E('div', { 'style': detailStyle }, [
					_('Version: '), value('val-version'), ' | ' + _('Interface: '), value('val-interface')
				])
			]),
			card(_('Active Clients'), [
				E('div', { 'style': mainStyle }, [
					value('val-auth-count', 'font-size: 20px; font-weight: bold; color: #0284c7;'),
					E('span', { 'style': 'font-size: 12px; opacity: 0.75;' }, [ _(' authenticated') ])
				]),
				E('div', { 'style': 'font-size: 12px; margin-top: 8px; color: #f59e0b; font-family: monospace;' }, [
					_('Pending (Preauth): '), value('val-preauth-count', '', 'strong')
				])
			]),
			card(_('Gateway Info'), [
				value('val-gateway-name', 'font-size: 16px; font-weight: bold; font-family: monospace;', 'div'),
				E('div', { 'style': detailStyle }, [
					_('Port: '), value('val-port'), ' | ' + _('Uptime: '), value('val-uptime')
				])
			]),
			card(_('Quick Actions'), [
				E('div', { 'style': 'display: flex; gap: 8px; margin-top: 8px;' }, [
					E('button', {
						'class': 'cbi-button cbi-button-action',
						'click': function(ev) {
							return nds.run(ev, {
								title: _('Restarting openNDS'),
								message: _('Restarting openNDS to reload configuration and firewall rules...'),
								request: function() { return nds.restart(); },
								success: _('openNDS service restarted successfully.'), refresh: refresh
							});
						}
					}, [ _('Restart Service') ]),
					E('a', { 'class': 'cbi-button cbi-button-apply', 'href': L.url('admin/services/opennds/studio') }, [ _('Portal Studio') ])
				])
			], true)
		]));
		root.appendChild(value('opennds-status-error', 'color: #ef4444;', 'p'));
		var section = E('div', { 'class': 'cbi-section' }, [
			E('div', { 'style': 'display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;' }, [
				E('h3', { 'style': 'margin: 0;' }, [ _('Clients & Trusted List') ]),
				value('client-total-badge', '', 'span')
			])
		]);
		values['client-total-badge'].className = 'badge';
		var headers = [ _('Client IP Address'), _('MAC Address'), _('State'), _('Connected Time'), _('Traffic (Download / Upload)'), _('ndsctl Actions') ];
		var table = E('table', { 'class': 'table cbi-section-table', 'id': 'opennds-client-table' }, [
			E('tr', { 'class': 'tr cbi-section-table-titles' }, headers.map(function(label, i) {
				return E('th', { 'class': i === 5 ? 'th center' : 'th' }, [label]);
			}))
		]);
		section.appendChild(table);
		root.appendChild(section);
		root.appendChild(E('div', { 'class': 'cbi-section' }, [
			E('h3', {}, [ _('Recent Syslog (openNDS)') ]),
			value('opennds-log', 'max-height: 200px; overflow-y: auto; background: #0f172a; color: #38bdf8; font-family: monospace; font-size: 11px; padding: 10px; border-radius: 6px;', 'pre')
		]));
		values['opennds-log'].className = 'cbi-input-textarea';
		var states = {
			Authenticated: [ _('Authenticated'), '#10b981' ], Trusted: [ _('Trusted'), '#6366f1' ],
			Blocked: [ _('Blocked'), '#ef4444' ], Preauthenticated: [ _('Preauthenticated'), '#f59e0b' ]
		};
		function action(client, name, label, className, message, level) {
			return E('button', {
				'class': 'cbi-button ' + className,
				'style': name === 'untrust' ? null : 'margin-right: 4px; padding: 2px 6px; font-size: 11px;',
				'click': function(ev) {
					return nds.run(ev, {
						request: function() { return nds.clientAction(name, client.mac, -1); },
						success: message + client.mac, level: level, refresh: refresh
					});
				}
			}, [label]);
		}
		function renderClients(clients) {
			while (table.rows.length > 1) table.deleteRow(1);
			if (!clients.length) {
				var empty = table.insertRow(-1);
				empty.className = 'tr placeholder';
				cell(empty, _('No connected clients on managed interface'), 'text-align: center; padding: 20px; opacity: 0.6;').colSpan = 6;
			}
			clients.forEach(function(client) {
				var row = table.insertRow(-1), state = client.state || 'Preauthenticated';
				row.className = 'tr';
				cell(row, client.ip || '-', 'font-family: monospace;');
				cell(row, client.mac.toUpperCase(), 'font-family: monospace;');
				var badge = states[state] || states.Preauthenticated;
				cell(row, E('span', {
					'style': 'display: inline-block; padding: 2px 8px; border-radius: 12px; font-size: 11px; font-weight: bold; color: ' + badge[1] + '; border: 1px solid ' + badge[1] + ';'
				}, [badge[0]]));
				var duration = client.session_start > 0 ? Math.max(0, Math.floor((Date.now() / 1000 - client.session_start) / 60)) : 0;
				cell(row, state === 'Trusted' ? '-' : duration + _(' min'));
				function megabytes(kb) { return (Math.max(0, Number(kb) || 0) / 1024).toFixed(1); }
				cell(row, state === 'Trusted' ? _('Trusted client (no traffic records)') :
					'↓ ' + megabytes(client.download_this_session) + ' MB / ↑ ' + megabytes(client.upload_this_session) + ' MB');
				var controls = cell(row, '', 'white-space: nowrap;', 'center');
				if (state !== 'Authenticated' && state !== 'Trusted')
					controls.appendChild(action(client, 'auth', _('Auth'), 'cbi-button-save', _('Client successfully authenticated: '), 'success'));
				if (state !== 'Trusted')
					controls.appendChild(action(client, 'trust', _('Trust'), 'cbi-button-action', _('Client trusted: '), 'info'));
				if (state === 'Authenticated')
					controls.appendChild(action(client, 'deauth', _('Deauth'), 'cbi-button-reset', _('Client disconnected: '), 'warning'));
				if (state === 'Trusted')
					controls.appendChild(action(client, 'untrust', _('Untrust'), 'cbi-button-reset', _('Client untrusted: '), 'info'));
			});
		}
		function update(data) {
			var status = data[0], info = status.data || {}, clients = status.running ? clientsFrom(info) : [];
			var counts = { Authenticated: 0, Preauthenticated: 0 };
			clients.forEach(function(client) {
				var state = client.state || 'Preauthenticated';
				if (Object.prototype.hasOwnProperty.call(counts, state)) counts[state]++;
			});
			var text = {
				'val-daemon-state': status.unavailable ? _('Status unavailable') : status.running ? _('Running (Active)') : _('Stopped'),
				'val-pid': 'PID: ' + (status.pid || '-'), 'val-auth-count': counts.Authenticated, 'val-preauth-count': counts.Preauthenticated,
				'val-version': info.version || '-', 'val-interface': info.interface || '-', 'val-port': info.gateway_port || '-',
				'val-gateway-name': info.gateway_name || '-', 'val-uptime': info.uptime || '-',
				'client-total-badge': clients.length + _(' entries'),
				'opennds-status-error': status.error || (status.configuration || {}).error || '',
				'opennds-log': data[1].length ? data[1].join('\n') : _('No relevant logs found')
			};
			Object.keys(text).forEach(function(id) { values[id].innerText = text[id]; });
			values['val-daemon-state'].style.color = status.running ? '#10b981' : '#ef4444';
			renderClients(clients);
		}
		var callback = function() { return refresh(); };
		var polled = false;
		function disconnected() {
			if (root.isConnected !== false) return false;
			poll.remove(callback);
			if (overviewPollCallback === callback) overviewPollCallback = null;
			return true;
		}
		function refresh() {
			// LuCI may start polling synchronously before the returned view is mounted.
			if (polled && disconnected()) return Promise.resolve();
			polled = true;
			return nds.loadOverview().then(function(data) { if (!disconnected()) update(data); });
		}
		update(snapshot);
		if (overviewPollCallback) poll.remove(overviewPollCallback);
		overviewPollCallback = callback;
		poll.add(callback, 5);
		return root;
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
