/*
 * dsh-theme-colors —— 客户端（浏览器）插件：设置页 → 通用 → 「配色」卡片。
 *
 * 这是 DSH 客户端模块系统加载的 lazy-CJS 工厂包（与 @deepseek-ai/dsh-client-ui-*
 * 的产物同一格式，手写、无需构建）。卡片本身只做两件事：展示当前四个区域的
 * 颜色，并提供打开调色面板的入口；面板与读写逻辑在 gui.js 里，两者共用同一份
 * /dsh-theme-colors/config.json。
 *
 * 整包不抛异常：客户端插件在启动期物化，任何抛出都可能影响界面启动。
 */
window.__ModuleLoader__.load({
	id: 'dsh-theme-colors',
	factory: (require) => {
		var module = { exports: {} }
		var exports = module.exports
		Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

		try {
			var react = require('react')
			var h = react.createElement

			var BASE = '/dsh-theme-colors'
			var OPEN_EVENT = 'dsh-theme-colors:open'
			var CHANGED_EVENT = 'dsh-theme-colors:changed'
			var ROW_CSS_ID = 'dsh-theme-colors/settings-row.css'

			/** 本插件支持的区域；据此过滤宿主可能多给的行（例如旧配置里的「页面背景」）。 */
			var SUPPORTED_REGIONS = ['conversation', 'sidebar', 'rightbar']

			var ROW_CSS = [
				'.dtc-row{border-bottom:.5px solid var(--dsw-alias-border-l2);align-items:center;gap:8px;padding:16px 0;display:flex}',
				'.dtc-rowText{flex-direction:column;flex:1;gap:4px;min-width:0;padding-right:48px;display:flex}',
				'.dtc-title{color:var(--dsw-alias-label-primary);font-size:14px;font-weight:400;line-height:22px}',
				'.dtc-desc{color:var(--dsw-alias-label-tertiary);font-size:12px;font-weight:400;line-height:18px}',
				'.dtc-control{align-items:center;gap:12px;display:inline-flex}',
				'.dtc-swatches{align-items:center;gap:6px;display:inline-flex}',
				'.dtc-swatch{box-sizing:border-box;width:16px;height:16px;border-radius:var(--dsw-radius-xs,4px);border:.5px solid var(--dsw-alias-border-l4)}',
				'.dtc-swatch[data-following="yes"]{background:repeating-linear-gradient(45deg,transparent,transparent 3px,var(--dsw-alias-border-l4) 3px,var(--dsw-alias-border-l4) 6px)}',
				'.dtc-open{box-sizing:border-box;border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md);',
				'font:inherit;font-size:13px;line-height:22px;color:var(--dsw-alias-label-primary);cursor:pointer;background:0 0;padding:6px 14px}',
				'.dtc-open:hover{background:var(--dsw-alias-interactive-bg-hover)}',
			].join('')

			/** 注入卡片样式，重复挂载只注入一次。 */
			function ensureRowCss() {
				if (typeof document === 'undefined') return
				if (document.querySelector('style[data-plugin-css=' + JSON.stringify(ROW_CSS_ID) + ']') !== null) return
				var tag = document.createElement('style')
				tag.dataset.plugin = 'dsh-theme-colors'
				tag.dataset.pluginCss = ROW_CSS_ID
				tag.textContent = ROW_CSS
				document.head.appendChild(tag)
			}

			/** 当前生效的深/浅色。 */
			function activeMode() {
				return document.body && document.body.hasAttribute('data-ds-dark-theme') ? 'dark' : 'light'
			}

			/** 一个区域的小色块；跟随主题时显示斜纹。 */
			function swatch(region, entry) {
				var following = !entry || entry.color === ''
				var style = following ? undefined : { background: entry.opacity >= 100 ? entry.color : 'color-mix(in srgb, ' + entry.color + ' ' + entry.opacity + '%, transparent)' }
				return h('span', {
					key: region.key,
					className: 'dtc-swatch',
					style: style,
					'data-following': following ? 'yes' : 'no',
					title: region.label + (following ? '：跟随主题' : '：' + entry.color),
				})
			}

			/** 设置页里的「配色」卡片。 */
			function ThemeColorsRow() {
				var state = react.useState({ payload: null, mode: activeMode(), tick: 0 })
				var view = state[0]
				var setView = state[1]

				react.useEffect(function () {
					var alive = true
					function load() {
						fetch(BASE + '/config.json', { cache: 'no-store' })
							.then(function (response) {
								return response.ok ? response.json() : null
							})
							.then(function (payload) {
								if (alive && payload) setView({ payload: payload, mode: activeMode(), tick: Date.now() })
							})
							.catch(function () {})
					}
					function onChanged() {
						load()
					}
					/* 主题切换只改 body 属性，取色块要跟着换一套，因此保留上一份 payload。 */
					function onThemeAttribute() {
						if (!alive) return
						setView(function (previous) {
							return { payload: previous.payload, mode: activeMode(), tick: Date.now() }
						})
					}
					load()
					window.addEventListener(CHANGED_EVENT, onChanged)
					var observer = typeof MutationObserver === 'function' ? new MutationObserver(onThemeAttribute) : null
					if (observer && document.body) observer.observe(document.body, { attributes: true, attributeFilter: ['data-ds-dark-theme'] })
					return function () {
						alive = false
						window.removeEventListener(CHANGED_EVENT, onChanged)
						if (observer) observer.disconnect()
					}
				}, [])

				var payload = view.payload
				var mode = view.mode
				var regions = payload && payload.regions ? payload.regions : []
				var config = payload && payload.config ? payload.config : null
				var described = mode === 'dark' ? '深色主题' : '浅色主题'

				var swatches = []
				if (config) {
					for (var i = 0; i < regions.length; i += 1) {
						var region = regions[i]
						if (SUPPORTED_REGIONS.indexOf(region.key) === -1) continue
						var group = config.regions && config.regions[region.key]
						if (!group) continue
						swatches.push(swatch(region, group[mode]))
					}
				}

				return h('div', { className: 'dtc-row', 'data-dsh-theme-colors-row': '1' }, [
					h('div', { className: 'dtc-rowText', key: 'text' }, [
						h('div', { className: 'dtc-title', key: 'title' }, '配色'),
						h('div', { className: 'dtc-desc', key: 'desc' }, payload
							? '页面背景、会话栏与左右两侧栏的颜色（当前 ' + described + '）。'
							: '正在读取配色…'),
					]),
					h('div', { className: 'dtc-control', key: 'control' }, [
						h('span', { className: 'dtc-swatches', key: 'swatches' }, swatches),
						h('button', {
							type: 'button',
							className: 'dtc-open',
							key: 'open',
							onClick: function () {
								try {
									window.dispatchEvent(new CustomEvent(OPEN_EVENT))
								} catch (error) {
									/* 面板未加载时点一下没反应，不影响设置页 */
								}
							},
						}, '调整配色…'),
					]),
				])
			}

			/**
			 * 客户端插件主体：把卡片注册进「通用」设置栏。
			 * @param ctx - 客户端 cordis 上下文。
			 */
			function apply(ctx) {
				try {
					ensureRowCss()
					ctx.slots.inject('settings.general.item', function () {
						return ctx.slots.register({
							name: 'settings.general.item',
							id: 'dsh-theme-colors',
							order: 12,
						}, ThemeColorsRow)
					})
				} catch (error) {
					try {
						console.warn('[dsh-theme-colors] 设置卡片注册失败：', error)
					} catch (ignored) {}
				}
			}

			exports.apply = apply
			exports.inject = ['slots']
		} catch (error) {
			try {
				console.warn('[dsh-theme-colors] 客户端插件加载失败：', error)
			} catch (ignored) {}
		}

		return module.exports
	},
})
