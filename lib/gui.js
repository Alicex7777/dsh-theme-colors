/*
 * dsh-theme-colors —— GUI 侧脚本（经典脚本，随 index.html 注入）。
 *
 * 两件事：
 * 1. 把宿主下发的配色 CSS 落到页面里，并轮询接口保持与文件一致（在界面里改完
 *    立刻生效，不需要刷新；手工改 JSON 后刷新也能跟上）。
 * 2. 在与界面同一页里提供调色面板：左下角小按钮打开，或在设置页的「配色」卡片里
 *    点按钮打开（卡片派发 dsh-theme-colors:open 事件）。面板跑在 Shadow DOM 里，
 *    不受应用样式影响，颜色用 DSH 主题 token，观感与原生面板一致。
 *
 * 面板只通过 /dsh-theme-colors/config.json 读写；CSS 文本一律由宿主生成，
 * 这里不重复实现配色语义。
 */
;(function () {
	'use strict'

	if (window.__dshThemeColorsLoaded === true) return
	window.__dshThemeColorsLoaded = true

	var BASE = '/dsh-theme-colors'
	var STYLE_ID = 'dsh-theme-colors-live'
	var OPEN_EVENT = 'dsh-theme-colors:open'
	var POLL_MS = 2500
	var SAVE_DELAY_MS = 160
	var PLACEHOLDER_COLOR = '#888888'

	var state = {
		config: null,
		defaults: null,
		configFile: '',
		loading: true,
	}
	var appliedCss = null
	var launcherWanted = true

	var host = null
	var shadow = null
	var panelWrap = null
	var rowsWrap = null
	var presetWrap = null
	var themeRow = null
	var lastOfficialMode = null
	/** 微调滑杆的基准：每个模式一份，避免反复拖动把变换叠加到已经变过的颜色上。 */
	var tuneBase = { light: null, dark: null }
	/** 微调控件（构建一次，之后只改值）。 */
	var tune = {
		depth: null,
		vividness: null,
		contrast: null,
		depthValue: null,
		vividnessValue: null,
		textRecommended: null,
		textCustom: null,
		textPresets: null,
		textRows: null,
		textDepth: null,
		textDepthValue: null,
		textVivid: null,
		textVividValue: null,
		gamutField: null,
		gamutCursor: null,
		gamutHint: null,
		textCustomBox: null,
		textClear: null,
		roleRows: null,
	}
	/** 上一次微调是否触发了可读性夹紧（用于提示"已到下限"）。 */
	var tuneClamped = false
	var statusEl = null
	var pathEl = null
	var tabEls = null
	var launcher = null
	var launcherToggle = null
	var mode = 'light'
	var saveTimer = null
	var saveSequence = 0
	var savedSequence = 0
	var opening = false

	/** 小工具：建元素。 */
	function el(tag, props, children) {
		var node = document.createElement(tag)
		if (props) {
			Object.keys(props).forEach(function (key) {
				if (key === 'text') node.textContent = props[key]
				else if (key === 'class') node.className = props[key]
				else if (key === 'style' && props[key] !== null && typeof props[key] === 'object') {
					Object.keys(props[key]).forEach(function (name) {
						node.style[name] = props[key][name]
					})
				} else if (key.indexOf('on') === 0) node.addEventListener(key.slice(2), props[key])
				else node.setAttribute(key, props[key])
			})
		}
		;(children || []).forEach(function (child) {
			if (child) node.appendChild(child)
		})
		return node
	}

	/** 页面里承载当前配色的 <style>；宿主注入的那份在 head 里，这份运行时覆盖它。 */
	function liveStyle() {
		var node = document.getElementById(STYLE_ID)
		if (node === null) {
			node = document.createElement('style')
			node.id = STYLE_ID
			document.head.appendChild(node)
		}
		return node
	}

	/** palette 模块（与宿主共用同一份文件）。 */
	var palettePromise = null

	/** 载入配色语义模块；失败时用下面的等价兜底实现。 */
	function loadPalette() {
		if (palettePromise === null) {
			try {
				palettePromise = import(BASE + '/palette.js')
			} catch (error) {
				palettePromise = Promise.reject(error)
			}
			palettePromise.catch(function () {})
		}
		return palettePromise
	}

	/** 深浅模式属性名（与 palette.js 一致）。 */
	var DARK_ATTR = 'data-ds-dark-theme'

	/**
	 * 区域到界面与 CSS 的映射（界面文案与 CSS 规则都从这里来）。
	 * 与 palette.js 的 REGIONS 一一对应：带 varName 的改左栏 token；带 className 的命中
	 * 布局列，中列与右列还要就地重绑定 token——列本身透明，栏内根元素会用自己的 token
	 * 背景把纯 background 盖住。
	 */
	var FALLBACK_REGIONS = [
		{
			key: 'conversation',
			label: '会话栏',
			hint: '中间对话区；栏内聊天底色、代码块同源',
			className: 'centerCol',
			scopedVar: ['--dsw-alias-bg-base'],
		},
		{
			key: 'sidebar',
			label: '左侧会话列表栏',
			hint: '会话与工作区列表所在列',
			varName: '--dsw-specific-sidebar-fill',
		},
		{
			key: 'rightbar',
			label: '右侧栏',
			hint: 'Ctrl+Shift+B 的右侧面板（文件 / 浏览器 / 终端）',
			className: 'rightbarCol',
			scopedVar: ['--dsw-alias-bg-base', '--dsw-alias-bg-layer-1'],
		},
	]

	/** 本插件真正支持的区域 key；据此过滤宿主可能多给的行（旧配置里的「页面背景」等）。 */
	var REGION_KEYS = FALLBACK_REGIONS.map(function (region) {
		return region.key
	})

	/**
	 * 日间方案：配官方「浅色」主题使用，只写进 light 那套取值。
	 * 取值由 scripts/gen-presets.mjs 按 OKLCH 目标反解：会话栏 L≈0.90、左栏 L≈0.85，
	 * 彩度按色系 0.012–0.026（在亮底上呈现明确的色调，而不是近白）。与官方浅色主题
	 * 文字色（#0f1115）对比度均 ≈12:1，远高于 WCAG AA 的 4.5:1。
	 */
	var DAY_PRESETS = [
		{ id: 'day-warm-gray', name: '米白暖灰', note: '暖灰（H 75°）', colors: { conversation: '#e3ddd5', sidebar: '#d3cdc4' } },
		{ id: 'day-pewter', name: '青灰清透', note: '莫兰迪青灰（H 186°）', colors: { conversation: '#d4e1df', sidebar: '#c3d1cf' } },
		{ id: 'day-haze-blue', name: '雾霾蓝', note: '灰调蓝（H 244°）', colors: { conversation: '#d1e0ed', sidebar: '#bfd0df' } },
		{ id: 'day-sky', name: '天青蓝', note: '青蓝（H 215°）', colors: { conversation: '#cfe2e7', sidebar: '#bcd2d8' } },
		{ id: 'day-sage', name: '鼠尾草绿', note: '灰绿（H 138°）', colors: { conversation: '#d8e1d5', sidebar: '#c7d2c3' } },
		{ id: 'day-mint', name: '薄荷雾绿', note: '薄荷绿（H 165°）', colors: { conversation: '#d3e2db', sidebar: '#c1d3ca' } },
		{ id: 'day-lilac', name: '藕荷灰紫', note: '灰紫（H 303°）', colors: { conversation: '#e0dbe8', sidebar: '#d0cbd9' } },
		{ id: 'day-wisteria', name: '丁香紫', note: '蓝紫（H 285°）', colors: { conversation: '#dcdceb', sidebar: '#ccccdd' } },
		{ id: 'day-oat', name: '燕麦米', note: '奶油米（H 77°）', colors: { conversation: '#e8dccb', sidebar: '#d9ccb9' } },
		{ id: 'day-rose', name: '灰粉胭脂', note: '玫瑰灰（H 13°）', colors: { conversation: '#ead9da', sidebar: '#dbc9c9' } },
		{ id: 'day-sakura', name: '樱粉', note: '淡粉（H 350°）', colors: { conversation: '#e7dadf', sidebar: '#d8c9cf' } },
		{ id: 'day-coral', name: '蜜桃珊瑚', note: '珊瑚暖粉（H 35°）', colors: { conversation: '#edd9d3', sidebar: '#dfc8c2' } },
		{ id: 'day-plain', name: '极昼纯白', note: '纯白底，最中性', colors: { conversation: '#ffffff', sidebar: '#f2f3f4' } },
	]

	/**
	 * 夜间方案：配官方「深色」主题使用，只写进 dark 那套取值。
	 * 会话栏 L≈0.32（墨黑 0.20）、左栏 L≈0.26，比纯黑有层次；彩度 0.006–0.058，
	 * 所以「深蓝/深绿」确实是深蓝深绿。与官方深色主题文字色对比度均 ≈12:1。
	 */
	var NIGHT_PRESETS = [
		{ id: 'night-deep-blue', name: '深蓝', note: '深海蓝（L 0.32 / C 0.058）', colors: { conversation: '#1d3450', sidebar: '#13253b' } },
		{ id: 'night-slate', name: '深青蓝', note: '板岩青蓝（H 230°）', colors: { conversation: '#1f3641', sidebar: '#142730' } },
		{ id: 'night-teal', name: '墨绿蓝', note: '青蓝偏绿（H 200°）', colors: { conversation: '#16393b', sidebar: '#0c292a' } },
		{ id: 'night-pewter', name: '青灰夜', note: '冷青灰，最接近官方深色', colors: { conversation: '#283632', sidebar: '#1b2723' } },
		{ id: 'night-pine', name: '深绿', note: '松林深绿（L 0.32 / C 0.048）', colors: { conversation: '#203a26', sidebar: '#152a19' } },
		{ id: 'night-olive', name: '深橄榄', note: '暗橄榄绿（H 110°）', colors: { conversation: '#343421', sidebar: '#252516' } },
		{ id: 'night-violet', name: '暗紫', note: '灰紫夜调（H 312°）', colors: { conversation: '#392e40', sidebar: '#29202e' } },
		{ id: 'night-indigo', name: '墨蓝紫', note: '靛蓝偏紫（H 285°）', colors: { conversation: '#303049', sidebar: '#222136' } },
		{ id: 'night-wine', name: '暗酒红', note: '酒红夜调（H 20°）', colors: { conversation: '#452b2a', sidebar: '#331d1d' } },
		{ id: 'night-cocoa', name: '暖褐可可', note: '陶土暖褐（H 62°）', colors: { conversation: '#3b3027', sidebar: '#2b221b' } },
		{ id: 'night-warm-black', name: '暖黑（低蓝光）', note: '暖调深灰，夜间护眼', colors: { conversation: '#2f2723', sidebar: '#1f1916' } },
		{ id: 'night-black', name: '墨黑', note: '近黑（L 0.20），OLED 省电', colors: { conversation: '#141619', sidebar: '#08090b' } },
		{ id: 'night-plain', name: '石墨黑', note: '中性石墨，不偏色', colors: { conversation: '#303337', sidebar: '#222427' } },
	]

	/** 把一套方案展开成完整的区域取值；右侧栏缺省时沿用左侧栏。 */
	function presetValues(preset) {
		var sidebar = preset.colors.sidebar || preset.colors.conversation
		return {
			conversation: preset.colors.conversation || sidebar,
			sidebar: sidebar,
			rightbar: preset.colors.rightbar || sidebar,
		}
	}

	/** 与 palette.colorValue 等价：未设置返回 null，半透明用 color-mix。 */
	function fallbackColorValue(entry) {
		if (entry === null || entry === undefined) return null
		var color = typeof entry.color === 'string' ? entry.color : ''
		if (!/^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(color)) return null
		var opacity = typeof entry.opacity === 'number' ? entry.opacity : 100
		if (opacity >= 100) return color
		return 'color-mix(in srgb, ' + color + ' ' + opacity + '%, transparent)'
	}

	/**
	 * 与 palette.renderCss 等价的兜底渲染：宿主进程里已加载的模块可能落后于磁盘上的
	 * 文件，而 palette.js 路由是按请求现读的——两者取不到时才用这份本地实现。
	 * scripts/test-gui.mjs 会拿 palette.renderCss 的输出逐行比对，防止两份实现漂移。
	 */
	function fallbackCss(config) {
		var lines = ['/* dsh-theme-colors —— 本地兜底渲染（应与 palette.renderCss 输出一致） */']
		var modes = [
			{ key: 'light', selector: 'body:not([' + DARK_ATTR + '])' },
			{ key: 'dark', selector: 'body[' + DARK_ATTR + '][' + DARK_ATTR + ']' },
		]
		for (var m = 0; m < modes.length; m += 1) {
			var mode = modes[m]
			// 与 palette.renderCss 相同：同一选择器下的声明（左栏 token + 推荐文字色 token）合并成一条。
			var declarations = []
			for (var i = 0; i < FALLBACK_REGIONS.length; i += 1) {
				var region = FALLBACK_REGIONS[i]
				if (region.varName === undefined) continue
				var group = config && config.regions ? config.regions[region.key] : null
				var value = fallbackColorValue(group ? group[mode.key] : null)
				if (value !== null) declarations.push(region.varName + ':' + value)
			}
			var text = config && config.text ? config.text : null
			if (text !== null && text.mode !== undefined && text.mode !== 'off') {
				var textGroup = text[mode.key] === undefined ? null : text[mode.key]
				for (var r = 0; r < TEXT_ROLES.length; r += 1) {
					var role = TEXT_ROLES[r]
					var textValue = fallbackColorValue(textGroup === null ? null : textGroup[role])
					if (textValue !== null) declarations.push(TEXT_TOKEN_BY_ROLE[role] + ':' + textValue)
				}
			}
			if (declarations.length > 0) lines.push(mode.selector + '{' + declarations.join(';') + '}')

			for (var c = 0; c < FALLBACK_REGIONS.length; c += 1) {
				var column = FALLBACK_REGIONS[c]
				if (column.className === undefined) continue
				var columnGroup = config && config.regions ? config.regions[column.key] : null
				var color = fallbackColorValue(columnGroup ? columnGroup[mode.key] : null)
				if (color === null) continue
				var parts = []
				var scoped = column.scopedVar === undefined ? [] : column.scopedVar
				for (var s = 0; s < scoped.length; s += 1) parts.push(scoped[s] + ':' + color)
				parts.push('background:' + color + ' !important')
				lines.push(mode.selector + ' [class*="' + column.className + '"]{' + parts.join(';') + '}')
			}
		}
		return lines.join('\n') + '\n'
	}

	/**
	 * 解析要应用到的 CSS：优先用同一份 palette 模块按当前配置重算——宿主进程里
	 * 已加载的模块可能落后于磁盘上的文件，而本模块按请求现读，所以宿主侧规则改动
	 * 刷新即生效；取不到模块时用等价的本地实现，最后才回落到宿主下发的文本。
	 */
	function resolveCss(payload) {
		if (payload === null || payload === undefined || typeof payload !== 'object') return Promise.resolve(null)
		if (payload.config === null || payload.config === undefined) return Promise.resolve(payload.css)
		return loadPalette()
			.then(function (palette) {
				return typeof palette.renderCss === 'function' ? palette.renderCss(payload.config) : fallbackCss(payload.config)
			})
			.catch(function () {
				return fallbackCss(payload.config)
			})
	}

	/** 应用配色 CSS；内容没变就不动 DOM。 */
	function applyCss(css) {
		if (typeof css !== 'string' || css === appliedCss) return
		appliedCss = css
		liveStyle().textContent = css
	}

	/** 当前 DSH 实际处于深色还是浅色（主题属性写在 body 上）。 */
	function activeMode() {
		return document.body && document.body.hasAttribute('data-ds-dark-theme') ? 'dark' : 'light'
	}

	/** 相对亮度（与 palette.js 的 luminance 同算法），用于提示明暗搭配。 */
	function luminance(color) {
		var match = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(color || ''))
		if (match === null) return null
		var hex = color.slice(1)
		if (hex.length === 3) hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2]
		var channels = [0, 2, 4].map(function (offset) {
			var v = parseInt(hex.slice(offset, offset + 2), 16) / 255
			return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)
		})
		return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2]
	}

	/** 两色对比度（WCAG 定义：(L1+0.05)/(L2+0.05)）。 */
	function contrastRatio(a, b) {
		var la = luminance(a)
		var lb = luminance(b)
		if (la === null || lb === null) return null
		return la > lb ? (la + 0.05) / (lb + 0.05) : (lb + 0.05) / (la + 0.05)
	}

	// ————————————————————————————————————————————————————————————————
	// 颜色科学：OKLab / OKLCH
	//
	// 为什么不用 HSL/HSV：HSL 的"亮度"不是感知亮度——同样 50% 亮度，黄色看起来远
	// 亮于蓝色，拿它做"深度"滑杆会随色相飘，而且改亮度常把颜色推向意外色相。
	// OKLab（Björn Ottosson, 2020）是感知均匀空间：等量的 L 变化在任何色相上看起来
	// 都一样，且彩度 C 与色相 H 相互独立，于是：
	//   深度   = 只改 L（明度）
	//   鲜亮度 = 只改 C（彩度），按该 L/H 下 sRGB 能达到的最大彩度取比例；超出色域时
	//            按 CSS Color 4 的做法降彩度（保 L 与 H），不会出现溢出的怪色。
	// ————————————————————————————————————————————————————————————————

	/** sRGB 分量（0..1，gamma 编码）→ 线性光。 */
	function srgbToLinear(v) {
		return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)
	}

	/** 线性光 → sRGB 分量（0..1）。 */
	function linearToSrgb(v) {
		return v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055
	}

	/** 十六进制 → [r,g,b]（0..1）；非法返回 null。 */
	function hexToRgb01(color) {
		var match = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(color || ''))
		if (match === null) return null
		var hex = color.slice(1)
		if (hex.length === 3) hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2]
		return [0, 2, 4].map(function (offset) {
			return parseInt(hex.slice(offset, offset + 2), 16) / 255
		})
	}

	/** [r,g,b]（0..1）→ 十六进制；越界分量夹紧。 */
	function rgbToHex(rgb) {
		return (
			'#' +
			rgb
				.map(function (v) {
					var byte = Math.round(Math.min(1, Math.max(0, v)) * 255)
					return (byte < 16 ? '0' : '') + byte.toString(16)
				})
				.join('')
		)
	}

	/** 线性 sRGB → OKLab。 */
	function linearToOklab(linear) {
		var l = Math.cbrt(0.4122214708 * linear[0] + 0.5363325363 * linear[1] + 0.0514459929 * linear[2])
		var m = Math.cbrt(0.2119034982 * linear[0] + 0.6806995451 * linear[1] + 0.1073969566 * linear[2])
		var s = Math.cbrt(0.0883024619 * linear[0] + 0.2817188376 * linear[1] + 0.6299787005 * linear[2])
		return {
			L: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
			a: 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
			b: 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
		}
	}

	/** OKLab → 线性 sRGB。 */
	function oklabToLinear(lab) {
		var l = Math.pow(lab.L + 0.3963377774 * lab.a + 0.2158037573 * lab.b, 3)
		var m = Math.pow(lab.L - 0.1055613458 * lab.a - 0.0638541728 * lab.b, 3)
		var s = Math.pow(lab.L - 0.0894841775 * lab.a - 1.291485548 * lab.b, 3)
		return [
			4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
			-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
			-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
		]
	}

	/**
	 * 线性 sRGB 是否在色域内。判定放在 gamma 编码域、容差 1/255：
	 * Oklab 往返在 sRGB 角点附近会让某个通道先轻微下探（8 位色深下不足 1 个色阶），
	 * 用线性域的极小容差会把纯蓝这类合法颜色误判为出色域。
	 */
	function inGamut(linear) {
		for (var i = 0; i < 3; i += 1) {
			var encoded = linearToSrgb(linear[i])
			if (encoded < -0.002 || encoded > 1.002) return false
		}
		return true
	}

	/** (L,C,H) → 线性 sRGB。 */
	function oklchToLinear(lch) {
		var rad = (lch.H * Math.PI) / 180
		return oklabToLinear({ L: lch.L, a: Math.cos(rad) * lch.C, b: Math.sin(rad) * lch.C })
	}

	/** 给定明度与色相，sRGB 色域内能达到的最大彩度（二分）。 */
	function maxChroma(L, H) {
		if (L <= 0) return 0
		var lo = 0
		var hi = 0.4
		for (var i = 0; i < 26; i += 1) {
			var mid = (lo + hi) / 2
			if (inGamut(oklchToLinear({ L: L, C: mid, H: H }))) lo = mid
			else hi = mid
		}
		return lo
	}

	/** 十六进制 → OKLCH；非法返回 null。 */
	function hexToOklch(color) {
		var rgb = hexToRgb01(color)
		if (rgb === null) return null
		var lab = linearToOklab(rgb.map(srgbToLinear))
		var C = Math.sqrt(lab.a * lab.a + lab.b * lab.b)
		var H = (Math.atan2(lab.b, lab.a) * 180) / Math.PI
		if (H < 0) H += 360
		return { L: lab.L, C: C, H: H }
	}

	/**
	 * OKLCH → 十六进制。
	 * 先看请求的颜色本身是否在 sRGB 内：在就原样返回——OKLab 下的 sRGB 色域并不严格
	 * 凸（纯蓝角点附近，等 L/H 的射线会先出界再回到角点），若一律按"该明度色相下的
	 * 最大彩度"去截断，会把 #0000ff 这类合法色改淡。真的出界时才二分降彩度（保 L 与 H，
	 * 与 CSS Color 4 的色域映射一致）。
	 */
	function oklchToHex(lch) {
		var L = Math.min(1, Math.max(0, lch.L))
		var H = ((lch.H % 360) + 360) % 360
		var C = Math.max(0, lch.C)
		if (inGamut(oklchToLinear({ L: L, C: C, H: H }))) {
			return rgbToHex(oklchToLinear({ L: L, C: C, H: H }).map(linearToSrgb))
		}
		var lo = 0
		var hi = C
		for (var i = 0; i < 24; i += 1) {
			var mid = (lo + hi) / 2
			if (inGamut(oklchToLinear({ L: L, C: mid, H: H }))) lo = mid
			else hi = mid
		}
		return rgbToHex(oklchToLinear({ L: L, C: lo, H: H }).map(linearToSrgb))
	}

	/**
	 * 深度滑杆两端对应的会话栏明度（OKLCH 的 L，感知明度）。
	 * 换算关系提醒：中性灰上 WCAG 相对亮度 ≈ L³，所以
	 *   浅色最深 L=0.66 → WCAG 0.29 → 与 #0f1115 对比 ≈6.1:1
	 *   深色最浅 L=0.48 → WCAG 0.11 → 与 #f9fafb 对比 ≈6.3:1
	 * 两端都留了余量。端点不取 0 与 1 是因为：纯黑/纯白处 sRGB 能容纳的彩度必然是 0，
	 * 拉到极值时"鲜亮度"就会失效；0.05 与 0.97 在观感上已分别等同纯黑、纯白。
	 * 万一基准色本身内部明暗差极大，deriveScheme 还会做一次可读性夹紧（clampReadable）。
	 */
	var LIGHT_LIGHTEST_L = 0.97
	var LIGHT_DEEPEST_L = 0.66
	var DARK_LIGHTEST_L = 0.48
	var DARK_DEEPEST_L = 0.05
	/** 鲜亮度 100 时取该 L/H 下 sRGB 最大彩度的这个比例（背景要克制，不宜拉满）。 */
	var CHROMA_RATIO_AT_MAX = 0.55
	/** WCAG AA 正文对比度门槛。 */
	var AA_CONTRAST = 4.5

	/** 深度（0 最浅 … 100 最深）→ 会话栏明度 L。 */
	function depthToLightness(modeKey, depth) {
		var d = Math.min(100, Math.max(0, depth)) / 100
		return modeKey === 'dark'
			? DARK_LIGHTEST_L + (DARK_DEEPEST_L - DARK_LIGHTEST_L) * d
			: LIGHT_LIGHTEST_L + (LIGHT_DEEPEST_L - LIGHT_LIGHTEST_L) * d
	}

	/** 会话栏明度 L → 深度滑杆值（回填滑杆用）。 */
	function lightnessToDepth(modeKey, L) {
		var value =
			modeKey === 'dark'
				? (L - DARK_LIGHTEST_L) / (DARK_DEEPEST_L - DARK_LIGHTEST_L)
				: (L - LIGHT_LIGHTEST_L) / (LIGHT_DEEPEST_L - LIGHT_LIGHTEST_L)
		return Math.round(Math.min(100, Math.max(0, value * 100)))
	}

	/** 彩度 → 鲜亮度滑杆值（相对该 L/H 的色域上限）。 */
	function chromaToVividness(L, H, C) {
		var ceiling = maxChroma(L, H)
		if (ceiling <= 0.0001) return 0
		return Math.round(Math.min(100, Math.max(0, (C / ceiling / CHROMA_RATIO_AT_MAX) * 100)))
	}

	/**
	 * 生成一个区域的颜色，并在必要时做可读性夹紧：若该色与主题文字色的对比度低于
	 * WCAG AA，就把明度朝"更亮（浅色主题）/ 更暗（深色主题）"的方向移到刚好达标
	 * （色相与彩度比例不变）。这样滑杆在任何基准色下都不会给出读不清的底色。
	 * @returns { hex, clamped }
	 */
	function readableColor(modeKey, L, ratio, H) {
		function build(atL) {
			return oklchToHex({ L: atL, C: maxChroma(atL, H) * ratio, H: H })
		}
		var hex = build(L)
		var contrast = contrastRatio(THEME_TEXT[modeKey], hex)
		if (contrast === null || contrast >= AA_CONTRAST) return { hex: hex, clamped: false }
		var safe = modeKey === 'light' ? 1 : 0
		var unsafe = L
		var best = build(safe)
		for (var i = 0; i < 24; i += 1) {
			var mid = (safe + unsafe) / 2
			var candidate = build(mid)
			var candidateContrast = contrastRatio(THEME_TEXT[modeKey], candidate)
			if (candidateContrast !== null && candidateContrast >= AA_CONTRAST) {
				safe = mid
				best = candidate
			} else {
				unsafe = mid
			}
		}
		return { hex: best, clamped: true }
	}

	/**
	 * 由基准配色 + 两个滑杆重算一套取值：三个区域各自保留自己的色相，明度按"相对
	 * 会话栏的深浅差"整体平移，彩度按同一天花板比例取值——方案的结构（例如左栏比
	 * 会话栏略深、右栏与左栏同色）因此保持不变，只整体变深/变浅、变灰/变艳。
	 * @param base - { conversation, sidebar, rightbar } 基准十六进制色。
	 * @param modeKey - light / dark。
	 * @param depth - 0..100，越大越深。
	 * @param vividness - 0..100，越大越鲜明。
	 * @returns { colors, clamped } ：三个区域的新色值，以及是否触发了可读性夹紧。
	 */
	function deriveScheme(base, modeKey, depth, vividness) {
		var baseConversation = hexToOklch(base.conversation)
		if (baseConversation === null) return null
		var targetL = depthToLightness(modeKey, depth)
		var ratio = (Math.min(100, Math.max(0, vividness)) / 100) * CHROMA_RATIO_AT_MAX
		var colors = {}
		var clamped = false
		REGION_KEYS.forEach(function (key) {
			var lch = hexToOklch(base[key] === undefined ? base.conversation : base[key])
			if (lch === null) lch = baseConversation
			var L = Math.min(1, Math.max(0, targetL + (lch.L - baseConversation.L)))
			var result = readableColor(modeKey, L, ratio, lch.H)
			if (result.clamped) clamped = true
			colors[key] = result.hex
		})
		return { colors: colors, clamped: clamped }
	}

	/** 各主题下界面文字的实际颜色（取自 --dsw-alias-label-primary），用作对比度基准。 */
	var THEME_TEXT = { light: '#0f1115', dark: '#f9fafb' }

	// ————————————————————————————————————————————————————————————————
	// 文字色：跟随官方 / 推荐（按方案推导）/ 自定义
	//
	// 科学依据：
	// 1) 对比度分档取 WCAG——正文 7:1（AAA）、次要 4.5:1（AA）、三级 3:1（大字号）。
	//    每行右侧显示该档对本模式三个区域表面的**最差**比值，低于目标标红。
	// 2) 文字极性由**表面亮度**决定（浅面配深字、深面配亮字），不看模式标签，
	//    所以把浅色面放进深色那套时推出来的字依然读得清。
	// 3) 「推荐色」与「同色相」预设：色相取自表面，彩度取**绝对目标值**（不是表面的
	//    彩度比例——背景本身很灰时那样乘出来几乎归零，等于没上色），明度按对比度目标夹紧。
	// 4) 自定义模式提供色域图（横轴色相 × 纵轴明度，按当前彩度实时渲染可达颜色）与
	//    深度 / 鲜亮度两个滑杆，都在可读性范围内取值。
	// ————————————————————————————————————————————————————————————————
	var TEXT_ROLES = ['primary', 'secondary', 'tertiary']
	var TEXT_ROLE_LABELS = { primary: '主文字', secondary: '次文字', tertiary: '三级文字' }
	var TEXT_MODES = ['off', 'recommended', 'custom']
	var TEXT_TOKEN_BY_ROLE = {
		primary: '--dsw-alias-label-primary',
		secondary: '--dsw-alias-label-secondary',
		tertiary: '--dsw-alias-label-tertiary',
	}
	/** 各层级文字色的明度起点；极性直接写清楚，避免"深色主题配深色字"这类混淆。 */
	var TEXT_TONES = {
		'dark-text': { primary: 0.2, secondary: 0.34, tertiary: 0.46 },
		'light-text': { primary: 0.92, secondary: 0.78, tertiary: 0.66 },
	}
	/** 各层级文字色的对比度目标（WCAG）。 */
	var TEXT_TARGETS = { primary: 7, secondary: 4.5, tertiary: 3 }
	/** 「推荐色 / 同色相」的绝对彩度目标：够看出色调，又远低于正文可读的容忍上限。 */
	var TEXT_TINTS = { primary: 0.03, secondary: 0.042, tertiary: 0.052 }
	/** 官方主题各区域在未自定义时的表面色（取自主题 token，用作对比度基准）。 */
	var THEME_SURFACES = {
		light: { conversation: '#ffffff', sidebar: '#f9fafb', rightbar: '#ffffff' },
		dark: { conversation: '#151517', sidebar: '#1b1b1c', rightbar: '#151517' },
	}
	/**
	 * 文字深度范围（OKLCH L）：near 靠表面、far 离表面最远。
	 * far 端不取 0 / 1：纯黑纯白处 sRGB 容不下任何彩度，会把「文字鲜亮度」变成死控；
	 * 0.03 / 0.97 在观感上已分别等同纯黑、纯白。
	 */
	var TEXT_DEPTH_RANGE = { 'dark-text': { near: 0.45, far: 0.03 }, 'light-text': { near: 0.55, far: 0.97 } }

	/** 该模式下三个区域**实际生效**的表面色（未自定义的按官方主题算）。 */
	function textSurfaces(modeKey) {
		var configured = currentColors(modeKey)
		var fallback = THEME_SURFACES[modeKey]
		var out = {}
		for (var i = 0; i < REGION_KEYS.length; i += 1) {
			var key = REGION_KEYS[i]
			out[key] = configured[key] === '' ? fallback[key] : configured[key]
		}
		return out
	}

	/** 该模式的三个表面是否明暗相反（此时单一文字色不可能都看得清）。 */
	function surfacesPolarityMixed(modeKey) {
		var sides = {}
		var surfacesMap = textSurfaces(modeKey)
		for (var i = 0; i < REGION_KEYS.length; i += 1) {
			var lch = hexToOklch(surfacesMap[REGION_KEYS[i]])
			if (lch === null) continue
			sides[lch.L > 0.5 ? 'light' : 'dark'] = true
		}
		return sides.light === true && sides.dark === true
	}

	/** 由一组表面色判断文字极性：浅色面配深字（dark-text），深色面配亮字（light-text）。 */
	function polarityOfSurfaces(surfacesMap) {
		var surface = hexToOklch(surfacesMap.conversation)
		if (surface === null) return 'dark-text'
		return surface.L > 0.5 ? 'dark-text' : 'light-text'
	}

	/** 当前模式下生效的文字极性。 */
	function textPolarity(modeKey) {
		return polarityOfSurfaces(textSurfaces(modeKey))
	}

	/** 深度（0 靠表面 … 100 离表面最远）→ 主文字明度 L。 */
	function textDepthToLightness(polarity, depth) {
		var range = TEXT_DEPTH_RANGE[polarity]
		var d = Math.min(100, Math.max(0, depth)) / 100
		return range.near + (range.far - range.near) * d
	}

	/** 主文字明度 L → 深度滑杆值。 */
	function textLightnessToDepth(polarity, L) {
		var range = TEXT_DEPTH_RANGE[polarity]
		var span = range.far - range.near
		if (span === 0) return 0
		return Math.round(Math.min(100, Math.max(0, ((L - range.near) / span) * 100)))
	}

	/**
	 * 内置文字色预设：每套含浅色面与深色面各三档；取值由 scripts/gen-text-presets.mjs
	 * 对全部方案表面逐一验算，主 ≥7:1、次 ≥4.5:1、三级 ≥3:1。
	 */
	var TEXT_PRESETS = [
		{ id: 'warm-ink', name: '暖墨', note: '暖调墨色，配暖底不脏', light: ['#2a231c', '#4a4036', '#6b5f52'], dark: ['#ece5db', '#c4b8a8', '#9d9184'] },
		{ id: 'cool-ink', name: '冷墨', note: '冷调墨色，配冷底更清爽', light: ['#1b2029', '#3a4250', '#5a6373'], dark: ['#e2e7ef', '#b6bfcc', '#8c96a4'] },
		{ id: 'neutral-ink', name: '中性灰墨', note: '不偏色的灰阶文字', light: ['#262626', '#454545', '#666666'], dark: ['#e8e8e8', '#bdbdbd', '#949494'] },
		{ id: 'max-contrast', name: '纯黑纯白', note: '对比最高，眼睛敏感者慎用', light: ['#000000', '#333333', '#555555'], dark: ['#ffffff', '#cccccc', '#a3a3a3'] },
		{ id: 'hue-matched', name: '同色相', note: '色相取自当前方案表面，彩度给足', derived: true },
	]

	/** 逐档生成一个文字色：明度朝"远离表面"的方向移动，直到所有表面都达到目标对比度。 */
	function textColorAt(polarity, startL, chroma, H, target, surfaces) {
		function build(L) {
			return oklchToHex({ L: L, C: Math.min(chroma, maxChroma(L, H)), H: H })
		}
		function worstRatio(color) {
			var worst = Number.POSITIVE_INFINITY
			for (var i = 0; i < surfaces.length; i += 1) {
				var ratioNow = contrastRatio(color, surfaces[i])
				if (ratioNow !== null) worst = Math.min(worst, ratioNow)
			}
			return worst
		}
		var L = startL
		var color = build(L)
		// 深字要继续压暗，亮字要继续提亮。
		var step = polarity === 'dark-text' ? -0.01 : 0.01
		var guard = 0
		while (worstRatio(color) < target && guard < 120) {
			L = Math.min(1, Math.max(0, L + step))
			color = build(L)
			guard += 1
			if (L <= 0 || L >= 1) break
		}
		return color
	}

	/**
	 * 「推荐色 / 同色相」：色相取表面色相，彩度取绝对目标值，明度按对比度目标解出。
	 * 明暗极性跟着表面亮度走，所以把浅色面放进深色那套也读得清。
	 * @param surfacesMap - { conversation, sidebar, rightbar } 用于对比度基准的表面色。
	 * @returns 三个层级的十六进制色；表面色非法时返回 null。
	 */
	function deriveTintedTextColorsFor(surfacesMap, modeKey) {
		void modeKey
		var reference = hexToOklch(surfacesMap.conversation)
		if (reference === null) return null
		var surfaces = []
		for (var i = 0; i < REGION_KEYS.length; i += 1) surfaces.push(surfacesMap[REGION_KEYS[i]])
		var polarity = polarityOfSurfaces(surfacesMap)
		var tones = TEXT_TONES[polarity]
		var out = {}
		for (var r = 0; r < TEXT_ROLES.length; r += 1) {
			var role = TEXT_ROLES[r]
			out[role] = textColorAt(polarity, tones[role], TEXT_TINTS[role], reference.H, TEXT_TARGETS[role], surfaces)
		}
		return out
	}

	/** 按当前模式生效的表面推导推荐文字色。 */
	function deriveTintedTextColors(modeKey) {
		return deriveTintedTextColorsFor(textSurfaces(modeKey), modeKey)
	}

	/**
	 * 由基准文字色 + 深度 / 鲜亮度 / 色相重算三档文字色：三档之间保留原有的明度差
	 * （次级、三级依次靠近表面），色相统一取给定值或基准主文字的色相。
	 * @param base - { primary, secondary, tertiary } 基准文字色。
	 * @param modeKey - light / dark。
	 * @param depth - 0..100，越大越远离表面。
	 * @param vividness - 0..100，彩度比例（100 = 该明度色相下 sRGB 上限的 55%）。
	 * @param hue - 可选，覆盖色相（色域图用）。
	 * @returns 三个层级的色值，或 null（基准色非法）。
	 */
	function deriveTextScheme(base, modeKey, depth, vividness, hue) {
		var basePrimary = hexToOklch(base.primary)
		if (basePrimary === null) return null
		var polarity = textPolarity(modeKey)
		var surfacesMap = textSurfaces(modeKey)
		var surfaces = []
		for (var k = 0; k < REGION_KEYS.length; k += 1) surfaces.push(surfacesMap[REGION_KEYS[k]])
		var targetL = textDepthToLightness(polarity, depth)
		var H = hue === undefined || hue === null ? basePrimary.H : ((hue % 360) + 360) % 360
		var ratio = (Math.min(100, Math.max(0, vividness)) / 100) * CHROMA_RATIO_AT_MAX
		var out = {}
		for (var i = 0; i < TEXT_ROLES.length; i += 1) {
			var role = TEXT_ROLES[i]
			var roleBase = hexToOklch(base[role])
			if (roleBase === null) roleBase = basePrimary
			var L = Math.min(1, Math.max(0, targetL + (roleBase.L - basePrimary.L)))
			out[role] = textColorAt(polarity, L, maxChroma(L, H) * ratio, H, TEXT_TARGETS[role], surfaces)
		}
		return out
	}

	/** 实际生效的文字色：启用推荐文字色时用配置里的，否则用官方主题的。 */
	function effectiveTextColor(modeKey) {
		if (state.config !== null && textMode() !== 'off') {
			var group = state.config.text[modeKey]
			var entry = group === undefined || group === null ? null : group.primary
			if (entry !== null && entry !== undefined && typeof entry.color === 'string' && entry.color !== '') return entry.color
		}
		return THEME_TEXT[modeKey]
	}

	/** 当前文字色状态（off / recommended / custom）；缺字段时视为 off。 */
	function textMode() {
		if (state.config === null || state.config.text === null || typeof state.config.text !== 'object') return 'off'
		return TEXT_MODES.indexOf(state.config.text.mode) === -1 ? 'off' : state.config.text.mode
	}

	/**
	 * 保证配置里有 text 段。宿主侧也可能是尚未认识该字段的旧版本（未重启），
	 * 因此界面自己补齐结构，并在保存后把取值镜像到 localStorage——
	 * 旧宿主的归一化会把不认识的字段丢掉，本地镜像保证开关一保存不会立刻失效；
	 * 宿主重启后配置文件里有了该字段，镜像自动让位。
	 */
	var TEXT_MIRROR_KEY = 'dsh-theme-colors:text'

	/** 保证 text 段存在（旧宿主下发的配置可能没有）。 */
	function ensureTextSection() {
		if (state.config === null) return null
		if (state.config.text === null || typeof state.config.text !== 'object') {
			state.config.text = { mode: 'off', light: {}, dark: {} }
		}
		if (TEXT_MODES.indexOf(state.config.text.mode) === -1) state.config.text.mode = 'off'
		if (state.config.text.light === null || typeof state.config.text.light !== 'object') state.config.text.light = {}
		if (state.config.text.dark === null || typeof state.config.text.dark !== 'object') state.config.text.dark = {}
		return state.config.text
	}

	/** 把推荐文字色镜像到 localStorage；null 表示清除。 */
	function writeTextMirror(text) {
		try {
			if (text === null || text === undefined) window.localStorage.removeItem(TEXT_MIRROR_KEY)
			else window.localStorage.setItem(TEXT_MIRROR_KEY, JSON.stringify(text))
		} catch (error) {
			/* 无 localStorage（隐私模式等）时忽略，配置仍会在宿主支持后落盘 */
		}
	}

	/** 读回镜像；没有则返回 null。 */
	function readTextMirror() {
		try {
			var raw = window.localStorage.getItem(TEXT_MIRROR_KEY)
			return raw === null ? null : JSON.parse(raw)
		} catch (error) {
			return null
		}
	}

	/** 当前模式下已保存的推荐文字色（未设置时为空串）。 */
	function storedTextColors(modeKey) {
		var out = {}
		for (var i = 0; i < TEXT_ROLES.length; i += 1) {
			var role = TEXT_ROLES[i]
			var group = state.config === null || state.config.text === undefined ? null : state.config.text[modeKey]
			var entry = group === null || group === undefined ? null : group[role]
			out[role] = entry === null || entry === undefined || typeof entry.color !== 'string' ? '' : entry.color
		}
		return out
	}

	/** 把一组文字色写进某个模式。 */
	function writeTextColors(modeKey, colors) {
		var text = ensureTextSection()
		if (text === null) return
		for (var r = 0; r < TEXT_ROLES.length; r += 1) {
			var role = TEXT_ROLES[r]
			var color = colors === null || colors[role] === undefined ? '' : colors[role]
			text[modeKey][role] = { color: color, opacity: 100 }
		}
	}

	/**
	 * 切换文字色状态（off / recommended / custom）。
	 * 选 recommended 时立即按当前方案推导两套；选 off 时保留取值但不再覆盖官方文字色。
	 */
	function setTextMode(next) {
		var text = ensureTextSection()
		if (text === null) return false
		text.mode = TEXT_MODES.indexOf(next) === -1 ? 'off' : next
		if (text.mode === 'recommended') {
			writeTextColors('light', deriveTintedTextColors('light'))
			writeTextColors('dark', deriveTintedTextColors('dark'))
		}
		writeTextMirror(text)
		return true
	}

	/** 推荐色跟随方案：表面变化时重新推导两套（仅 recommended 状态下动作）。 */
	function refreshRecommendedText() {
		if (textMode() !== 'recommended') return
		var text = ensureTextSection()
		if (text === null) return
		writeTextColors('light', deriveTintedTextColors('light'))
		writeTextColors('dark', deriveTintedTextColors('dark'))
		writeTextMirror(text)
	}

	/**
	 * 套用一套文字色预设（进入自定义状态）。绝对配色（暖墨/冷墨/…）同时写入浅色与深色两套；
	 * 「同色相」则分别按两套方案各自的表面推导。
	 * @param preset - TEXT_PRESETS 里的一条。
	 * @returns 是否写入成功。
	 */
	function applyTextPreset(preset) {
		if (state.config === null) return false
		var text = ensureTextSection()
		if (text === null) return false
		for (var m = 0; m < 2; m += 1) {
			var modeKey = m === 0 ? 'light' : 'dark'
			if (preset.derived === true) {
				writeTextColors(modeKey, deriveTintedTextColors(modeKey))
				continue
			}
			var colors = {}
			for (var r = 0; r < TEXT_ROLES.length; r += 1) colors[TEXT_ROLES[r]] = preset[modeKey][r]
			writeTextColors(modeKey, colors)
		}
		text.mode = 'custom'
		writeTextMirror(text)
		return true
	}

	/** 回到跟随官方主题（清空三档并置为 off）。 */
	function clearTextColors() {
		var text = ensureTextSection()
		if (text === null) return
		for (var m = 0; m < 2; m += 1) writeTextColors(m === 0 ? 'light' : 'dark', null)
		text.mode = 'off'
		writeTextMirror(text)
	}

	/** 文字色的微调基准（每个模式一份），拖动 / 取色都从它出发，避免反复变换累积失真。 */
	var textTuneBase = { light: null, dark: null }

	/** 用当前文字色重设微调基准与两个滑杆 / 色域图（打开面板、切页签、套预设后调用）。 */
	function syncTextTune() {
		if (tune.textDepth === null || state.config === null) return
		var stored = storedTextColors(mode)
		var base = {
			primary: stored.primary,
			secondary: stored.secondary,
			tertiary: stored.tertiary,
		}
		if (base.primary === '' || hexToOklch(base.primary) === null) {
			// 没有基准时用推荐色起手（不写入配置，只作为滑杆起点）。
			var seed = deriveTintedTextColors(mode)
			if (seed === null) return
			base = seed
		}
		textTuneBase[mode] = base
		var primary = hexToOklch(base.primary)
		if (primary === null) return
		var polarity = textPolarity(mode)
		var depth = textLightnessToDepth(polarity, primary.L)
		var vividness = chromaToVividness(primary.L, primary.H, primary.C)
		tune.textDepth.value = String(depth)
		tune.textVivid.value = String(vividness)
		tune.textDepthValue.textContent = depth + '　' + (polarity === 'dark-text' ? '越深越黑' : '越深越亮')
		tune.textVividValue.textContent = vividness + '　C ' + primary.C.toFixed(3)
		renderGamut()
	}

	/** 拖动文字深度 / 鲜亮度：按基准重算当前模式的三档文字色。 */
	function applyTextTune() {
		if (textTuneBase[mode] === null) return
		var derived = deriveTextScheme(
			textTuneBase[mode],
			mode,
			Number(tune.textDepth.value),
			Number(tune.textVivid.value),
		)
		if (derived === null) return
		var text = ensureTextSection()
		if (text === null) return
		writeTextColors(mode, derived)
		if (text.mode !== 'custom') text.mode = 'custom'
		writeTextMirror(text)
		var primary = hexToOklch(derived.primary)
		tune.textDepthValue.textContent =
			tune.textDepth.value + '　' + (textPolarity(mode) === 'dark-text' ? '越深越黑' : '越深越亮')
		tune.textVividValue.textContent = tune.textVivid.value + '　C ' + (primary === null ? '—' : primary.C.toFixed(3))
		renderGamut()
		syncTextRow()
		renderRows()
		scheduleSave()
	}

	/**
	 * 渲染色域图：横轴色相、纵轴明度，按当前彩度实时算出**可达颜色**（不是固定的彩虹图）。
	 * 点击 / 拖动即在图上取色（色相 + 明度），三档文字色按各自相对明度差一起生成。
	 */
	function renderGamut() {
		if (tune.gamutField === null) return
		var polarity = textPolarity(mode)
		var range = TEXT_DEPTH_RANGE[polarity]
		var depth = Number(tune.textDepth.value)
		var vividness = Number(tune.textVivid.value)
		var ratio = (vividness / 100) * CHROMA_RATIO_AT_MAX
		var midL = textDepthToLightness(polarity, depth)
		var stops = []
		for (var i = 0; i <= 12; i += 1) {
			var hue = (i / 12) * 360
			stops.push(oklchToHex({ L: midL, C: maxChroma(midL, hue) * ratio, H: hue }) + ' ' + Math.round((i / 12) * 100) + '%')
		}
		// 横向是色相；纵向叠一层明度（上亮下暗），与点击时的换算方向一致。
		tune.gamutField.style.background =
			'linear-gradient(to bottom, rgba(255,255,255,.92), rgba(255,255,255,0) 46%, rgba(0,0,0,.55) 54%, rgba(0,0,0,.92)), linear-gradient(to right,' +
			stops.join(',') +
			')'
		tune.gamutHint.textContent =
			'色域图：横轴色相、纵轴明度（' + (polarity === 'dark-text' ? '上浅下深' : '上亮下暗') + '）'
		var base = textTuneBase[mode]
		var primary = base === null ? null : hexToOklch(base.primary)
		var left = primary === null ? 50 : Math.round((primary.H / 360) * 100)
		var top = primary === null ? 50 : Math.round(((range.near - primary.L) / (range.near - range.far)) * 100)
		tune.gamutCursor.style.left = Math.min(98, Math.max(0, left)) + '%'
		tune.gamutCursor.style.top = Math.min(96, Math.max(0, top)) + '%'
		tune.gamutCursor.style.background = primary === null ? '#888' : tune.textDepth.value === '' ? '#888' : base.primary
	}

	/** 在色域图上取色：横轴 → 色相，纵轴 → 明度（再由明度换回深度）。 */
	function pickFromGamut(event) {
		if (tune.gamutField === null || textTuneBase[mode] === null) return
		var rect = typeof tune.gamutField.getBoundingClientRect === 'function' ? tune.gamutField.getBoundingClientRect() : null
		if (rect === null || rect.width <= 0 || rect.height <= 0) return
		var x = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width))
		var y = Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height))
		var polarity = textPolarity(mode)
		var range = TEXT_DEPTH_RANGE[polarity]
		// 纵轴顶端 = near 端（靠表面那一侧），底端 = far 端。
		var L = range.near + (range.far - range.near) * y
		tune.textDepth.value = String(textLightnessToDepth(polarity, L))
		var derived = deriveTextScheme(
			textTuneBase[mode],
			mode,
			Number(tune.textDepth.value),
			Number(tune.textVivid.value),
			x * 360,
		)
		if (derived === null) return
		var text = ensureTextSection()
		if (text === null) return
		writeTextColors(mode, derived)
		text.mode = 'custom'
		writeTextMirror(text)
		// 取色后把基准的色相也更新，后续拖滑杆不会跳回旧色相。
		textTuneBase[mode] = { primary: derived.primary, secondary: derived.secondary, tertiary: derived.tertiary }
		renderGamut()
		syncTextRow()
		renderRows()
		scheduleSave()
	}

	/** 把 #rgb 展开成 #rrggbb；非法返回 null。 */
	function normalizeHex(value) {
		var raw = String(value || '').trim()
		if (/^#[0-9a-f]{3}$/i.test(raw)) {
			return ('#' + raw[1] + raw[1] + raw[2] + raw[2] + raw[3] + raw[3]).toLowerCase()
		}
		if (/^#[0-9a-f]{6}$/i.test(raw)) return raw.toLowerCase()
		return null
	}

	function setStatus(text, tone) {
		if (statusEl === null) return
		statusEl.textContent = text || ''
		statusEl.setAttribute('data-tone', tone || 'muted')
	}

	/** 读取一份接口数据，填入 state。 */
	function adopt(payload) {
		if (payload === null || typeof payload !== 'object') return false
		state.config = payload.config || state.config
		state.defaults = payload.defaults || state.defaults
		state.configFile = payload.configFile || state.configFile
		state.loading = false
		// 推荐文字色：宿主还不认识该字段时用本地镜像兜住；宿主给出该字段后镜像让位。
		if (state.config !== null) {
			if (state.config.text === undefined || state.config.text === null) {
				var mirrored = readTextMirror()
				if (mirrored !== null) state.config.text = mirrored
			} else {
				writeTextMirror(state.config.text)
			}
		}
		launcherWanted = !state.config || state.config.launcher !== false
		syncLauncher()
		return true
	}

	async function fetchConfig() {
		var response = await fetch(BASE + '/config.json', { cache: 'no-store' })
		if (!response.ok) throw new Error('HTTP ' + response.status)
		var payload = await response.json()
		adopt(payload)
		applyCss(await resolveCss(payload))
		return payload
	}

	/** 保存（防抖）：PUT 整份配置，返回的 CSS 立刻生效。 */
	function scheduleSave() {
		if (saveTimer !== null) clearTimeout(saveTimer)
		saveSequence += 1
		setStatus('保存中…', 'busy')
		saveTimer = setTimeout(function () {
			saveTimer = null
			saveNow()
		}, SAVE_DELAY_MS)
	}

	async function saveNow() {
		var sequence = saveSequence
		try {
			var response = await fetch(BASE + '/config.json', {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json', 'x-dsh-theme-colors': '1' },
				body: JSON.stringify(state.config),
			})
			if (!response.ok) throw new Error('HTTP ' + response.status)
			var payload = await response.json()
			adopt(payload)
			applyCss(await resolveCss(payload))
			savedSequence = sequence
			try {
				window.dispatchEvent(new CustomEvent('dsh-theme-colors:changed'))
			} catch (error) {
				/* 没有订阅者时忽略 */
			}
			if (sequence === saveSequence) {
				var now = new Date()
				var pad = function (n) {
					return n < 10 ? '0' + n : String(n)
				}
				setStatus('已保存 ' + pad(now.getHours()) + ':' + pad(now.getMinutes()) + ':' + pad(now.getSeconds()), 'ok')
			}
		} catch (error) {
			setStatus('保存失败：' + String((error && error.message) || error), 'error')
		}
	}

	/** 当前正在编辑哪一种主题的取值。 */
	function entryOf(regionKey) {
		return state.config.regions[regionKey][mode]
	}

	/** 把文本复制到剪贴板；剪贴板 API 不可用时回退为选中输入框。 */
	function copyText(text, input) {
		return new Promise(function (resolve) {
			function fallback() {
				try {
					if (input !== null && input !== undefined && typeof input.select === 'function') {
						input.focus()
						input.select()
						if (typeof document.execCommand === 'function') {
							resolve(document.execCommand('copy') === true)
							return
						}
					}
				} catch (error) {
					/* 回退也失败时报告失败 */
				}
				resolve(false)
			}
			try {
				if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
					navigator.clipboard.writeText(text).then(function () {
						resolve(true)
					}, fallback)
					return
				}
			} catch (error) {
				/* 落到下面的回退 */
			}
			fallback()
		})
	}

	/** 重画某一行的取值显示（不重建节点，避免输入焦点丢失）。 */
	function syncRow(row) {
		var entry = entryOf(row.regionKey)
		var following = entry.color === ''
		row.root.setAttribute('data-following', following ? 'yes' : 'no')
		row.colorInput.value = following ? PLACEHOLDER_COLOR : entry.color
		row.hexInput.value = entry.color
		row.hexInput.disabled = following
		row.opacityInput.disabled = following
		row.opacityInput.value = String(entry.opacity)
		row.pct.textContent = following ? '—' : entry.opacity + '%'
		row.followBtn.style.visibility = following ? 'hidden' : 'visible'
		row.copyBtn.disabled = following
		row.applyBtn.disabled = following
		var ratio = following ? null : contrastRatio(effectiveTextColor(mode), entry.color)
		row.ratio.textContent = ratio === null ? '' : ratio.toFixed(1) + ':1'
		row.ratio.setAttribute('data-tone', ratio !== null && ratio < 4.5 ? 'warn' : 'ok')
	}

	/** 建一行区域控件。 */
	function buildRow(region) {
		var row = { regionKey: region.key }

		row.colorInput = el('input', { type: 'color', class: 'color', 'aria-label': region.label + ' 颜色' })
		row.hexInput = el('input', { type: 'text', class: 'hex', spellcheck: 'false', maxlength: '7', placeholder: '跟随主题' })
		row.opacityInput = el('input', { type: 'range', class: 'opacity', min: '0', max: '100', step: '1', 'aria-label': region.label + ' 不透明度' })
		row.pct = el('span', { class: 'pct' })
		row.followBtn = el('button', { type: 'button', class: 'follow', text: '跟随主题', title: '清除该区域的覆盖，回到官方主题原样' })
		row.copyBtn = el('button', { type: 'button', class: 'mini', text: '复制', title: '复制该区域的颜色值' })
		row.applyBtn = el('button', { type: 'button', class: 'mini', text: '统一', title: '把该区域的颜色与不透明度应用到全部区域' })
		row.ratio = el('span', { class: 'ratio', title: '与官方该主题下文字色的对比度（WCAG，正文需 ≥ 4.5:1）' })

		row.colorInput.addEventListener('input', function () {
			entryOf(row.regionKey).color = row.colorInput.value.toLowerCase()
			row.hexInput.value = entryOf(row.regionKey).color
			syncRow(row)
			refreshRecommendedText()
			syncTune()
			scheduleSave()
		})
		row.hexInput.addEventListener('change', function () {
			var hex = normalizeHex(row.hexInput.value)
			if (hex === null) {
				syncRow(row)
				return
			}
			entryOf(row.regionKey).color = hex
			syncRow(row)
			refreshRecommendedText()
			syncTune()
			scheduleSave()
		})
		row.opacityInput.addEventListener('input', function () {
			entryOf(row.regionKey).opacity = Number(row.opacityInput.value)
			syncRow(row)
			scheduleSave()
		})
		row.followBtn.addEventListener('click', function () {
			var entry = entryOf(row.regionKey)
			entry.color = ''
			entry.opacity = 100
			syncRow(row)
			refreshRecommendedText()
			syncTune()
			scheduleSave()
		})
		row.copyBtn.addEventListener('click', function () {
			var entry = entryOf(row.regionKey)
			if (entry.color === '') return
			copyText(entry.color, row.hexInput).then(function (ok) {
				setStatus(ok ? '已复制 ' + entry.color : '复制失败，请手动选中颜色值复制', ok ? 'ok' : 'error')
			})
		})
		row.applyBtn.addEventListener('click', function () {
			var entry = entryOf(row.regionKey)
			if (entry.color === '') return
			applyToAll(row.regionKey, entry.color, entry.opacity)
		})

		row.root = el('div', { class: 'row' }, [
			el('div', { class: 'rowHead' }, [
				el('span', { class: 'label', text: region.label }),
				row.copyBtn,
				row.applyBtn,
				row.followBtn,
			]),
			el('div', { class: 'hint', text: region.hint || '' }),
			el('div', { class: 'controls' }, [row.colorInput, row.hexInput, row.opacityInput, row.pct, row.ratio]),
		])
		syncRow(row)
		return row
	}

	/** 读取当前编辑模式下三个区域的色值。 */
	function currentColors(modeKey) {
		var out = {}
		REGION_KEYS.forEach(function (key) {
			var group = state.config === null ? null : state.config.regions[key]
			var entry = group === null || group === undefined ? null : group[modeKey]
			out[key] = entry === null || entry === undefined || typeof entry.color !== 'string' ? '' : entry.color
		})
		return out
	}

	/** 同步文字色那一块：两个开关、预设、色域图、两个滑杆、三个层级行。 */
	function syncTextRow() {
		if (tune.textRecommended === null || state.config === null) return
		var current = textMode()
		tune.textRecommended.checked = current === 'recommended'
		tune.textCustom.checked = current === 'custom'
		var custom = current === 'custom'
		var active = current !== 'off'
		// 自定义专属控件只在自定义状态下展开；推荐状态下三行只读展示推导结果。
		tune.textCustomBox.style.display = custom ? 'flex' : 'none'
		tune.roleRows.root.style.display = active ? 'flex' : 'none'

		var stored = storedTextColors(mode)
		var surfacesMap = textSurfaces(mode)

		// 预设按钮：色块分别显示该预设的浅色面 / 深色面主文字色。
		tune.textPresets.textContent = ''
		TEXT_PRESETS.forEach(function (preset) {
			var lightColor = preset.derived === true ? tintedPreview('light') : preset.light[0]
			var darkColor = preset.derived === true ? tintedPreview('dark') : preset.dark[0]
			var button = el('button', { type: 'button', class: 'preset', title: preset.note })
			button.appendChild(el('span', { class: 'presetChips' }, [chipFor(lightColor), chipFor(darkColor)]))
			button.appendChild(el('span', { text: preset.name }))
			button.addEventListener('click', function () {
				if (!applyTextPreset(preset)) return
				syncTextTune()
				syncTextRow()
				renderRows()
				scheduleSave()
				setStatus('已套用文字色「' + preset.name + '」', 'ok')
			})
			tune.textPresets.appendChild(button)
		})

		// 三个层级行：自定义时可编辑，推荐 / 关闭时只读显示当前生效值。
		for (var i = 0; i < TEXT_ROLES.length; i += 1) {
			var role = TEXT_ROLES[i]
			var row = tune.roleRows[role]
			var color = stored[role]
			var showing = color !== '' ? color : ''
			row.root.setAttribute('data-following', color === '' ? 'yes' : 'no')
			row.colorInput.value = color === '' ? '#888888' : color
			row.colorInput.disabled = !custom
			row.hexInput.value = showing
			row.hexInput.disabled = !custom || color === ''
			row.follow.disabled = !custom
			var worst = null
			if (active && color !== '') {
				worst = Number.POSITIVE_INFINITY
				for (var k = 0; k < REGION_KEYS.length; k += 1) {
					var ratio = contrastRatio(color, surfacesMap[REGION_KEYS[k]])
					if (ratio !== null) worst = Math.min(worst, ratio)
				}
				if (!Number.isFinite(worst)) worst = null
			}
			row.ratio.textContent = worst === null ? '' : worst.toFixed(1) + ':1'
			row.ratio.setAttribute('data-tone', worst !== null && worst < TEXT_TARGETS[role] ? 'warn' : 'ok')
		}
	}

	/** 预设按钮上的小色块；“同色相”没有静态取值时画虚线框。 */
	function chipFor(color) {
		var chip = el('span', { class: 'presetChip', title: color === '' ? '按当前方案推导' : color })
		if (color === '') chip.style.borderStyle = 'dashed'
		else chip.style.background = color
		return chip
	}

	/** 「同色相 / 推荐色」的预览色：按该模式当前表面推导。 */
	function tintedPreview(modeKey) {
		var derived = deriveTintedTextColors(modeKey)
		return derived === null ? '' : derived.primary
	}

	/** 建一行文字色控件（三个层级各一行，构建一次后只改值）。 */
	function buildTextRoleRow(role) {
		var colorInput = el('input', { type: 'color', class: 'color', 'aria-label': TEXT_ROLE_LABELS[role] + '颜色' })
		var hexInput = el('input', { type: 'text', class: 'hex', spellcheck: 'false', maxlength: '7', placeholder: '跟随主题' })
		var ratio = el('span', {
			class: 'ratio',
			title: TEXT_ROLE_LABELS[role] + '对三个区域表面的最差对比度（目标 ' + TEXT_TARGETS[role] + ':1）',
		})
		var follow = el('button', { type: 'button', class: 'mini', text: '跟随', title: '该层级回到官方主题文字色' })

		function write(color) {
			var text = ensureTextSection()
			if (text === null) return
			text[mode][role] = { color: color, opacity: 100 }
			if (color !== '') text.mode = 'custom'
			writeTextMirror(text)
			syncTextTune()
			syncTextRow()
			renderRows()
			scheduleSave()
		}

		colorInput.addEventListener('input', function () {
			write(colorInput.value.toLowerCase())
		})
		hexInput.addEventListener('change', function () {
			var hex = normalizeHex(hexInput.value)
			if (hex === null) {
				syncTextRow()
				return
			}
			write(hex)
		})
		follow.addEventListener('click', function () {
			write('')
		})

		return {
			root: el('div', { class: 'textRow' }, [
				el('span', { class: 'textLabel', text: TEXT_ROLE_LABELS[role] }),
				colorInput,
				hexInput,
				ratio,
				follow,
			]),
			colorInput: colorInput,
			hexInput: hexInput,
			ratio: ratio,
			follow: follow,
		}
	}

	/** 用当前配色重设微调基准与滑杆位置（打开面板、切页签、套用方案、手工改色后调用）。 */
	function syncTune() {
		if (state.config === null || tune.depth === null) return
		syncTextTune()
		syncTextRow()
		var colors = currentColors(mode)
		tuneBase[mode] = colors
		var lch = hexToOklch(colors.conversation)
		if (lch === null) {
			tune.depth.value = '0'
			tune.vividness.value = '0'
			tune.depthValue.textContent = '—'
			tune.vividnessValue.textContent = '—'
		} else {
			var depth = lightnessToDepth(mode, lch.L)
			var vividness = chromaToVividness(lch.L, lch.H, lch.C)
			tune.depth.value = String(depth)
			tune.vividness.value = String(vividness)
			tune.depthValue.textContent = depth + '　越深越' + (mode === 'dark' ? '黑' : '暗')
			tune.vividnessValue.textContent = vividness + '　C ' + lch.C.toFixed(3)
		}
		updateTuneContrast()
	}

	/** 拖动滑杆：按基准重算三个区域，写入当前编辑的那一套并即时生效。 */
	function applyTune() {
		if (state.config === null || tuneBase[mode] === null) return
		var derived = deriveScheme(tuneBase[mode], mode, Number(tune.depth.value), Number(tune.vividness.value))
		if (derived === null) return
		REGION_KEYS.forEach(function (key) {
			var group = state.config.regions[key]
			if (!group || !group[mode]) return
			group[mode].color = derived.colors[key]
			group[mode].opacity = 100
		})
		tuneClamped = derived.clamped
		refreshRecommendedText()
		renderRows()
		var lch = hexToOklch(derived.colors.conversation)
		tune.depthValue.textContent = tune.depth.value + '　越深越' + (mode === 'dark' ? '黑' : '暗')
		tune.vividnessValue.textContent = tune.vividness.value + '　C ' + (lch === null ? '—' : lch.C.toFixed(3))
		renderRows()
		updateTuneContrast()
		scheduleSave()
	}

	/** 对比度读数：各区域与对应主题文字色的 WCAG 比值（低于 4.5:1 会标红提示）。 */
	function updateTuneContrast() {
		if (tune.contrast === null || state.config === null) return
		var text = effectiveTextColor(mode)
		var parts = []
		var worst = Number.POSITIVE_INFINITY
		FALLBACK_REGIONS.forEach(function (region) {
			var group = state.config.regions[region.key]
			var entry = group === undefined || group === null ? null : group[mode]
			var color = entry === null || entry === undefined ? '' : entry.color
			var ratio = color === '' ? null : contrastRatio(text, color)
			if (ratio !== null) worst = Math.min(worst, ratio)
			parts.push(region.label + ' ' + (ratio === null ? '跟随主题' : ratio.toFixed(1) + ':1'))
		})
		var low = worst < 4.5
		tune.contrast.textContent =
			'对比度 ' +
			parts.join(' · ') +
			(low ? '　低于 4.5:1，文字会难读' : tuneClamped ? '　已到可读性下限' : '') +
			(surfacesPolarityMixed(mode) ? '　各区域明暗相反，单一文字色无法都看清' : '')
		tune.contrast.setAttribute('data-tone', low ? 'warn' : 'ok')
	}

	/** 把某个区域的颜色与不透明度套用到当前模式的全部区域。 */
	function applyToAll(sourceKey, color, opacity) {
		if (state.config === null) return
		var changed = 0
		REGION_KEYS.forEach(function (key) {
			var group = state.config.regions[key]
			if (!group || !group[mode]) return
			group[mode].color = color
			group[mode].opacity = opacity
			changed += 1
		})
		refreshRecommendedText()
		syncTune()
		renderRows()
		scheduleSave()
		setStatus('已把 ' + color + ' 应用到 ' + changed + ' 个区域', 'ok')
	}

	/**
	 * 套用一套方案：日间方案只写浅色那套，夜间方案只写深色那套。
	 * 实际哪套生效由官方主题决定（官方浅色时看到的就是日间方案）。
	 */
	function applyPreset(preset, modeKey) {
		if (state.config === null) return
		var values = presetValues(preset)
		REGION_KEYS.forEach(function (key) {
			var group = state.config.regions[key]
			if (!group || !group[modeKey]) return
			group[modeKey].color = values[key]
			group[modeKey].opacity = 100
		})
		// 顺手把编辑页签切到刚写入的那一套，否则在当前页签下看着"没变化"。
		mode = modeKey
		refreshRecommendedText()
		syncTune()
		renderRows()
		scheduleSave()
		setStatus('已应用' + (modeKey === 'dark' ? '夜间' : '日间') + '方案「' + preset.name + '」', 'ok')
	}

	/** 官方主题（浅色 / 深色）实际生效的那一套。 */
	function officialMode() {
		return activeMode()
	}

	/** 官方主题切换接口的可用性：宿主侧那条路由要重启过 dsh web 才存在。 */
	var themeRoute = { probed: false, available: false }

	/** 探测官方主题接口；打不开就说明宿主还没重启。 */
	function probeThemeRoute() {
		return fetch(BASE + '/theme.json', { cache: 'no-store' }).then(
			function (response) {
				themeRoute = { probed: true, available: response.ok }
				if (!response.ok) return false
				return response
					.json()
					.then(function () {
						return true
					})
					.catch(function () {
						return true
					})
			},
			function () {
				themeRoute = { probed: true, available: false }
				return false
			},
		)
	}

	/** 路由不存在时的几种表现：兜底静态服务对非 GET 回 405，未注册则 404。 */
	function themeRouteMissing(status) {
		return status === 401 || status === 404 || status === 405 || status === 501 || status === 503
	}

	/** 请求宿主改写官方主题偏好；接口不存在时就地说明原因。 */
	function switchOfficialTheme(preference) {
		fetch(BASE + '/theme.json', {
			method: 'PUT',
			headers: { 'Content-Type': 'application/json', 'x-dsh-theme-colors': '1' },
			body: JSON.stringify({ preference: preference }),
		}).then(
			function (response) {
				if (response.ok) {
					setStatus('已切换到官方' + (preference === 'dark' ? '深色' : '浅色') + '主题', 'ok')
					return
				}
				if (themeRouteMissing(response.status)) {
					themeRoute = { probed: true, available: false }
					renderThemeRow()
					setStatus('面板内切主题需要重启一次 dsh web；现在可到 设置 → 通用 → 主题 切换', 'error')
					return
				}
				response
					.json()
					.catch(function () {
						return {}
					})
					.then(function (payload) {
						setStatus('切换失败：' + String((payload && payload.error) || response.status), 'error')
					})
			},
			function (error) {
				setStatus('切换失败：' + String((error && error.message) || error), 'error')
			},
		)
	}

	/**
	 * 顶部一行：当前官方主题是浅色还是深色，并提供一键切换到另一边。
	 * 接口不存在时（宿主未重启）不给按钮，直接写明原因与替代做法。
	 */
	function renderThemeRow() {
		if (themeRow === null) return
		themeRow.textContent = ''
		var current = officialMode()
		var text = el('div', { class: 'themeText' }, [
			el('div', { text: '官方主题：' + (current === 'dark' ? '深色（夜间方案生效）' : '浅色（日间方案生效）') }),
		])
		if (themeRoute.probed && !themeRoute.available) {
			text.appendChild(
				el('div', { class: 'themeHint', text: '面板内切换需重启一次 dsh web；现在请到 设置 → 通用 → 主题 切换' }),
			)
			themeRow.appendChild(text)
			return
		}
		var target = current === 'dark' ? 'light' : 'dark'
		var button = el('button', { type: 'button', class: 'mini', text: '切到' + (target === 'dark' ? '深色' : '浅色') })
		button.addEventListener('click', function () {
			switchOfficialTheme(target)
		})
		themeRow.appendChild(text)
		themeRow.appendChild(button)
	}

	/** 按当前模式重建所有行与预设条。 */
	function renderRows() {
		if (rowsWrap === null || state.config === null) return
		rowsWrap.textContent = ''
		FALLBACK_REGIONS.forEach(function (region) {
			if (!state.config.regions[region.key]) return
			rowsWrap.appendChild(buildRow(region).root)
		})
		renderPresets()
		renderThemeRow()
		if (tabEls) {
			tabEls.forEach(function (tab) {
				tab.setAttribute('aria-pressed', tab.getAttribute('data-mode') === mode ? 'true' : 'false')
			})
		}
		pathEl.textContent = '配置文件：' + (state.configFile || '')
		if (launcherToggle !== null) launcherToggle.checked = launcherWanted
	}

	/** 预设条：日间方案与夜间方案各一组，色块显示各自那套的颜色。 */
	function renderPresets() {
		if (presetWrap === null) return
		presetWrap.textContent = ''
		appendPresetGroup('日间方案 · 浅色主题', 'light', DAY_PRESETS, officialMode() === 'light')
		appendPresetGroup('夜间方案 · 深色主题', 'dark', NIGHT_PRESETS, officialMode() === 'dark')
	}

	/** 渲染一组预设：标题 + 一排按钮；`live` 表示这套正在官方主题下生效。 */
	function appendPresetGroup(title, modeKey, presets, live) {
		presetWrap.appendChild(
			el('div', { class: 'presetGroupTitle', text: title + (live ? ' · 当前生效' : '') }),
		)
		var list = el('div', { class: 'presetList' })
		presets.forEach(function (preset) {
			var values = presetValues(preset)
			var button = el('button', { type: 'button', class: 'preset', title: preset.note })
			button.appendChild(
				el('span', { class: 'presetChips' }, [
					el('span', { class: 'presetChip', style: { background: values.conversation } }),
					el('span', { class: 'presetChip', style: { background: values.sidebar } }),
				]),
			)
			button.appendChild(el('span', { text: preset.name }))
			button.addEventListener('click', function () {
				applyPreset(preset, modeKey)
			})
			list.appendChild(button)
		})
		presetWrap.appendChild(list)
	}

	function buildPanel() {
		var style = el('style')
		style.textContent = [
			':host{all:initial}',
			'.wrap{position:fixed;top:56px;right:16px;width:368px;max-height:calc(100vh - 96px);overflow:auto;',
			'box-sizing:border-box;display:flex;flex-direction:column;gap:10px;padding:14px 14px 12px;',
			'background:var(--dsw-alias-bg-layer-2,#fff);color:var(--dsw-alias-label-primary,#111);',
			'border:.5px solid var(--dsw-alias-border-l3,rgba(0,0,0,.15));border-radius:var(--dsw-radius-lg,12px);',
			'box-shadow:var(--dsw-elevation-prominent,0 8px 32px rgba(0,0,0,.18));',
			'font-family:var(--dsw-font-family,-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif);',
			'font-size:13px;line-height:20px;z-index:2147483000}',
			'.head{display:flex;align-items:center;gap:8px}',
			'.title{flex:1;font-size:14px;line-height:22px}',
			'.close{border:none;background:transparent;color:var(--dsw-alias-label-secondary,#666);cursor:pointer;',
			'font:inherit;font-size:16px;line-height:1;padding:4px 6px;border-radius:var(--dsw-radius-sm,6px)}',
			'.close:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06))}',
			'.tabs{display:flex;gap:4px;padding:2px;border-radius:var(--dsw-radius-md,8px);background:var(--dsw-alias-bg-module-platform,rgba(0,0,0,.04))}',
			'.tab{flex:1;border:none;background:transparent;color:var(--dsw-alias-label-secondary,#666);cursor:pointer;font:inherit;padding:5px 8px;border-radius:var(--dsw-radius-sm,6px)}',
			'.tab[aria-pressed="true"]{background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#111);box-shadow:var(--dsw-elevation-soft,0 1px 2px rgba(0,0,0,.12))}',
			'.row{display:flex;flex-direction:column;gap:6px;padding:10px 0;border-bottom:.5px solid var(--dsw-alias-border-l2,rgba(0,0,0,.08))}',
			'.row:last-child{border-bottom:none}',
			'.rowHead{display:flex;align-items:center;gap:8px}',
			'.label{flex:1;font-size:13px;color:var(--dsw-alias-label-primary,#111)}',
			'.follow{border:none;background:transparent;color:var(--dsw-alias-state-business-primary,#4176e6);cursor:pointer;font:inherit;font-size:12px;padding:2px 4px;border-radius:var(--dsw-radius-xs,4px)}',
			'.follow:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06))}',
			'.mini{border:none;background:transparent;color:var(--dsw-alias-label-secondary,#666);cursor:pointer;font:inherit;font-size:12px;padding:2px 4px;border-radius:var(--dsw-radius-xs,4px)}',
			'.mini:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06))}',
			'.mini:disabled{opacity:.45;cursor:default}',
			'.presets{display:flex;flex-direction:column;gap:6px}',
			'.presetGroupTitle{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary,#666);margin-top:2px}',
			'.themeRow{display:flex;align-items:center;gap:8px;padding:2px 0}',
			'.themeText{flex:1;display:flex;flex-direction:column;gap:2px;min-width:0}',
			'.themeText>div{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary,#666)}',
			'.themeHint{color:var(--dsw-alias-state-warning-primary,#b7791f)!important}',
			'.tune{display:flex;flex-direction:column;gap:6px;padding:8px 0;border-top:.5px solid var(--dsw-alias-border-l2,rgba(0,0,0,.08));border-bottom:.5px solid var(--dsw-alias-border-l2,rgba(0,0,0,.08))}',
			'.tuneRow{display:flex;align-items:center;gap:8px}',
			'.tuneLabel{width:48px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary,#666)}',
			'.tuneRange{flex:1;min-width:80px;accent-color:var(--dsw-alias-state-business-primary,#4176e6)}',
			'.tuneValue{width:104px;text-align:right;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary,#888);font-variant-numeric:tabular-nums}',
			'.tuneContrast{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary,#888)}',
			'.tuneContrast[data-tone="ok"]{color:var(--dsw-alias-state-success-primary,#2f855a)}',
			'.tuneContrast[data-tone="warn"]{color:var(--dsw-alias-state-warning-primary,#b7791f)}',
			'.tuneFoot{display:flex;align-items:center;gap:8px}',
			'.textRows{display:flex;flex-direction:column;gap:4px}',
			'.textCustom{display:flex;flex-direction:column;gap:6px}',
			'.gamutField{position:relative;height:54px;border-radius:var(--dsw-radius-md,8px);border:.5px solid var(--dsw-alias-border-l4,rgba(0,0,0,.2));cursor:crosshair;touch-action:none}',
			'.gamutCursor{position:absolute;width:12px;height:12px;margin:-6px 0 0 -6px;border-radius:50%;border:2px solid #fff;box-shadow:0 0 0 1px rgba(0,0,0,.55);pointer-events:none}',
			'.textRow{display:flex;align-items:center;gap:6px}',
			'.textLabel{width:52px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary,#666)}',
			'.textRow[data-following="yes"] .textLabel{color:var(--dsw-alias-label-tertiary,#888)}',
			'.ratio{width:46px;text-align:right;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary,#888);font-variant-numeric:tabular-nums}',
			'.ratio[data-tone="warn"]{color:var(--dsw-alias-state-warning-primary,#b7791f)}',
			'.presetList{display:flex;flex-wrap:wrap;gap:6px}',
			'.preset{display:inline-flex;align-items:center;gap:6px;box-sizing:border-box;border:.5px solid var(--dsw-alias-border-l3,rgba(0,0,0,.14));',
			'border-radius:var(--dsw-radius-md,8px);background:transparent;color:var(--dsw-alias-label-primary,#111);cursor:pointer;font:inherit;font-size:12px;line-height:18px;padding:4px 8px}',
			'.preset:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06))}',
			'.presetChips{display:inline-flex;gap:2px}',
			'.presetChip{width:10px;height:10px;border-radius:2px;border:.5px solid var(--dsw-alias-border-l4,rgba(0,0,0,.2))}',
			'.hint{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary,#888)}',
			'.controls{display:flex;align-items:center;gap:8px}',
			'.color{width:34px;height:28px;padding:0;border:.5px solid var(--dsw-alias-border-l4,rgba(0,0,0,.2));border-radius:var(--dsw-radius-sm,6px);background:transparent;cursor:pointer}',
			'.hex{width:84px;box-sizing:border-box;padding:4px 6px;font:inherit;font-size:12px;border-radius:var(--dsw-radius-sm,6px);',
			'border:.5px solid var(--dsw-alias-border-l4,rgba(0,0,0,.2));background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary,#111)}',
			'.hex:disabled{opacity:.55}',
			'.opacity{flex:1;min-width:60px;accent-color:var(--dsw-alias-state-business-primary,#4176e6)}',
			'.pct{width:44px;text-align:right;font-variant-numeric:tabular-nums;font-size:12px;color:var(--dsw-alias-label-secondary,#666)}',
			'.warn{display:none;font-size:12px;line-height:18px;color:var(--dsw-alias-state-warning-primary,#b7791f)}',
			'.row[data-following="yes"] .label{color:var(--dsw-alias-label-secondary,#666)}',
			'.foot{display:flex;align-items:center;gap:8px}',
			'.reset{border:.5px solid var(--dsw-alias-border-l4,rgba(0,0,0,.2));background:transparent;color:var(--dsw-alias-label-primary,#111);',
			'cursor:pointer;font:inherit;font-size:12px;padding:5px 10px;border-radius:var(--dsw-radius-md,8px)}',
			'.reset:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06))}',
			'.status{flex:1;text-align:right;font-size:12px;color:var(--dsw-alias-label-tertiary,#888)}',
			'.status[data-tone="ok"]{color:var(--dsw-alias-state-success-primary,#2f855a)}',
			'.status[data-tone="error"]{color:var(--dsw-alias-state-error-primary,#c53030)}',
			'.path{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary,#888);word-break:break-all}',
			'.note{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary,#888)}',
			'.foot2{display:flex;align-items:center;gap:8px;padding-top:2px}',
			'.inline{display:inline-flex;align-items:center;gap:6px;flex:1;font-size:12px;color:var(--dsw-alias-label-secondary,#666);cursor:pointer}',
			'.check{margin:0;accent-color:var(--dsw-alias-state-business-primary,#4176e6)}',
		].join('')

		tabEls = [
			el('button', { type: 'button', class: 'tab', 'data-mode': 'light', text: '编辑：浅色（日间）' }),
			el('button', { type: 'button', class: 'tab', 'data-mode': 'dark', text: '编辑：深色（夜间）' }),
		]
		tabEls.forEach(function (tab) {
			tab.addEventListener('click', function () {
				mode = tab.getAttribute('data-mode')
				syncTune()
				renderRows()
			})
		})

		statusEl = el('span', { class: 'status' })
		pathEl = el('div', { class: 'path' })
		rowsWrap = el('div', { class: 'rows' })
		presetWrap = el('div', { class: 'presets' })
		themeRow = el('div', { class: 'themeRow' })

		// 微调：深度（OKLCH 明度）与鲜亮度（OKLCH 彩度），按当前模式的那套取值重算。
		tune.depth = el('input', { type: 'range', class: 'tuneRange', min: '0', max: '100', step: '1', 'aria-label': '配色深度' })
		tune.vividness = el('input', { type: 'range', class: 'tuneRange', min: '0', max: '100', step: '1', 'aria-label': '配色鲜亮度' })
		tune.depthValue = el('span', { class: 'tuneValue' })
		tune.vividnessValue = el('span', { class: 'tuneValue' })
		tune.contrast = el('div', { class: 'tuneContrast' })
		tune.depth.addEventListener('input', applyTune)
		tune.vividness.addEventListener('input', applyTune)

		// 文字色：默认关闭。「推荐色」按方案推导并跟随方案变化；「自定义」给预设 / 色域图 / 滑杆 / 逐档手填。
		tune.textRecommended = el('input', { type: 'checkbox', class: 'check', 'aria-label': '推荐色（按方案推导）' })
		tune.textCustom = el('input', { type: 'checkbox', class: 'check', 'aria-label': '自定义文字色' })
		tune.textPresets = el('div', { class: 'presetList' })
		tune.textRows = el('div', { class: 'textRows' })
		tune.roleRows = { root: tune.textRows }
		for (var roleIndex = 0; roleIndex < TEXT_ROLES.length; roleIndex += 1) {
			var roleRow = buildTextRoleRow(TEXT_ROLES[roleIndex])
			tune.roleRows[TEXT_ROLES[roleIndex]] = roleRow
			tune.textRows.appendChild(roleRow.root)
		}
		tune.textClear = el('button', { type: 'button', class: 'mini', text: '跟随主题', title: '清除文字色覆盖，回到官方主题' })

		function toggleTextMode(next, checkbox) {
			var other = next === 'recommended' ? tune.textCustom : tune.textRecommended
			if (checkbox.checked === true) other.checked = false
			if (!setTextMode(checkbox.checked === true ? next : 'off')) return
			syncTextTune()
			syncTextRow()
			renderRows()
			scheduleSave()
			setStatus(
				checkbox.checked === true
					? next === 'recommended'
						? '文字色：按当前方案推荐'
						: '文字色：自定义'
					: '文字色：跟随官方主题',
				'ok',
			)
		}
		tune.textRecommended.addEventListener('change', function () {
			toggleTextMode('recommended', tune.textRecommended)
		})
		tune.textCustom.addEventListener('change', function () {
			toggleTextMode('custom', tune.textCustom)
		})
		tune.textClear.addEventListener('click', function () {
			clearTextColors()
			syncTextTune()
			syncTextRow()
			renderRows()
			scheduleSave()
			setStatus('文字色已回到官方主题', 'ok')
		})

		// 色域图：横轴色相、纵轴明度，按当前彩度实时渲染可达颜色；点 / 拖即取色。
		tune.gamutField = el('div', { class: 'gamutField', 'aria-label': '自由色域图' })
		tune.gamutCursor = el('div', { class: 'gamutCursor' })
		tune.gamutField.appendChild(tune.gamutCursor)
		tune.gamutHint = el('div', { class: 'note' })
		tune.gamutField.addEventListener('pointerdown', function (event) {
			pickFromGamut(event)
			if (typeof tune.gamutField.setPointerCapture === 'function') {
				try {
					tune.gamutField.setPointerCapture(event.pointerId)
				} catch (error) {
					/* 捕获不可用时忽略 */
				}
			}
		})
		tune.gamutField.addEventListener('pointermove', function (event) {
			if (event.buttons === undefined || event.buttons === 0) return
			pickFromGamut(event)
		})

		tune.textDepth = el('input', { type: 'range', class: 'tuneRange', min: '0', max: '100', step: '1', 'aria-label': '文字深度' })
		tune.textVivid = el('input', { type: 'range', class: 'tuneRange', min: '0', max: '100', step: '1', 'aria-label': '文字鲜亮度' })
		tune.textDepthValue = el('span', { class: 'tuneValue' })
		tune.textVividValue = el('span', { class: 'tuneValue' })
		tune.textDepth.addEventListener('input', applyTextTune)
		tune.textVivid.addEventListener('input', applyTextTune)
		tune.textCustomBox = el('div', { class: 'textCustom' }, [
			tune.textPresets,
			tune.gamutField,
			tune.gamutHint,
			el('div', { class: 'tuneRow' }, [
				el('span', { class: 'tuneLabel', text: '文字深度', title: 'OKLCH 明度：沿"远离表面"的方向加深' }),
				tune.textDepth,
				tune.textDepthValue,
			]),
			el('div', { class: 'tuneRow' }, [
				el('span', { class: 'tuneLabel', text: '文字鲜亮度', title: 'OKLCH 彩度：越大文字越有色，色相与色域图一致' }),
				tune.textVivid,
				tune.textVividValue,
			]),
		])
		var tuneReset = el('button', { type: 'button', class: 'mini', text: '还原方案原值' })
		tuneReset.addEventListener('click', function () {
			if (tuneBase[mode] === null) return
			REGION_KEYS.forEach(function (key) {
				var group = state.config.regions[key]
				if (!group || !group[mode]) return
				group[mode].color = tuneBase[mode][key]
				group[mode].opacity = 100
			})
			syncTune()
			renderRows()
			scheduleSave()
		})

		var resetBtn = el('button', { type: 'button', class: 'reset', text: '全部重置' })
		resetBtn.addEventListener('click', function () {
			if (state.defaults === null) return
			state.config = JSON.parse(JSON.stringify(state.defaults))
			syncTune()
			renderRows()
			scheduleSave()
		})

		// 悬浮入口：显示开关 + 位置归位。两个控件都写进同一份配置。
		launcherToggle = el('input', { type: 'checkbox', class: 'check', 'aria-label': '显示悬浮入口按钮' })
		launcherToggle.addEventListener('change', function () {
			state.config.launcher = launcherToggle.checked === true
			launcherWanted = state.config.launcher
			syncLauncher()
			scheduleSave()
		})
		var recenterBtn = el('button', { type: 'button', class: 'reset', text: '入口归位' })
		recenterBtn.addEventListener('click', function () {
			state.config.launcherSpot = null
			placeLauncher()
			scheduleSave()
		})

		panelWrap = el('div', { class: 'wrap', role: 'dialog', 'aria-label': '配色调节' }, [
			el('div', { class: 'head' }, [
				el('span', { class: 'title', text: '配色调节' }),
				el('button', { type: 'button', class: 'close', text: '✕', title: '关闭' , onclick: closePanel }),
			]),
			el('div', { class: 'tabs' }, tabEls),
			themeRow,
			presetWrap,
			el('div', { class: 'tune' }, [
				el('div', { class: 'tuneRow' }, [
					el('span', { class: 'tuneLabel', text: '深度', title: 'OKLCH 明度：越大底色越暗' }),
					tune.depth,
					tune.depthValue,
				]),
				el('div', { class: 'tuneRow' }, [
					el('span', { class: 'tuneLabel', text: '鲜亮度', title: 'OKLCH 彩度：越大颜色越鲜明，色相不变' }),
					tune.vividness,
					tune.vividnessValue,
				]),
				el('div', { class: 'tuneRow' }, [
					el('label', { class: 'inline', title: '按当前方案推导文字色（同色相、按对比度目标定明度），随方案变化自动更新' }, [
						tune.textRecommended,
						el('span', { text: '推荐色' }),
					]),
					el('label', { class: 'inline', title: '自己指定文字色：预设 / 色域图 / 文字深度与鲜亮度 / 逐档手填' }, [
						tune.textCustom,
						el('span', { text: '自定义' }),
					]),
					tune.textClear,
				]),
				tune.textCustomBox,
				tune.textRows,
				tune.contrast,
				el('div', { class: 'tuneFoot' }, [tuneReset]),
			]),
			rowsWrap,
			el('div', { class: 'foot' }, [resetBtn, statusEl]),
			el('div', { class: 'foot2' }, [
				el('label', { class: 'inline' }, [launcherToggle, el('span', { text: '显示悬浮入口（可拖动）' })]),
				recenterBtn,
			]),
			pathEl,
		])

		return [style, panelWrap]
	}

	function ensureHost() {
		if (shadow !== null) return
		host = el('div', { id: 'dsh-theme-colors-host' })
		host.style.position = 'fixed'
		host.style.zIndex = '2147483000'
		shadow = host.attachShadow({ mode: 'open' })
		buildPanel().forEach(function (node) {
			shadow.appendChild(node)
		})
		panelWrap.style.display = 'none'
		document.body.appendChild(host)
	}

	function onDocumentKeydown(event) {
		if (event.key === 'Escape') closePanel()
	}

	function onDocumentPointerDown(event) {
		if (panelWrap === null || panelWrap.style.display === 'none') return
		var path = event.composedPath ? event.composedPath() : []
		if (path.indexOf(panelWrap) !== -1 || path.indexOf(host) !== -1) return
		if (launcher !== null && path.indexOf(launcher) !== -1) return
		closePanel()
	}

	async function openPanel() {
		if (opening) return
		opening = true
		try {
			ensureHost()
			panelWrap.style.display = 'flex'
			document.addEventListener('keydown', onDocumentKeydown, true)
			document.addEventListener('pointerdown', onDocumentPointerDown, true)
			if (saveTimer === null) {
				try {
					await fetchConfig()
				} catch (error) {
					setStatus('读取失败：' + String((error && error.message) || error), 'error')
				}
			}
			// 官方主题接口是否可用，决定顶部那一行给不给切换按钮。
			await probeThemeRoute()
			mode = activeMode()
			syncTune()
			renderRows()
			if (statusEl.textContent === '') setStatus('已同步', 'muted')
		} finally {
			opening = false
		}
	}

	function closePanel() {
		if (panelWrap === null) return
		panelWrap.style.display = 'none'
		document.removeEventListener('keydown', onDocumentKeydown, true)
		document.removeEventListener('pointerdown', onDocumentPointerDown, true)
	}

	function togglePanel() {
		ensureHost()
		if (panelWrap.style.display === 'none') openPanel()
		else closePanel()
	}

	/** 判定“是拖动而不是点击”的位移阈值（像素）。 */
	var POINTER_MOVE_TOLERANCE = 4

	/** 左侧会话列表栏的右边界；取不到时返回 null。 */
	function sidebarRight() {
		try {
			var node = document.querySelector('[class*="sidebarCol"]')
			if (node !== null && typeof node.getBoundingClientRect === 'function') {
				var rect = node.getBoundingClientRect()
				if (rect && rect.right > 0) return rect.right
			}
		} catch (error) {
			/* 布局未就绪或选择器不可用时走默认位置 */
		}
		return null
	}

	/**
	 * 摆放悬浮入口：拖过的按保存的比例定位；没拖过就贴在侧边栏右侧、会话区左下角，
	 * 这样不会压住左侧边栏底部的「设置」等控件。
	 */
	function placeLauncher() {
		if (launcher === null) return
		var width = window.innerWidth || 0
		var height = window.innerHeight || 0
		var spot = state.config === null ? null : state.config.launcherSpot
		if (spot !== null && spot !== undefined) {
			// 存的是按钮中心的比例，这里按按钮实测尺寸还原左上角。
			var halfWidth = (launcher.offsetWidth || 80) / 2
			var halfHeight = (launcher.offsetHeight || 28) / 2
			var left = Math.min(Math.max(spot.x * width - halfWidth, 0), Math.max(0, width - halfWidth * 2))
			var top = Math.min(Math.max(spot.y * height - halfHeight, 0), Math.max(0, height - halfHeight * 2))
			launcher.style.left = Math.round(left) + 'px'
			launcher.style.top = Math.round(top) + 'px'
			launcher.style.bottom = 'auto'
			return
		}
		var right = sidebarRight()
		launcher.style.left = (right === null ? 12 : Math.round(right + 12)) + 'px'
		launcher.style.bottom = '12px'
		launcher.style.top = 'auto'
	}

	/** 拖动悬浮入口：松手后把位置按视口比例写进配置，之后跨刷新保持。 */
	function enableLauncherDrag(button) {
		var drag = null
		var draggedRecently = false

		button.addEventListener('pointerdown', function (event) {
			if (event.button !== undefined && event.button !== 0) return
			var rect = button.getBoundingClientRect()
			drag = {
				grabX: event.clientX - rect.left,
				grabY: event.clientY - rect.top,
				startX: event.clientX,
				startY: event.clientY,
				moved: false,
			}
			button.style.cursor = 'grabbing'
			if (typeof button.setPointerCapture === 'function') {
				try {
					button.setPointerCapture(event.pointerId)
				} catch (error) {
					/* 捕获不可用时仍可拖动 */
				}
			}
		})

		button.addEventListener('pointermove', function (event) {
			if (drag === null) return
			if (!drag.moved && Math.abs(event.clientX - drag.startX) + Math.abs(event.clientY - drag.startY) < POINTER_MOVE_TOLERANCE) return
			drag.moved = true
			if (typeof event.preventDefault === 'function') event.preventDefault()
			var width = window.innerWidth || 0
			var height = window.innerHeight || 0
			var left = Math.min(Math.max(event.clientX - drag.grabX, 0), Math.max(0, width - (button.offsetWidth || 0)))
			var top = Math.min(Math.max(event.clientY - drag.grabY, 0), Math.max(0, height - (button.offsetHeight || 0)))
			button.style.left = Math.round(left) + 'px'
			button.style.top = Math.round(top) + 'px'
			button.style.bottom = 'auto'
		})

		function finish(event) {
			if (drag === null) return
			var moved = drag.moved
			drag = null
			draggedRecently = moved
			button.style.cursor = 'grab'
			if (typeof button.releasePointerCapture === 'function') {
				try {
					button.releasePointerCapture(event.pointerId)
				} catch (error) {
					/* 未捕获时忽略 */
				}
			}
			if (!moved) return
			var rect = button.getBoundingClientRect()
			var width = window.innerWidth || 1
			var height = window.innerHeight || 1
			state.config.launcherSpot = {
				x: Math.min(0.98, Math.max(0.02, (rect.left + rect.width / 2) / width)),
				y: Math.min(0.98, Math.max(0.02, (rect.top + rect.height / 2) / height)),
			}
			scheduleSave()
		}
		button.addEventListener('pointerup', finish)
		button.addEventListener('pointercancel', finish)

		button.addEventListener('click', function () {
			if (draggedRecently) {
				draggedRecently = false
				return
			}
			togglePanel()
		})
	}

	/** 悬浮入口按钮；配置里 launcher:false 时隐藏，拖动后的位置存在配置里。 */
	function syncLauncher() {
		if (!launcherWanted) {
			if (launcher !== null && launcher.parentNode !== null) launcher.parentNode.removeChild(launcher)
			return
		}
		if (launcher !== null) {
			placeLauncher()
			return
		}
		launcher = el('button', { type: 'button', title: '调节 DSH 配色：页面背景 / 会话栏 / 左右两侧栏（可拖动）', text: '🎨 配色' })
		launcher.setAttribute('aria-label', '调节 DSH 配色')
		launcher.style.cssText = [
			'position:fixed;z-index:2147482000;display:inline-flex;align-items:center;gap:4px;',
			'height:28px;padding:0 10px;border:.5px solid rgba(127,127,127,.4);border-radius:999px;corner-shape:round;',
			'background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.16));color:var(--dsw-alias-label-primary,inherit);',
			'font:inherit;font-size:12px;line-height:1;cursor:grab;opacity:.88;transition:opacity .15s ease;',
			'user-select:none;touch-action:none',
		].join('')
		launcher.addEventListener('mouseenter', function () {
			launcher.style.opacity = '1'
		})
		launcher.addEventListener('mouseleave', function () {
			launcher.style.opacity = '.88'
		})
		enableLauncherDrag(launcher)
		document.body.appendChild(launcher)
		placeLauncher()
	}

	/** 设置页的原生「配色」卡片通过事件打开同一个面板。 */
	function onOpenEvent() {
		ensureHost()
		panelWrap.style.display = 'flex'
		openPanel()
	}

	// 调试与测试用的只读入口：区域表、预设、颜色数学与兜底渲染，便于核对实现是否一致。
	try {
		window.__dshThemeColors = {
			regions: FALLBACK_REGIONS,
			regionKeys: REGION_KEYS,
			renderCss: fallbackCss,
			dayPresets: DAY_PRESETS,
			nightPresets: NIGHT_PRESETS,
			presetValues: presetValues,
			hexToOklch: hexToOklch,
			oklchToHex: oklchToHex,
			maxChroma: maxChroma,
			deriveScheme: deriveScheme,
			depthToLightness: depthToLightness,
			lightnessToDepth: lightnessToDepth,
			chromaToVividness: chromaToVividness,
			contrastRatio: contrastRatio,
			themeText: THEME_TEXT,
			deriveTintedTextColors: deriveTintedTextColors,
			deriveTintedTextColorsFor: deriveTintedTextColorsFor,
			polarityOfSurfaces: polarityOfSurfaces,
			deriveTextScheme: deriveTextScheme,
			textModes: TEXT_MODES,
			textPresets: TEXT_PRESETS,
			textTints: TEXT_TINTS,
			textRoleLabels: TEXT_ROLE_LABELS,
			textRoles: TEXT_ROLES,
			textTargets: TEXT_TARGETS,
			textTones: TEXT_TONES,
			textTokenByRole: TEXT_TOKEN_BY_ROLE,
			textDepthRange: TEXT_DEPTH_RANGE,
			themeSurfaces: THEME_SURFACES,
			textSurfaces: textSurfaces,
			textPolarity: textPolarity,
			textDepthToLightness: textDepthToLightness,
			textLightnessToDepth: textLightnessToDepth,
		}
	} catch (error) {
		/* 没有 window 时忽略 */
	}

	function poll() {
		if (document.visibilityState === 'hidden') return
		if (saveTimer !== null) return
		fetchConfig()
			.then(function () {
				// 侧边栏宽度可拖动；每次同步顺带校正自动位置。
				placeLauncher()
				// 官方主题被切换（本面板或官方设置页）时，更新"当前生效"标记与页签高亮。
				var current = officialMode()
				if (current !== lastOfficialMode) {
					lastOfficialMode = current
					if (rowsWrap !== null && state.config !== null) renderRows()
				}
			})
			.catch(function () {
				/* 轮询失败保持现状，下一轮再试 */
			})
	}

	function start() {
		// 入口按钮是否出现由接口返回的 launcher 决定，因此等第一次拉取完成再建。
		poll()
		setInterval(poll, POLL_MS)
		window.addEventListener(OPEN_EVENT, onOpenEvent)
		window.addEventListener('resize', placeLauncher)
	}

	if (document.body === null) document.addEventListener('DOMContentLoaded', start)
	else start()
})()
