'use strict';
'require view';
'require opennds as nds';
'require ui';

return view.extend({
	load: function() {
		return nds.getPortal().then(function(result) {
			if (!result || result.error)
				throw new Error(result && result.error || _('Failed to load portal configuration.'));
			return result;
		});
	},

	render: function(savedTheme) {
		var defaultTheme = {
			title: '欢迎使用 访客高速 Wi-Fi',
			subtitle: '欢迎连接访客无线网络',
			logo: 'wifi',
			primaryColor: '#0284c7',
			btnText: '同意条款并连接互联网',
			terms: '请文明使用公共无线网络，遵守国家互联网安全法规。严禁从事网络攻击、违法信息传播等行为。',
			footer: 'Powered by openNDS & OpenWrt Gateway'
		};

		var activeTheme = (savedTheme && savedTheme.exists && savedTheme.config) ?
			Object.assign({}, defaultTheme, savedTheme.config) : defaultTheme;

		var studioContainer = E('div', { 'class': 'cbi-map' }, [
			E('h2', {}, [ _('openNDS Portal ThemeSpec Studio') ]),
			E('div', { 'class': 'cbi-map-descr' }, [
				_('Customize portal branding and copy with real-time preview. Saving switches openNDS to ThemeSpec mode.')
			])
		]);

		var gridLayout = E('div', {
			'style': 'display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 360px), 1fr)); gap: 25px; margin-top: 15px;'
		});

		/* =========================================================
		 * Left: Form Customization Pane
		 * ========================================================= */
		var formPane = E('div', { 'class': 'cbi-section', 'style': 'padding: 20px; border-radius: 8px;' }, [
			E('h3', {}, [ _('Branding & Content') ])
		]);

		var fields = [
			['title', _('Portal Title'), 'text'],
			['subtitle', _('Welcome Subtitle / Notice'), 'text'],
			['logo', _('Brand Logo Icon'), 'select'],
			['primaryColor', _('Primary Accent Color'), 'color'],
			['btnText', _('Button Label'), 'text'],
			['terms', _('Terms of Service (ToS)'), 'textarea'],
			['footer', _('Footer Notice / Copyright'), 'text']
		];
		var inputs = {}, colorHexLabel = E('span', { 'style': 'font-size: 12px; font-family: monospace;' }, [activeTheme.primaryColor]);
		fields.forEach(function(field) {
			var name = field[0], kind = field[2], input;
			var style = 'width: 100%; margin-top: 4px; margin-bottom: ' + (name === 'terms' || name === 'footer' ? '15px;' : '12px;');
			if (kind === 'select') {
				input = E('select', { 'class': 'cbi-input-select', 'style': style }, [
					E('option', { 'value': 'wifi' }, [ _('Classic Wi-Fi Icon') ]),
					E('option', { 'value': 'coffee' }, [ _('Cafe / Restaurant (Coffee)') ]),
					E('option', { 'value': 'hotel' }, [ _('Hotel / Hospitality') ]),
					E('option', { 'value': 'business' }, [ _('Office / Conference (Business)') ])
				]);
			} else if (kind === 'textarea') {
				input = E('textarea', { 'class': 'cbi-input-textarea', 'style': style + 'height: 70px;' }, [activeTheme[name]]);
			} else {
				input = E('input', {
					'type': kind, 'class': kind === 'color' ? null : 'cbi-input-text',
					'style': kind === 'color' ? 'vertical-align: middle; width: 40px; height: 30px; cursor: pointer; border: 0; padding: 0; margin-left: 10px;' : style
				});
			}
			input.value = name === 'footer' ? activeTheme.footer || defaultTheme.footer : activeTheme[name];
			input.name = name;
			input.id = 'portal-' + name;
			input.addEventListener(kind === 'select' ? 'change' : 'input', updateSimulator);
			inputs[name] = input;
			formPane.appendChild(E('label', { 'for': input.id, 'style': 'font-weight: bold; font-size: 12px;' }, [field[1]]));
			formPane.appendChild(kind === 'color' ? E('div', { 'style': 'margin-top: 4px; margin-bottom: 12px; display: flex; align-items: center;' }, [colorHexLabel, input]) : input);
		});
		formPane.appendChild(E('button', {
			'class': 'cbi-button cbi-button-apply',
			'click': function(ev) {
				var payload = {};
				fields.forEach(function(field) { payload[field[0]] = inputs[field[0]].value; });
				if (!payload.title.trim() || !payload.btnText.trim()) {
					ev.preventDefault();
					ui.addNotification(null, E('p', {}, [ _('Title and button text cannot be empty.') ]), 'danger');
					return Promise.resolve();
				}
				return nds.run(ev, {
					title: _('Generating ThemeSpec Template'),
					message: _('Saving theme configuration, updating gateway name and restarting openNDS...'),
					request: function() { return nds.savePortal(payload); },
					success: _('Portal configuration saved and restarted. Verify daemon status in Overview.')
				});
			}
		}, [ _('Save & Generate Portal') ]));

		/* =========================================================
		 * Right: Mobile Live Simulator
		 * ========================================================= */
		var simPane = E('div', {
			'style': 'display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 15px;'
		});

		// Phone Bezel Frame
		var phoneFrame = E('div', {
			'style': 'width: 310px; height: 580px; background: #0f172a; border-radius: 36px; box-shadow: 0 20px 40px rgba(0,0,0,0.4), 0 0 0 8px #1e293b; display: flex; flex-direction: column; overflow: hidden; position: relative;'
		});

		// Top Status Bar
		var phoneTopBar = E('div', {
			'style': 'height: 28px; background: #020617; display: flex; justify-content: space-between; align-items: center; padding: 0 16px; font-size: 10px; font-family: monospace; color: #94a3b8;'
		}, [
			E('span', {}, [ '09:41' ]),
			E('div', { 'style': 'width: 70px; height: 12px; background: #1e293b; border-radius: 6px;' }),
			E('span', {}, [ '5G' ])
		]);

		// Fake Browser Bar
		var phoneBrowserBar = E('div', {
			'style': 'height: 32px; background: #1e293b; border-bottom: 1px solid #334155; display: flex; justify-content: space-between; align-items: center; padding: 0 12px; font-size: 10px; color: #38bdf8;'
		}, [
			E('span', {}, [ _('Cancel') ]),
			E('span', { 'style': 'color: #cbd5e1; font-family: monospace;' }, [ 'status.client:2050' ]),
			E('span', { 'style': 'color: #64748b;' }, [ _('Done') ])
		]);

		// Screen Inner Content
		var screenContent = E('div', {
			'style': 'flex: 1; padding: 20px; display: flex; flex-direction: column; justify-content: space-between; text-align: center; background: #020617; color: #ffffff;'
		});

		// Logo Icon Node
		var logoInitialText = nds.logoText(activeTheme.logo);

		var logoWrap = E('div', {
			'id': 'sim-logo-wrap',
			'style': 'width: 60px; height: 60px; border-radius: 16px; background: ' + activeTheme.primaryColor + '; margin: 15px auto 10px auto; display: flex; align-items: center; justify-content: center; font-size: 26px; box-shadow: 0 8px 16px rgba(0,0,0,0.3);'
		}, [ logoInitialText ]);

		var titleNode = E('h4', { 'id': 'sim-title', 'style': 'margin: 5px 0; font-size: 15px; font-weight: bold; color: #f8fafc;' }, [ activeTheme.title ]);
		var subtitleNode = E('p', { 'id': 'sim-subtitle', 'style': 'font-size: 11px; color: #94a3b8; margin: 0;' }, [ activeTheme.subtitle ]);

		var formNode = E('div', { 'style': 'margin: 25px 0;' }, [
			E('input', {
				'type': 'hidden'
			}),
			E('div', { 'style': 'text-align: left; font-size: 9px; color: #64748b; margin-bottom: 12px;' }, [
				E('input', { 'type': 'checkbox', 'checked': 'checked', 'disabled': 'disabled', 'style': 'margin-right: 4px;' }),
				_('I have read and agree to the Terms of Service')
			]),
			E('button', {
				'id': 'sim-btn',
				'style': 'width: 100%; padding: 10px; border: 0; border-radius: 10px; font-size: 12px; font-weight: bold; color: #ffffff; cursor: pointer; background: ' + activeTheme.primaryColor + '; box-shadow: 0 4px 12px rgba(2,132,199,0.3);',
				'click': function(ev) {
					ev.preventDefault();
					ui.addNotification(null, E('p', {}, [ _('Preview click action. Test real authentication using a client device.') ]), 'info');
				}
			}, [ activeTheme.btnText ])
		]);

		var termsNode = E('div', { 'style': 'border-top: 1px solid #1e293b; padding-top: 10px;' }, [
			E('p', { 'id': 'sim-terms', 'style': 'font-size: 9px; color: #64748b; line-height: 1.4; margin: 0;' }, [ activeTheme.terms ]),
			E('p', { 'id': 'sim-footer', 'style': 'font-size: 8px; color: #475569; font-family: monospace; margin-top: 8px;' }, [ activeTheme.footer || defaultTheme.footer ])
		]);

		screenContent.appendChild(E('div', {}, [ logoWrap, titleNode, subtitleNode ]));
		screenContent.appendChild(formNode);
		screenContent.appendChild(termsNode);

		phoneFrame.appendChild(phoneTopBar);
		phoneFrame.appendChild(phoneBrowserBar);
		phoneFrame.appendChild(screenContent);

		// Bottom Home Indicator
		phoneFrame.appendChild(E('div', {
			'style': 'height: 14px; background: #020617; display: flex; justify-content: center; align-items: center;'
		}, [
			E('div', { 'style': 'width: 100px; height: 3px; background: #475569; border-radius: 2px;' })
		]));

		simPane.appendChild(E('div', { 'style': 'font-size: 11px; color: #64748b; margin-bottom: 8px;' }, [ _('Mobile Viewport Simulator') ]));
		simPane.appendChild(phoneFrame);

		var previewText = { title: titleNode, subtitle: subtitleNode, btnText: screenContent.querySelector('#sim-btn'),
			terms: termsNode.querySelector('#sim-terms'), footer: termsNode.querySelector('#sim-footer') };
		function updateSimulator() {
			Object.keys(previewText).forEach(function(name) { previewText[name].innerText = inputs[name].value; });
			previewText.btnText.style.backgroundColor = inputs.primaryColor.value;
			logoWrap.style.backgroundColor = inputs.primaryColor.value;
			colorHexLabel.innerText = inputs.primaryColor.value;
			logoWrap.innerText = nds.logoText(inputs.logo.value);
		}

		gridLayout.appendChild(formPane);
		gridLayout.appendChild(simPane);
		studioContainer.appendChild(gridLayout);

		return studioContainer;
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
