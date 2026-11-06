'use strict';
'require baseclass';
'require rpc';
'require ui';

function call(method, params) {
	return rpc.declare({ object: 'luci.opennds', method: method, params: params || [], reject: true, expect: { '': {} } });
}

return baseclass.extend({
	status: call('status'),
	getLog: call('get_log', ['lines']),
	getPortal: call('get_portal'),
	savePortal: call('save_portal', ['config']),
	clientAction: call('client_action', ['action', 'mac', 'duration']),
	restart: call('reload_service'),
	checkConfig: call('check_config'),

	loadOverview: function() {
		return Promise.all([
			this.status().catch(function(err) { return { unavailable: true, error: err.message }; }),
			this.getLog(30).then(function(result) {
				if (result.error || (result.code != null && result.code !== 0))
					throw new Error(result.error || result.output || result.code);
				if (!Array.isArray(result.lines)) throw new Error(_('Failed to read log'));
				return result.lines;
			}).catch(function(err) { return [ _('Failed to read log') + ': ' + err.message ]; })
		]);
	},

	logoText: function(logo) {
		return logo === 'coffee' ? 'CAFE' : logo === 'hotel' ? 'HOTEL' : logo === 'business' ? 'BIZ' : 'Wi-Fi';
	},

	run: function(ev, options) {
		ev.preventDefault();
		var button = ev.currentTarget;
		if (button && button.disabled) return Promise.resolve();
		if (button) button.disabled = true;
		if (options.title) ui.showModal(options.title, [ E('p', { 'class': 'spinning' }, [options.message]) ]);
		return Promise.resolve().then(options.request).then(function(result) {
			if (!result || result.code !== 0)
				throw new Error(result && (result.message || result.output) || _('Operation failed without a valid response.'));
			ui.addNotification(null, E('p', {}, [options.success]), options.level || 'success');
			return options.refresh ? options.refresh() : result;
		}).catch(function(err) {
			ui.addNotification(null, E('p', {}, [err.message]), 'danger');
		}).finally(function() {
			if (button) button.disabled = false;
			if (options.title) ui.hideModal();
		});
	}
});
