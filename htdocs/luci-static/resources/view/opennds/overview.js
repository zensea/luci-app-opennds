'use strict';
'require view';
'require dom';
'require rpc';
'require ui';
'require poll';

var callOpenndsStatus = rpc.declare({
	object: 'luci.opennds',
	method: 'status',
	reject: true,
	expect: { '': {} }
});

var callClientAction = rpc.declare({
	object: 'luci.opennds',
	method: 'client_action',
	reject: true,
	params: [ 'action', 'mac', 'duration' ],
	expect: { '': {} }
});

var callReloadService = rpc.declare({
	object: 'luci.opennds',
	method: 'reload_service',
	reject: true,
	expect: { '': {} }
});

var callGetLog = rpc.declare({
	object: 'luci.opennds',
	method: 'get_log',
	reject: true,
	params: [ 'lines' ],
	expect: { '': {} }
});

var overviewPollCallback = null;

function readLog() {
	return callGetLog(30).then(function(result) {
		if (result.error || (result.code != null && result.code !== 0))
			return [ _('Failed to read log') + ': ' + (result.error || result.output || result.code) ];
		return Array.isArray(result.lines) ? result.lines : [ _('Failed to read log') ];
	}).catch(function() { return [ _('Failed to read log') ]; });
}

function parseClientState(client) {
	// Client states may be strings; trusted MACs are listed separately.
	if (typeof client.state === 'string') {
		return client.state;
	}

	if (client.session_start && client.session_start > 0) {
		return 'Authenticated';
	}

	return 'Preauthenticated';
}

function parseClientCounters(client) {
	var rx = 0;
	var tx = 0;

	if (client.download_this_session != null || client.upload_this_session != null) {
		rx = Number(client.download_this_session || 0) * 1024;
		tx = Number(client.upload_this_session || 0) * 1024;
	} else if (client.counters && typeof client.counters === 'object') {
		rx = client.counters.incoming || client.counters.rx_bytes || 0;
		tx = client.counters.outgoing || client.counters.tx_bytes || 0;
	} else {
		rx = client.download_bytes || client.rx_bytes || 0;
		tx = client.upload_bytes || client.tx_bytes || 0;
	}

	var rxMB = (Math.max(0, Number(rx) || 0) / (1024 * 1024)).toFixed(1);
	var txMB = (Math.max(0, Number(tx) || 0) / (1024 * 1024)).toFixed(1);
	return { rxMB: rxMB, txMB: txMB };
}

function clientArray(data) {
	var clients = data.clients || {};
	var list = [];
	Object.keys(clients).forEach(function(key) {
		if (clients[key] && typeof clients[key] === 'object')
			list.push(Object.assign({}, clients[key], { mac: clients[key].mac || key }));
	});
	(Array.isArray(data.trusted) ? data.trusted : []).forEach(function(mac) {
		if (typeof mac !== 'string') return;
		var client = list.find(function(c) { return c.mac.toLowerCase() === mac.toLowerCase(); });
		if (client) client.state = 'Trusted';
		else list.push({ mac: mac, state: 'Trusted' });
	});
	return list;
}

function requireSuccess(result) {
	if (!result || result.code !== 0)
		throw new Error(result && (result.message || result.output) || _('Operation failed without a valid response.'));
	return result;
}

return view.extend({
	load: function() {
		return Promise.all([
			callOpenndsStatus().catch(function(err) { return { unavailable: true, error: err.message }; }),
			readLog()
		]);
	},

	render: function(data) {
		var self = this;
		var status = data[0] || {};
		var logData = data[1] || {};
		var logs = Array.isArray(logData.lines) ? logData.lines : (Array.isArray(logData) ? logData : []);
		var ndsData = status.data || {};
		var clientList = status.running ? clientArray(ndsData) : [];

		var viewContainer = E('div', { 'class': 'cbi-map' }, [
			E('h2', {}, [ _('openNDS Overview & Client Management') ]),
			E('div', { 'class': 'cbi-map-descr' }, [
				_('Monitor daemon status, interface parameters, and manage connected clients in real time.')
			])
		]);

		/* =========================================================
		 * 1. Top Status Cards
		 * ========================================================= */
		var isRunning = status.running || false;
		var pid = status.pid || '-';
		var version = ndsData.version || '-';
		var gatewayIf = ndsData.interface || '-';
		var gatewayPort = ndsData.gateway_port || '-';
		var uptime = ndsData.uptime || '-';

		var authCount = 0;
		var preauthCount = 0;
		clientList.forEach(function(c) {
			var st = parseClientState(c);
			if (st === 'Authenticated') authCount++;
			else if (st === 'Preauthenticated') preauthCount++;
		});

		var statusCards = E('div', {
			'style': 'display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 15px; margin-bottom: 20px;'
		}, [
			// Card 1: Daemon State
			E('div', { 'class': 'cbi-section', 'style': 'margin: 0; padding: 15px; border-radius: 8px;' }, [
				E('div', { 'style': 'font-size: 12px; margin-bottom: 5px; opacity: 0.75;' }, [ _('Daemon Status') ]),
				E('div', { 'style': 'display: flex; align-items: baseline; gap: 8px;' }, [
					E('span', {
						'id': 'val-daemon-state',
						'style': 'font-size: 18px; font-weight: bold; color: ' + (isRunning ? '#10b981;' : '#ef4444;')
					}, [ status.unavailable ? _('Status unavailable') : isRunning ? _('Running (Active)') : _('Stopped') ]),
					E('span', { 'id': 'val-pid', 'style': 'font-size: 12px; font-family: monospace; opacity: 0.75;' }, [ 'PID: ' + pid ])
				]),
				E('div', { 'style': 'font-size: 12px; margin-top: 8px; font-family: monospace; opacity: 0.85;' }, [
					_('Version: '), E('span', { 'id': 'val-version' }, [ version ]),
					' | ' + _('Interface: '), E('span', { 'id': 'val-interface' }, [ gatewayIf ])
				])
			]),

			// Card 2: Active Clients
			E('div', { 'class': 'cbi-section', 'style': 'margin: 0; padding: 15px; border-radius: 8px;' }, [
				E('div', { 'style': 'font-size: 12px; margin-bottom: 5px; opacity: 0.75;' }, [ _('Active Clients') ]),
				E('div', { 'style': 'display: flex; align-items: baseline; gap: 8px;' }, [
					E('span', { 'id': 'val-auth-count', 'style': 'font-size: 20px; font-weight: bold; color: #0284c7;' }, [ authCount ]),
					E('span', { 'style': 'font-size: 12px; opacity: 0.75;' }, [ _(' authenticated') ])
				]),
				E('div', { 'style': 'font-size: 12px; margin-top: 8px; color: #f59e0b; font-family: monospace;' }, [
					_('Pending (Preauth): '),
					E('strong', { 'id': 'val-preauth-count' }, [ preauthCount ])
				])
			]),

			// Card 3: Gateway Network & Uptime
			E('div', { 'class': 'cbi-section', 'style': 'margin: 0; padding: 15px; border-radius: 8px;' }, [
				E('div', { 'style': 'font-size: 12px; margin-bottom: 5px; opacity: 0.75;' }, [ _('Gateway Info') ]),
				E('div', { 'id': 'val-gateway-name', 'style': 'font-size: 16px; font-weight: bold; font-family: monospace;' }, [ ndsData.gateway_name || '-' ]),
				E('div', { 'style': 'font-size: 12px; margin-top: 8px; font-family: monospace; opacity: 0.85;' }, [
					_('Port: '), E('span', { 'id': 'val-port' }, [ gatewayPort ]), ' | ' + _('Uptime: '),
					E('span', { 'id': 'val-uptime' }, [ uptime ])
				])
			]),

			// Card 4: Quick Action
			E('div', { 'class': 'cbi-section', 'style': 'margin: 0; padding: 15px; border-radius: 8px; display: flex; flex-direction: column; justify-content: space-between;' }, [
				E('div', { 'style': 'font-size: 12px; opacity: 0.75;' }, [ _('Quick Actions') ]),
				E('div', { 'style': 'display: flex; gap: 8px; margin-top: 8px;' }, [
					E('button', {
						'class': 'cbi-button cbi-button-action',
						'click': function(ev) {
							ev.preventDefault();
							ui.showModal(_('Restarting openNDS'), [
								E('p', { 'class': 'spinning' }, [ _('Restarting openNDS to reload configuration and firewall rules...') ])
							]);
							return callReloadService().then(requireSuccess).then(function() {
								ui.addNotification(null, E('p', {}, [ _('openNDS service restarted successfully.') ]), 'success');
								return refreshClientsNow();
							}).catch(function(err) {
								ui.addNotification(null, E('p', {}, [ err.message ]), 'danger');
							}).finally(function() { ui.hideModal(); });
						}
					}, [ _('Restart Service') ]),

					E('a', {
						'class': 'cbi-button cbi-button-apply',
						'href': L.url('admin/services/opennds/studio')
					}, [ _('Portal Studio') ])
				])
			])
		]);
		viewContainer.appendChild(statusCards);
		viewContainer.appendChild(E('p', { 'id': 'opennds-status-error', 'style': 'color: #ef4444;' }, [ status.error || '' ]));

		/* =========================================================
		 * 2. Active Clients Table (ndsctl Controller)
		 * ========================================================= */
		var tableSection = E('div', { 'class': 'cbi-section' }, [
			E('div', { 'style': 'display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;' }, [
				E('h3', { 'style': 'margin: 0;' }, [ _('Clients & Trusted List') ]),
				E('span', { 'class': 'badge', 'id': 'client-total-badge' }, [ clientList.length + _(' entries') ])
			])
		]);

		var table = E('table', { 'class': 'table cbi-section-table', 'id': 'opennds-client-table' }, [
			E('tr', { 'class': 'tr cbi-section-table-titles' }, [
				E('th', { 'class': 'th' }, [ _('Client IP Address') ]),
				E('th', { 'class': 'th' }, [ _('MAC Address') ]),
				E('th', { 'class': 'th' }, [ _('State') ]),
				E('th', { 'class': 'th' }, [ _('Connected Time') ]),
				E('th', { 'class': 'th' }, [ _('Traffic (Download / Upload)') ]),
				E('th', { 'class': 'th center' }, [ _('ndsctl Actions') ])
			])
		]);

		function refreshClientsNow() {
			if (viewContainer.isConnected === false) {
				if (overviewPollCallback) {
					poll.remove(overviewPollCallback);
					overviewPollCallback = null;
				}
				return Promise.resolve();
			}

			return Promise.all([
				callOpenndsStatus().catch(function(err) { return { unavailable: true, error: err.message }; }),
				readLog()
			]).then(function(responses) {
				if (viewContainer.isConnected === false) {
					if (overviewPollCallback) {
						poll.remove(overviewPollCallback);
						overviewPollCallback = null;
					}
					return;
				}

				var res = responses[0] || {};
				var curData = res.data || {};
				var curList = res.running ? clientArray(curData) : [];
				renderClientRows(curList);
				function update(id, text) {
					var node = viewContainer.querySelector('#' + id);
					if (node) node.innerText = text;
				}
				update('val-daemon-state', res.unavailable ? _('Status unavailable') : res.running ? _('Running (Active)') : _('Stopped'));
				var stateNode = viewContainer.querySelector('#val-daemon-state');
				if (stateNode) stateNode.style.color = res.running ? '#10b981' : '#ef4444';
				update('val-pid', 'PID: ' + (res.pid || '-'));
				update('val-version', curData.version || '-');
				update('val-interface', curData.interface || '-');
				update('val-gateway-name', curData.gateway_name || '-');
				update('val-port', curData.gateway_port || '-');
				update('val-uptime', curData.uptime || '-');
				update('opennds-status-error', res.error || '');
				var logResponse = responses[1];
				var currentLogs = Array.isArray(logResponse) ? logResponse : logResponse.lines || [];
				update('opennds-log', currentLogs.length ? currentLogs.join('\n') : _('No relevant logs found'));

				var badge = viewContainer.querySelector('#client-total-badge') || document.getElementById('client-total-badge');
				if (badge) badge.innerText = curList.length + _(' entries');

				var authVal = viewContainer.querySelector('#val-auth-count') || document.getElementById('val-auth-count');
				var preVal = viewContainer.querySelector('#val-preauth-count') || document.getElementById('val-preauth-count');
				var upVal = viewContainer.querySelector('#val-uptime') || document.getElementById('val-uptime');
				if (upVal && curData.uptime) upVal.innerText = curData.uptime;

				var aCount = 0;
				var pCount = 0;
				curList.forEach(function(c) {
					var sState = parseClientState(c);
					if (sState === 'Authenticated') aCount++;
					else if (sState === 'Preauthenticated') pCount++;
				});
				if (authVal) authVal.innerText = aCount;
				if (preVal) preVal.innerText = pCount;
			});
		}

		function runClientAction(ev, action, client, message, level) {
			ev.preventDefault();
			var button = ev.currentTarget;
			if (button) button.disabled = true;
			return callClientAction(action, client.mac, -1).then(requireSuccess).then(function() {
				ui.addNotification(null, E('p', {}, [ message + client.mac ]), level);
				return refreshClientsNow();
			}).catch(function(err) {
				ui.addNotification(null, E('p', {}, [ err.message ]), 'danger');
			}).finally(function() { if (button) button.disabled = false; });
		}

		function renderClientRows(list) {
			// Clear rows except header
			while (table.rows.length > 1) {
				table.deleteRow(1);
			}

			if (list.length === 0) {
				var emptyRow = table.insertRow(-1);
				emptyRow.className = 'tr placeholder';
				var cell = emptyRow.insertCell(-1);
				cell.colSpan = 6;
				cell.style.textAlign = 'center';
				cell.style.padding = '20px';
				cell.style.opacity = '0.6';
				cell.innerText = _('No connected clients on managed interface');
				return;
			}

			list.forEach(function(client) {
				var row = table.insertRow(-1);
				row.className = 'tr';

				// 1. IP
				var cIp = row.insertCell(-1);
				cIp.className = 'td';
				cIp.style.fontFamily = 'monospace';
				cIp.innerText = client.ip || '-';

				// 2. MAC
				var cMac = row.insertCell(-1);
				cMac.className = 'td';
				cMac.style.fontFamily = 'monospace';
				cMac.innerText = (client.mac || '-').toUpperCase();

				// 3. State
				var cState = row.insertCell(-1);
				cState.className = 'td';
				var stateStr = parseClientState(client);
				var badgeColor = stateStr === 'Authenticated' ? '#10b981' : stateStr === 'Trusted' ? '#6366f1' : stateStr === 'Blocked' ? '#ef4444' : '#f59e0b';

				var stateBadge = E('span', {
					'style': 'display: inline-block; padding: 2px 8px; border-radius: 12px; font-size: 11px; font-weight: bold; color: ' + badgeColor + '; border: 1px solid ' + badgeColor + ';'
				}, [ stateStr === 'Authenticated' ? _('Authenticated') : stateStr === 'Trusted' ? _('Trusted') : stateStr === 'Blocked' ? _('Blocked') : _('Preauthenticated') ]);
				cState.appendChild(stateBadge);

				// 4. Session Time
				var cTime = row.insertCell(-1);
				cTime.className = 'td';
				var duration = 0;
				if (client.session_start && client.session_start > 0) {
					duration = Math.max(0, Math.floor((Date.now()/1000 - client.session_start) / 60));
				} else if (client.duration) {
					duration = client.duration;
				}
				cTime.innerText = stateStr === 'Trusted' ? '-' : duration + _(' min');

				// 5. Traffic Counters
				var cTraffic = row.insertCell(-1);
				cTraffic.className = 'td';
				var counters = parseClientCounters(client);
				cTraffic.innerText = stateStr === 'Trusted' ? _('Trusted client (no traffic records)') : '↓ ' + counters.rxMB + ' MB / ↑ ' + counters.txMB + ' MB';

				// 6. Action buttons
				var cAction = row.insertCell(-1);
				cAction.className = 'td center';
				cAction.style.whiteSpace = 'nowrap';

				// Button: Auth
				if (stateStr !== 'Authenticated' && stateStr !== 'Trusted') {
					var btnAuth = E('button', {
						'class': 'cbi-button cbi-button-save',
						'style': 'margin-right: 4px; padding: 2px 6px; font-size: 11px;',
						'click': function(ev) {
							return runClientAction(ev, 'auth', client, _('Client successfully authenticated: '), 'success');
						}
					}, [ _('Auth') ]);
					cAction.appendChild(btnAuth);
				}

				// Button: Trust (for Authenticated or Preauthenticated)
				if (stateStr !== 'Trusted') {
					var btnTrust = E('button', {
						'class': 'cbi-button cbi-button-action',
						'style': 'margin-right: 4px; padding: 2px 6px; font-size: 11px;',
						'click': function(ev) {
							return runClientAction(ev, 'trust', client, _('Client trusted: '), 'info');
						}
					}, [ _('Trust') ]);
					cAction.appendChild(btnTrust);
				}

				// Button: Deauth
				if (stateStr === 'Authenticated') {
					var btnDeauth = E('button', {
						'class': 'cbi-button cbi-button-reset',
						'style': 'margin-right: 4px; padding: 2px 6px; font-size: 11px;',
						'click': function(ev) {
							return runClientAction(ev, 'deauth', client, _('Client disconnected: '), 'warning');
						}
					}, [ _('Deauth') ]);
					cAction.appendChild(btnDeauth);
				}

				// Button: Untrust (if Trusted)
				if (stateStr === 'Trusted') {
					var btnUntrust = E('button', {
						'class': 'cbi-button cbi-button-reset',
						'style': 'margin-right: 4px; padding: 2px 6px; font-size: 11px;',
						'click': function(ev) {
							return runClientAction(ev, 'untrust', client, _('Client untrusted: '), 'info');
						}
					}, [ _('Untrust') ]);
					cAction.appendChild(btnUntrust);
				}

			});
		}

		renderClientRows(clientList);
		tableSection.appendChild(table);
		viewContainer.appendChild(tableSection);

		/* =========================================================
		 * 3. Recent Syslog Box
		 * ========================================================= */
		var logSection = E('div', { 'class': 'cbi-section' }, [
			E('h3', {}, [ _('Recent Syslog (openNDS)') ]),
			E('pre', {
				'id': 'opennds-log',
				'class': 'cbi-input-textarea',
				'style': 'max-height: 200px; overflow-y: auto; background: #0f172a; color: #38bdf8; font-family: monospace; font-size: 11px; padding: 10px; border-radius: 6px;'
			}, [
				logs.length > 0 ? logs.join('\n') : _('No relevant logs found')
			])
		]);
		viewContainer.appendChild(logSection);

		/* =========================================================
		 * 4. Polling for real-time updates (Every 5 seconds)
		 * ========================================================= */
		if (overviewPollCallback) {
			poll.remove(overviewPollCallback);
		}
		overviewPollCallback = function() {
			return refreshClientsNow();
		};
		poll.add(overviewPollCallback, 5);

		return viewContainer;
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
