'use strict';
'require view';
'require dom';
'require rpc';
'require ui';

var callGetPortal = rpc.declare({
	object: 'luci.opennds',
	method: 'get_portal',
	reject: true,
	expect: { '': {} }
});

var callSavePortal = rpc.declare({
	object: 'luci.opennds',
	method: 'save_portal',
	reject: true,
	params: [ 'config' ],
	expect: { '': {} }
});

return view.extend({
	load: function() {
		return callGetPortal().then(function(result) {
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

		// Field 1: Title
		var inputTitle = E('input', {
			'class': 'cbi-input-text',
			'style': 'width: 100%; margin-top: 4px; margin-bottom: 12px;',
			'type': 'text',
			'value': activeTheme.title
		});
		formPane.appendChild(E('label', { 'style': 'font-weight: bold; font-size: 12px;' }, [ _('Portal Title') ]));
		formPane.appendChild(inputTitle);

		// Field 2: Subtitle
		var inputSubtitle = E('input', {
			'class': 'cbi-input-text',
			'style': 'width: 100%; margin-top: 4px; margin-bottom: 12px;',
			'type': 'text',
			'value': activeTheme.subtitle
		});
		formPane.appendChild(E('label', { 'style': 'font-weight: bold; font-size: 12px;' }, [ _('Welcome Subtitle / Notice') ]));
		formPane.appendChild(inputSubtitle);

		// Field 3: Logo Select (Plain text options without emoji)
		var selectLogo = E('select', {
			'class': 'cbi-input-select',
			'style': 'width: 100%; margin-top: 4px; margin-bottom: 12px;'
		}, [
			E('option', { 'value': 'wifi' }, [ _('Classic Wi-Fi Icon') ]),
			E('option', { 'value': 'coffee' }, [ _('Cafe / Restaurant (Coffee)') ]),
			E('option', { 'value': 'hotel' }, [ _('Hotel / Hospitality') ]),
			E('option', { 'value': 'business' }, [ _('Office / Conference (Business)') ])
		]);
		selectLogo.value = activeTheme.logo || 'wifi';
		formPane.appendChild(E('label', { 'style': 'font-weight: bold; font-size: 12px;' }, [ _('Brand Logo Icon') ]));
		formPane.appendChild(selectLogo);

		// Field 4: Primary Color
		var inputColor = E('input', {
			'type': 'color',
			'value': activeTheme.primaryColor,
			'style': 'vertical-align: middle; width: 40px; height: 30px; cursor: pointer; border: 0; padding: 0; margin-left: 10px;'
		});
		var colorHexLabel = E('span', { 'style': 'font-size: 12px; font-family: monospace;' }, [ activeTheme.primaryColor ]);
		var colorWrap = E('div', { 'style': 'margin-top: 4px; margin-bottom: 12px; display: flex; align-items: center;' }, [
			colorHexLabel,
			inputColor
		]);
		formPane.appendChild(E('label', { 'style': 'font-weight: bold; font-size: 12px;' }, [ _('Primary Accent Color') ]));
		formPane.appendChild(colorWrap);

		// Field 5: Button Text
		var inputBtnText = E('input', {
			'class': 'cbi-input-text',
			'style': 'width: 100%; margin-top: 4px; margin-bottom: 12px;',
			'type': 'text',
			'value': activeTheme.btnText
		});
		formPane.appendChild(E('label', { 'style': 'font-weight: bold; font-size: 12px;' }, [ _('Button Label') ]));
		formPane.appendChild(inputBtnText);

		// Field 6: Terms
		var inputTerms = E('textarea', {
			'class': 'cbi-input-textarea',
			'style': 'width: 100%; height: 70px; margin-top: 4px; margin-bottom: 15px;',
		}, [ activeTheme.terms ]);
		formPane.appendChild(E('label', { 'style': 'font-weight: bold; font-size: 12px;' }, [ _('Terms of Service (ToS)') ]));
		formPane.appendChild(inputTerms);

		// Field 7: Footer
		var inputFooter = E('input', {
			'class': 'cbi-input-text',
			'style': 'width: 100%; margin-top: 4px; margin-bottom: 15px;',
			'type': 'text',
			'value': activeTheme.footer || defaultTheme.footer
		});
		formPane.appendChild(E('label', { 'style': 'font-weight: bold; font-size: 12px;' }, [ _('Footer Notice / Copyright') ]));
		formPane.appendChild(inputFooter);

		// Save Button
		var btnSavePortal = E('button', {
			'class': 'cbi-button cbi-button-apply',
			'click': function(ev) {
				ev.preventDefault();
				var payload = {
					title: inputTitle.value,
					subtitle: inputSubtitle.value,
					logo: selectLogo.value,
					primaryColor: inputColor.value,
					btnText: inputBtnText.value,
					terms: inputTerms.value,
					footer: inputFooter.value
				};
				if (!payload.title.trim() || !payload.btnText.trim()) {
					ui.addNotification(null, E('p', {}, [ _('Title and button text cannot be empty.') ]), 'danger');
					return;
				}
				btnSavePortal.disabled = true;

				ui.showModal(_('Generating ThemeSpec Template'), [
					E('p', { 'class': 'spinning' }, [ _('Saving theme configuration, updating gateway name and restarting openNDS...') ])
				]);

				return callSavePortal(payload).then(function(res) {
					if (!res || res.code !== 0)
						throw new Error(res && (res.message || res.output) || _('Failed to save portal configuration.'));
					ui.addNotification(null, E('p', {}, [ _('Portal configuration saved and restarted. Verify daemon status in Overview.') ]), 'success');
				}).catch(function(err) {
					ui.addNotification(null, E('p', {}, [ err.message ]), 'danger');
				}).finally(function() {
					ui.hideModal();
					btnSavePortal.disabled = false;
				});
			}
		}, [ _('Save & Generate Portal') ]);
		formPane.appendChild(btnSavePortal);

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
		var logoInitialText = 'Wi-Fi';
		if (activeTheme.logo === 'coffee') logoInitialText = 'CAFE';
		else if (activeTheme.logo === 'hotel') logoInitialText = 'HOTEL';
		else if (activeTheme.logo === 'business') logoInitialText = 'BIZ';

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

		// Synchronize DOM inputs to Simulator
		function updateSimulator() {
			titleNode.innerText = inputTitle.value;
			subtitleNode.innerText = inputSubtitle.value;
			termsNode.querySelector('#sim-terms').innerText = inputTerms.value;
			var simFooter = termsNode.querySelector('#sim-footer');
			if (simFooter) simFooter.innerText = inputFooter.value;
			var btn = screenContent.querySelector('#sim-btn');
			if (btn) {
				btn.innerText = inputBtnText.value;
				btn.style.backgroundColor = inputColor.value;
			}
			logoWrap.style.backgroundColor = inputColor.value;
			colorHexLabel.innerText = inputColor.value;

			var logoVal = selectLogo.value;
			if (logoVal === 'coffee') logoWrap.innerText = 'CAFE';
			else if (logoVal === 'hotel') logoWrap.innerText = 'HOTEL';
			else if (logoVal === 'business') logoWrap.innerText = 'BIZ';
			else logoWrap.innerText = 'Wi-Fi';
		}

		inputTitle.addEventListener('input', updateSimulator);
		inputSubtitle.addEventListener('input', updateSimulator);
		inputBtnText.addEventListener('input', updateSimulator);
		inputTerms.addEventListener('input', updateSimulator);
		inputFooter.addEventListener('input', updateSimulator);
		inputColor.addEventListener('input', updateSimulator);
		selectLogo.addEventListener('change', updateSimulator);

		gridLayout.appendChild(formPane);
		gridLayout.appendChild(simPane);
		studioContainer.appendChild(gridLayout);

		return studioContainer;
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
