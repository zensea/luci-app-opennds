'use strict';
'require view';
'require ui';
'require rpc';
'require opennds as nds';

var pendingChanges = rpc.declare({ object: 'uci', method: 'changes', params: ['config'], expect: { changes: {} }, reject: true });
function checkPending() {
	return pendingChanges('opennds').then(function(changes) {
		if ((changes.opennds || []).length) throw new Error(_('Apply or discard pending gateway changes before editing the file.'));
	});
}

return view.extend({
	load: function() {
		return checkPending().then(function() { return nds.getConfig(); }).then(function(result) {
			if (result.error || typeof result.content !== 'string') throw new Error(result.error || _('Unable to read configuration.'));
			return result.content;
		});
	},

	render: function(content) {
		var original = content, busy = false, buttons = [], readonly = !L.hasViewPermission();
		var editor = E('textarea', { 'class': 'cbi-input-textarea', 'rows': 24, 'spellcheck': 'false',
			'aria-label': _('openNDS configuration file'), 'style': 'width:100%;box-sizing:border-box;font-family:monospace;white-space:pre;overflow:auto'
		});
		editor.value = content;
		editor.readOnly = readonly;
		var message = E('p', { 'role': 'status', 'aria-live': 'polite' });
		var preview = E('pre', { 'style': 'white-space:pre-wrap;overflow-wrap:anywhere' });
		function showChanges() {
			var before = original.split('\n'), after = editor.value.split('\n'), changes = [];
			for (var i = 0; i < Math.max(before.length, after.length); i++) {
				if (before[i] === after[i]) continue;
				if (before[i] != null) changes.push('- ' + (i + 1) + ': ' + before[i]);
				if (after[i] != null) changes.push('+ ' + (i + 1) + ': ' + after[i]);
			}
			preview.innerText = changes.length ? changes.join('\n') : _('No changes.');
		}
		editor.addEventListener('input', showChanges);
		function save(apply) {
			if (busy || readonly) return Promise.resolve();
			var pending = editor.value;
			busy = true; editor.disabled = true;
			buttons.forEach(function(button) { button.disabled = true; });
			return checkPending().then(function() { return nds.saveConfig(pending, original, apply); }).then(function(result) {
				if (result.saved) { original = pending; showChanges(); }
				if (result.code !== 0) throw new Error(result.message || _('Unable to save configuration.'));
				message.innerText = apply ? _('Configuration saved and service restarted. Check Overview for daemon status.') : _('Configuration saved. Apply it to restart the service.');
			}).catch(function(error) { message.innerText = error.message; ui.addNotification(null, E('p', {}, [error.message]), 'danger'); })
				.finally(function() { busy = false; editor.disabled = false; buttons.forEach(function(button) { button.disabled = readonly; }); });
		}
		[[false, _('Save')], [true, _('Save and apply')]].forEach(function(item) {
			buttons.push(E('button', { 'type': 'button', 'disabled': readonly ? '' : null, 'class': 'cbi-button ' + (item[0] ? 'cbi-button-apply' : 'cbi-button-save'),
				'click': function() { return save(item[0]); } }, [item[1]]));
		});
		if (this._unload) window.removeEventListener('beforeunload', this._unload);
		this._unload = function(event) { if (editor.value !== original || busy) { event.preventDefault(); event.returnValue = ''; } };
		window.addEventListener('beforeunload', this._unload);
		showChanges();
		return E('div', { 'class': 'cbi-map' }, [E('h2', {}, [_('Expert Configuration')]),
			E('p', {}, [_('Edit /etc/config/opennds directly. Save or discard pending visual settings first. Syntax and the named setup section are checked before replacement; daemon behavior still needs verification.')]),
			editor, E('details', {}, [E('summary', {}, [_('Review changes')]), preview]), message,
			E('div', { 'style': 'display:flex;gap:10px;flex-wrap:wrap' }, buttons)]);
	},
	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
