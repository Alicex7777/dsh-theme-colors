/**
 * GUI 面板测试：用最小 DOM 替身执行 lib/gui.js，验证
 * 入口按钮、配色落到 <style>、面板打开与四行控件、改色后的 PUT 保存与即时生效、
 * 以及设置页卡片派发事件打开面板。
 * 运行：node scripts/test-gui.mjs
 */
import assert from 'node:assert/strict'
import { luminance, renderCss } from '../lib/palette.js'

/** 面板底部状态行的文字。 */
const statusText = (wrap) => wrap.children.find((node) => node.className === 'foot').children[1].textContent

/** 只比较规则行，忽略注释头，用于校验兜底渲染与 palette 输出一致。 */
const rulesOnly = (text) =>
	String(text)
		.split('\n')
		.map((line) => line.trim())
		.filter((line) => line !== '' && line.indexOf('/*') !== 0)
		.join('\n')

/** 深度优先收集满足条件的节点（面板在 shadow root 里，这里自己走一遍）。 */
function find(node, predicate, found = []) {
	if (node === null || node === undefined || typeof node !== 'object') return found
	if (predicate(node)) found.push(node)
	;(node.children || []).forEach((child) => find(child, predicate, found))
	return found
}

// —— 最小 DOM ——
function createNode(tag) {
	const node = {
		tagName: String(tag).toUpperCase(),
		children: [],
		attributes: {},
		dataset: {},
		style: {},
		listeners: {},
		value: '',
		disabled: false,
		textContent: '',
		id: '',
		className: '',
		parentNode: null,
		appendChild(child) {
			child.parentNode = node
			node.children.push(child)
			return child
		},
		removeChild(child) {
			const index = node.children.indexOf(child)
			if (index >= 0) node.children.splice(index, 1)
			child.parentNode = null
			return child
		},
		setAttribute(name, value) {
			node.attributes[name] = String(value)
			if (name === 'id') node.id = String(value)
			if (name === 'class') node.className = String(value)
		},
		getAttribute(name) {
			return Object.prototype.hasOwnProperty.call(node.attributes, name) ? node.attributes[name] : null
		},
		hasAttribute(name) {
			return Object.prototype.hasOwnProperty.call(node.attributes, name)
		},
		addEventListener(type, fn) {
			;(node.listeners[type] = node.listeners[type] || []).push(fn)
		},
		removeEventListener(type, fn) {
			const list = node.listeners[type]
			if (!list) return
			const index = list.indexOf(fn)
			if (index >= 0) list.splice(index, 1)
		},
		dispatch(type, event) {
			;(node.listeners[type] || []).slice().forEach((fn) => fn(event || { type }))
		},
		attachShadow() {
			const shadow = createNode('#shadow-root')
			shadow.host = node
			node.shadowRoot = shadow
			return shadow
		},
		querySelector() {
			return null
		},
		setPointerCapture() {},
		releasePointerCapture() {},
		offsetWidth: 72,
		offsetHeight: 28,
		offsetLeft: 0,
		offsetTop: 0,
		/** 位置从 style 推导，使拖动的数学与真实 DOM 一致。 */
		getBoundingClientRect() {
			const width = node.offsetWidth || 0
			const height = node.offsetHeight || 0
			const left = parseFloat(node.style.left)
			let top = parseFloat(node.style.top)
			if (!Number.isFinite(top)) {
				const bottom = parseFloat(node.style.bottom)
				top = Number.isFinite(bottom) ? (globalThis.window.innerHeight || 0) - bottom - height : 0
			}
			return { left: left || 0, top: top || 0, right: (left || 0) + width, bottom: (top || 0) + height, width, height }
		},
	}
	// 与真实 DOM 一致：textContent = '' 清空子节点；读取时聚合子节点文本。
	let text = node.textContent
	Object.defineProperty(node, 'textContent', {
		configurable: true,
		get() {
			if (text !== '') return text
			return node.children.map((child) => child.textContent).join('')
		},
		set(value) {
			text = value === null || value === undefined ? '' : String(value)
			if (text === '') node.children.length = 0
		},
	})
	return node
}

const created = []
/** 侧边栏替身：自动定位应当贴在它右侧。 */
const sidebarNode = createNode('div')
sidebarNode.offsetWidth = 264
globalThis.document = {
	head: createNode('head'),
	body: createNode('body'),
	visibilityState: 'visible',
	createElement(tag) {
		const node = createNode(tag)
		created.push(node)
		return node
	},
	getElementById(id) {
		return created.find((node) => node.id === id) || null
	},
	querySelector(selector) {
		return String(selector).indexOf('sidebarCol') === -1 ? null : sidebarNode
	},
	addEventListener() {},
	removeEventListener() {},
}
globalThis.CustomEvent = class CustomEvent {
	constructor(type, init) {
		this.type = type
		this.detail = init && init.detail
	}
}
/** 剪贴板替身（Node 的 navigator 只有 getter，必须用 defineProperty 覆盖）。 */
const copied = []
Object.defineProperty(globalThis, 'navigator', {
	configurable: true,
	value: {
		clipboard: {
			writeText(text) {
				copied.push(text)
				return Promise.resolve()
			},
		},
	},
})

const windowListeners = {}
const windowDispatched = []
globalThis.window = {
	innerWidth: 1400,
	innerHeight: 900,
	addEventListener(type, fn) {
		;(windowListeners[type] = windowListeners[type] || []).push(fn)
	},
	removeEventListener(type, fn) {
		const list = windowListeners[type]
		if (!list) return
		const index = list.indexOf(fn)
		if (index >= 0) list.splice(index, 1)
	},
	dispatchEvent(event) {
		windowDispatched.push(event)
		return true
	},
}
const realSetInterval = globalThis.setInterval
globalThis.setInterval = () => 0

// —— 接口替身 ——
// 故意多给一个 background 行：旧配置/旧宿主的残留必须被界面过滤掉。
const regions = [
	{ key: 'background', label: '页面背景', hint: '旧字段' },
	{ key: 'conversation', label: '会话栏', hint: '中列' },
	{ key: 'sidebar', label: '左侧会话列表栏', hint: '左列' },
	{ key: 'rightbar', label: '右侧栏', hint: '右列' },
]
const emptyEntry = () => ({ color: '', opacity: 100 })
let config = {
	launcher: true,
	regions: {
		background: { light: emptyEntry(), dark: emptyEntry() },
		conversation: { light: emptyEntry(), dark: emptyEntry() },
		sidebar: { light: { color: '#e8ecf3', opacity: 80 }, dark: emptyEntry() },
		rightbar: { light: emptyEntry(), dark: emptyEntry() },
	},
}
let putCount = 0
let lastPut = null
let lastThemePut = null
let themeStatus = 200
const payload = (css) => ({ ok: true, config, defaults: { launcher: true, regions: {} }, css, configFile: '/home/user/.dsh/.dsh-theme-colors.json', modes: ['light', 'dark'], regions })
globalThis.fetch = async (url, options) => {
	// 官方主题切换接口（GET 用于探测可用性，PUT 用于切换）。
	if (String(url).indexOf('/theme.json') !== -1) {
		const isPut = options !== undefined && options !== null && options.method === 'PUT'
		if (isPut) lastThemePut = JSON.parse(options.body)
		if (themeStatus !== 200) {
			return { ok: false, status: themeStatus, json: async () => ({ ok: false, error: '尚未重启' }) }
		}
		return { ok: true, status: 200, json: async () => ({ ok: true, preference: isPut ? lastThemePut.preference : 'light' }) }
	}
	if (options && options.method === 'PUT') {
		putCount += 1
		lastPut = JSON.parse(options.body)
		config = lastPut
		return { ok: true, status: 200, json: async () => payload('/* CSS-AFTER-SAVE */') }
	}
	return { ok: true, status: 200, json: async () => payload('/* CSS-FROM-SERVER */') }
}

await import('../lib/gui.js')
const tick = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms))
await tick()

// —— 1. 首帧：配色落到我们自己的 <style>，入口按钮出现 ——
const liveStyle = created.find((node) => node.id === 'dsh-theme-colors-live')
assert.ok(liveStyle, '未创建实时配色 <style>')
// 取不到 palette 模块（Node 里 import 会失败）时走本地兜底渲染，其结果必须与 palette.renderCss 完全一致。
assert.equal(
	rulesOnly(liveStyle.textContent),
	rulesOnly(renderCss(config)),
	'本地兜底渲染与 palette.renderCss 输出不一致',
)
assert.ok(liveStyle.textContent.includes('--dsw-specific-sidebar-fill:color-mix(in srgb, #e8ecf3 80%, transparent)'), '未应用已保存的侧栏配色')

const launcher = document.body.children.find((node) => node.getAttribute('aria-label') === '调节 DSH 配色')
assert.ok(launcher, '未创建调色入口按钮')
assert.equal(document.body.children.some((node) => node.id === 'dsh-theme-colors-host'), false, '面板宿主应懒创建')

// —— 1b. 自动定位：贴在侧边栏右侧，不压住左下角的「设置」 ——
assert.equal(launcher.style.left, '276px', '自动位置应贴在侧边栏（264px）右侧 12px')
assert.equal(launcher.style.bottom, '12px')
assert.equal(launcher.style.top, 'auto')

// —— 2. 打开面板：三个区域控件 + 默认编辑当前主题 ——
launcher.dispatch('click')
await tick()

const host = document.body.children.find((node) => node.id === 'dsh-theme-colors-host')
assert.ok(host, '未创建面板宿主')
const wrap = host.shadowRoot.children.find((node) => node.getAttribute('role') === 'dialog')
assert.ok(wrap, '未创建面板主体')
assert.equal(wrap.style.display, 'flex', '点击入口后应打开面板')

const rowsWrap = wrap.children.find((node) => node.className === 'rows')
assert.equal(rowsWrap.children.length, 3, `应有 3 行区域控件（会话栏/左栏/右栏），实际 ${rowsWrap.children.length}`)

const tabs = wrap.children.find((node) => node.className === 'tabs').children
assert.equal(tabs.length, 2)
assert.equal(tabs[0].getAttribute('aria-pressed'), 'true', '浅色页签应默认选中（当前为浅色主题）')

const rowOf = (index) => {
	const row = rowsWrap.children[index]
	return {
		row,
		head: row.children[0],
		color: row.children[2].children[0],
		hex: row.children[2].children[1],
		opacity: row.children[2].children[2],
		copy: row.children[0].children[1],
		apply: row.children[0].children[2],
		follow: row.children[0].children[3],
	}
}
const conversation = rowOf(0)
const sidebar = rowOf(1)
assert.equal(conversation.row.getAttribute('data-following'), 'yes', '会话栏默认跟随主题')
assert.equal(conversation.copy.disabled, true, '跟随主题时复制应禁用')
assert.equal(sidebar.row.getAttribute('data-following'), 'no')
assert.equal(sidebar.color.value, '#e8ecf3', '颜色输入未回填已保存配色')
assert.equal(sidebar.follow.style.visibility, 'visible')
// 透明度混合规则：左栏 80% 的不透明度已由 palette 处理，这里确认控件回填。
assert.equal(sidebar.opacity.value, '80')
assert.equal(sidebar.row.children[2].children[3].textContent, '80%')
assert.equal(rowsWrap.children.some((row) => row.children[0].children[0].textContent === '页面背景'), false, '已删除的区域不应出现')

// —— 3. 改色：防抖后 PUT，返回的 CSS 立刻生效 ——
conversation.color.value = '#123456'
conversation.color.dispatch('input')
await tick(400)
assert.equal(putCount, 1, '应发出一次保存请求')
assert.equal(lastPut.regions.conversation.light.color, '#123456')
assert.equal(lastPut.regions.sidebar.light.color, '#e8ecf3', '改一个区域不应影响别的区域')
assert.ok(liveStyle.textContent.includes('--dsw-alias-bg-base:#123456'), '保存后应立即应用新配色')
assert.ok(wrap.children.find((node) => node.className === 'foot').children[1].textContent.startsWith('已保存'), '状态行未提示已保存')

// —— 3b. 复制：把该区域色值写进剪贴板 ——
conversation.copy.dispatch('click')
await tick()
assert.deepEqual(copied, ['#123456'], '「复制」应把色值写进剪贴板')
assert.ok(wrap.children.find((node) => node.className === 'foot').children[1].textContent.includes('已复制'), '未提示已复制')

// —— 3c. 统一：把该区域的颜色与不透明度套用到全部区域 ——
conversation.opacity.value = '60'
conversation.opacity.dispatch('input')
await tick(400)
conversation.apply.dispatch('click')
await tick(400)
assert.equal(lastPut.regions.conversation.light.color, '#123456')
assert.equal(lastPut.regions.sidebar.light.color, '#123456', '「统一」应覆盖其它区域')
assert.equal(lastPut.regions.rightbar.light.color, '#123456')
assert.equal(lastPut.regions.sidebar.light.opacity, 60, '「统一」应连同不透明度一起套用')
assert.ok(rowsWrap.children.length === 3)

// —— 4. 跟随主题：清空该区域颜色 ——
sidebar.follow.dispatch('click')
await tick(400)
assert.equal(putCount, 4)
assert.equal(lastPut.regions.sidebar.light.color, '')
assert.equal(lastPut.regions.conversation.light.color, '#123456', '清空左栏不应影响会话栏')
assert.equal(sidebar.row.getAttribute('data-following'), 'yes')

// —— 5. 切换页签编辑另一套配色 ——
tabs[1].dispatch('click')
assert.equal(tabs[1].getAttribute('aria-pressed'), 'true')
assert.equal(rowOf(0).color.value, '#888888', '深色页签下未设置的区域用占位色显示')

// —— 6. 设置页卡片的事件路径打开面板；Esc 关闭 ——
wrap.style.display = 'none'
;(windowListeners['dsh-theme-colors:open'] || []).forEach((fn) => fn())
await tick()
assert.equal(wrap.style.display, 'flex', '设置卡片事件应打开同一个面板')
document.dispatchEvent = undefined
const keydown = globalThis.document
void keydown
// Esc 监听挂在 document 上，这里直接调用面板关闭按钮验证关闭路径。
wrap.children.find((node) => node.className === 'head').children[1].dispatch('click')
assert.equal(wrap.style.display, 'none', '关闭按钮应隐藏面板')

// —— 7. 拖动入口：位置按视口比例保存 ——
// 自动位置下按钮在 (276, 860)（bottom:12px），中心约 (312, 874)。
launcher.dispatch('pointerdown', { button: 0, pointerId: 1, clientX: 312, clientY: 874 })
launcher.dispatch('pointermove', { pointerId: 1, clientX: 600, clientY: 400, preventDefault() {} })
launcher.dispatch('pointerup', { pointerId: 1, clientX: 600, clientY: 400 })
await tick(400)
assert.equal(putCount, 5, '拖动结束后应保存一次')
assert.equal(launcher.style.left, '564px')
assert.equal(launcher.style.top, '386px')
assert.ok(lastPut.launcherSpot, '未写入 launcherSpot')
assert.ok(Math.abs(lastPut.launcherSpot.x - 600 / 1400) < 0.02, `x 比例异常：${lastPut.launcherSpot.x}`)
assert.ok(Math.abs(lastPut.launcherSpot.y - 400 / 900) < 0.02, `y 比例异常：${lastPut.launcherSpot.y}`)

// —— 8. 面板控件：入口归位 + 隐藏悬浮入口 ——
const foot2 = wrap.children.find((node) => node.className === 'foot2')
assert.ok(foot2, '面板缺少入口设置行')
const launcherCheck = foot2.children[0].children[0]
assert.equal(launcherCheck.checked, true, '入口开关应反映当前配置')
const recenter = foot2.children[1]
recenter.dispatch('click')
await tick(400)
assert.equal(lastPut.launcherSpot, null, '归位应清空 launcherSpot')
assert.equal(launcher.style.left, '276px', '归位后应回到自动位置')

launcherCheck.checked = false
launcherCheck.dispatch('change')
await tick(400)
assert.equal(lastPut.launcher, false, '关闭开关应写入 launcher:false')
assert.equal(document.body.children.includes(launcher), false, '关闭后应移除悬浮入口')

// —— 9. 预设：日间/夜间两组、只写对应那一套、以及"看得清"的硬约束 ——
const debug = globalThis.window.__dshThemeColors
assert.ok(debug && Array.isArray(debug.dayPresets) && Array.isArray(debug.nightPresets), '未暴露预设表')
assert.ok(
	debug.dayPresets.length >= 6 && debug.nightPresets.length >= 6,
	`日间与夜间方案各应至少 6 套，当前 ${debug.dayPresets.length}/${debug.nightPresets.length}`,
)
assert.ok(
	debug.dayPresets.concat(debug.nightPresets).every((preset) => preset.id && preset.name && preset.note && preset.colors),
	'预设缺少 id / 名称 / 说明 / 取值',
)

// DSH 主题的实际文字色（取自 dsh-client-ui-theme 的 --dsw-alias-label-primary）。
const THEME_TEXT = { light: '#0f1115', dark: '#f9fafb' }
const contrast = (a, b) => {
	const la = luminance(a)
	const lb = luminance(b)
	const [hi, lo] = la > lb ? [la, lb] : [lb, la]
	return (hi + 0.05) / (lo + 0.05)
}
// 日间方案只与浅色主题搭配，夜间方案只与深色主题搭配；两组各自验算。
let worst = Number.POSITIVE_INFINITY
for (const [modeKey, presets] of [
	['light', debug.dayPresets],
	['dark', debug.nightPresets],
]) {
	for (const preset of presets) {
		const values = debug.presetValues(preset)
		for (const key of debug.regionKeys) {
			const ratio = contrast(THEME_TEXT[modeKey], values[key])
			worst = Math.min(worst, ratio)
			assert.ok(ratio >= 4.5, `方案「${preset.name}」的 ${key} 在 ${modeKey} 下对比度仅 ${ratio.toFixed(2)}:1，低于 4.5:1`)
		}
		const lum = luminance(values.conversation)
		if (modeKey === 'light') assert.ok(lum > 0.6, `日间方案「${preset.name}」底色偏暗（亮度 ${lum.toFixed(3)}）`)
		else assert.ok(lum < 0.1, `夜间方案「${preset.name}」底色偏亮（亮度 ${lum.toFixed(3)}）`)
	}
}
console.log(`gui: ${debug.dayPresets.length} 套日间 + ${debug.nightPresets.length} 套夜间方案，最低对比度 ${worst.toFixed(2)}:1（要求 ≥ 4.5:1）`)

// 预设条结构：日间标题 + 日间按钮排 + 夜间标题 + 夜间按钮排。
const presetWrap = wrap.children.find((node) => node.className === 'presets')
assert.equal(presetWrap.children.length, 4, '预设条应为「日间标题/日间列表/夜间标题/夜间列表」四段')
assert.ok(presetWrap.children[0].textContent.includes('日间'), '缺少日间分组标题')
assert.ok(presetWrap.children[2].textContent.includes('夜间'), '缺少夜间分组标题')
const dayList = presetWrap.children[1]
const nightList = presetWrap.children[3]
assert.equal(dayList.children.length, debug.dayPresets.length, '日间按钮数量不符')
assert.equal(nightList.children.length, debug.nightPresets.length, '夜间按钮数量不符')
// 色块与页签无关：日间按钮永远显示日间取值，夜间按钮永远显示夜间取值。
const dayPreset = debug.dayPresets[0]
const nightPreset = debug.nightPresets[0]
const dayValues = debug.presetValues(dayPreset)
const nightValues = debug.presetValues(nightPreset)
assert.equal(dayList.children[0].children[0].children[0].style.background, dayValues.conversation)
assert.equal(nightList.children[0].children[0].children[0].style.background, nightValues.conversation)

// 官方主题状态行：当前是浅色，按钮应提示切到深色。
const themeRow = wrap.children.find((node) => node.className === 'themeRow')
assert.ok(themeRow.children[0].textContent.includes('官方主题'), '缺少官方主题状态行')
assert.equal(themeRow.children[1].textContent, '切到深色')

// —— 10. 套用预设：日间方案只写浅色那套，夜间方案只写深色那套 ——
const before = JSON.parse(JSON.stringify(config))
dayList.children[0].dispatch('click')
assert.ok(statusText(wrap).includes(dayPreset.name), '未提示已应用哪个方案')
await tick(400)
for (const key of debug.regionKeys) {
	assert.equal(lastPut.regions[key].light.color, dayValues[key], `日间方案未写入 ${key}/light`)
	assert.equal(lastPut.regions[key].light.opacity, 100, `日间方案未重置 ${key}/light 不透明度`)
	assert.equal(lastPut.regions[key].dark.color, before.regions[key].dark.color, `日间方案不应改动 ${key}/dark`)
}
assert.ok(liveStyle.textContent.includes(dayValues.conversation), '套用日间方案后界面未立即变色')

nightList.children[0].dispatch('click')
await tick(400)
for (const key of debug.regionKeys) {
	assert.equal(lastPut.regions[key].dark.color, nightValues[key], `夜间方案未写入 ${key}/dark`)
	assert.equal(lastPut.regions[key].light.color, dayValues[key], `夜间方案不应改动 ${key}/light`)
}
assert.ok(statusText(wrap).includes(nightPreset.name) || statusText(wrap).startsWith('已保存'), '夜间方案未生效')

// —— 11. 官方主题切换：接口可用时写入 ui-theme；不可用时就地说明原因（不给死按钮）——
themeRow.children[1].dispatch('click')
await tick()
assert.deepEqual(lastThemePut, { preference: 'dark' }, '未请求切换官方主题')
assert.ok(statusText(wrap).includes('深色'), '未提示已切换官方主题')

// 宿主未重启：接口回 405（SPA 兜底对非 GET 的回答）——应就地提示并撤掉按钮。
themeStatus = 405
themeRow.children[1].dispatch('click')
await tick()
assert.ok(themeRow.children[0].children[1].textContent.includes('重启'), '未就地提示需要重启 dsh web')
assert.equal(themeRow.children.length, 1, '接口不可用时不应继续显示切换按钮')
assert.ok(statusText(wrap).includes('重启'), '状态行未提示需要重启')
assert.ok(statusText(wrap).includes('设置'), '应同时指路官方设置页')
assert.ok(themeRow.children[0].children[1].textContent.includes('设置 → 通用 → 主题'), '应指出替代做法')

// —— 12. 深度 / 鲜亮度滑杆：改明度与彩度、只作用于当前页签、可还原 ——
// 按类名 / aria-label 定位，避免依赖面板内部的节点顺序。
const tuneWrap = wrap.children.find((node) => node.className === 'tune')
const byLabel = (label) => find(tuneWrap, (node) => node.getAttribute && node.getAttribute('aria-label') === label)[0]
const byClass = (className) => find(tuneWrap, (node) => node.className === className)[0]
const depthInput = byLabel('配色深度')
const vividInput = byLabel('配色鲜亮度')
const tuneContrast = byClass('tuneContrast')
const tuneReset = find(tuneWrap, (node) => node.tagName === 'BUTTON' && node.textContent === '还原方案原值')[0]
assert.equal(depthInput.getAttribute('type'), 'range')
assert.equal(vividInput.getAttribute('type'), 'range')
assert.ok(tuneContrast.textContent.includes('对比度'), '缺少对比度读数')
assert.ok(tuneContrast.textContent.includes(':1'), '对比度读数应包含比值')
for (const region of debug.regions) {
	assert.ok(tuneContrast.textContent.includes(region.label), `对比度读数缺少 ${region.label}`)
}

// 此时编辑的是深色那套（第 10 节套用了夜间方案）。
const beforeTune = JSON.parse(JSON.stringify(config))
const baseHue = debug.hexToOklch(beforeTune.regions.conversation.dark.color).H
const baseL = debug.hexToOklch(beforeTune.regions.conversation.dark.color).L
depthInput.value = '100'
depthInput.dispatch('input')
await tick(400)
const deepened = debug.hexToOklch(lastPut.regions.conversation.dark.color)
assert.ok(deepened.L < baseL, `拉深后会话栏应变暗（${baseL.toFixed(2)} → ${deepened.L.toFixed(2)}）`)
assert.equal(lastPut.regions.conversation.light.color, beforeTune.regions.conversation.light.color, '微调只应作用于当前编辑的那一套')
assert.ok(
	debug.contrastRatio(debug.themeText.dark, lastPut.regions.conversation.dark.color) >= 4.5,
	'深度拉到头也必须仍然可读',
)
assert.ok(liveStyle.textContent.includes(lastPut.regions.conversation.dark.color), '微调后界面未立即变色')

vividInput.value = '100'
vividInput.dispatch('input')
await tick(400)
const vivid = debug.hexToOklch(lastPut.regions.conversation.dark.color)
assert.ok(vivid.C > 0.004, `鲜亮度拉高后应有明显彩度，实际 C=${vivid.C.toFixed(3)}`)
const hueDelta = Math.min(Math.abs(vivid.H - baseHue), 360 - Math.abs(vivid.H - baseHue))
// 色相在推导里是精确保持的，偏差只来自 8bit 量化：量化步长 ≈0.004 Oklab，
// 换成角度是 0.004/C 弧度，低彩度下自然更大，所以按这个量级判定。
assert.ok(
	(vivid.C * hueDelta * Math.PI) / 180 < 0.006,
	`鲜亮度不应明显改变色相（C=${vivid.C.toFixed(3)}，漂移 ${hueDelta.toFixed(1)}°）`,
)
assert.ok(tuneContrast.textContent.includes('对比度'), '对比度读数应始终在场')

tuneReset.dispatch('click')
await tick(400)
assert.equal(lastPut.regions.conversation.dark.color, beforeTune.regions.conversation.dark.color, '还原应回到基准色')
assert.equal(lastPut.regions.sidebar.dark.color, beforeTune.regions.sidebar.dark.color, '还原应回到基准色（左栏）')

// —— 13. 推荐文字色：默认关闭；开启后按方案推导并覆盖官方文字 token ——
// —— 13. 文字色：推荐色 / 自定义都默认关闭；各自动作正确 ——
const textRecommended = byLabel('推荐色（按方案推导）')
const textCustom = byLabel('自定义文字色')
const textPresets = byClass('presetList')
const textRows = byClass('textRows')
const textCustomBox = byClass('textCustom')
const gamutField = byLabel('自由色域图')
const textDepth = byLabel('文字深度')
const textVivid = byLabel('文字鲜亮度')
assert.equal(textRecommended.getAttribute('type'), 'checkbox')
assert.equal(textCustom.getAttribute('type'), 'checkbox')
assert.equal(textRecommended.checked, false, '推荐色必须默认关闭')
assert.equal(textCustom.checked, false, '自定义文字色必须默认关闭')
assert.equal(liveStyle.textContent.includes('--dsw-alias-label-primary'), false, '默认状态不应改写官方文字色')
assert.equal(textCustomBox.style.display, 'none', '关闭时自定义控件应隐藏')
assert.equal(textRows.children.length, 3, '应有主 / 次 / 三级三行')

const editMode = tabs.find((tab) => tab.getAttribute('aria-pressed') === 'true').getAttribute('data-mode')

// 推荐色：按当前方案推导，且带明显色调（回归：不能再是近黑近白）。
textRecommended.checked = true
textRecommended.dispatch('change')
await tick(400)
assert.equal(lastPut.text.mode, 'recommended', '应进入推荐色状态')
assert.equal(textCustom.checked, false, '两个开关互斥')
for (const modeKey of ['light', 'dark']) {
	for (const role of debug.textRoles) {
		const color = lastPut.text[modeKey][role].color
		assert.ok(/^#[0-9a-f]{6}$/.test(color), `${modeKey}/${role} 推荐色非法：${color}`)
		const schemes = (modeKey === 'light' ? debug.dayPresets : debug.nightPresets).map((entry) => debug.presetValues(entry))
		for (const scheme of schemes) {
			for (const key of debug.regionKeys) {
				const ratio = debug.contrastRatio(color, scheme[key])
				assert.ok(ratio >= debug.textTargets[role], `推荐色 ${modeKey}/${role} 对 ${key} 仅 ${ratio.toFixed(1)}:1`)
			}
		}
	}
	const primary = debug.hexToOklch(lastPut.text[modeKey].primary.color)
	assert.ok(primary.C >= 0.012, `${modeKey} 推荐主文字彩度仅 ${primary.C.toFixed(4)}，看不出色调`)
}
assert.ok(liveStyle.textContent.includes('--dsw-alias-label-primary:#'), '推荐色应写入官方文字 token')

// 推荐色跟随方案：改区域颜色后自动重算（比较的是当前编辑那一套，因为改动只发生在那套）。
// 用另一个"深色"表面，避免人为造成三面明暗相反——那种情形的行为由下面的断言单独覆盖。
const beforeRecommended = lastPut.text[editMode].primary.color
const conversationRow = rowsWrap.children[0]
conversationRow.children[2].children[1].value = '#3a2a1e'
conversationRow.children[2].children[1].dispatch('change')
await tick(400)
assert.equal(lastPut.text.mode, 'recommended', '改方案不应改变文字色状态')
assert.notEqual(lastPut.text[editMode].primary.color, beforeRecommended, '推荐色应随方案表面变化重算')

// 三面明暗相反时给出警示（单一文字色无法都看清）。
conversationRow.children[2].children[1].value = '#f0e4c8'
conversationRow.children[2].children[1].dispatch('change')
await tick(400)
assert.ok(tuneContrast.textContent.includes('明暗相反'), '三面明暗相反时应提示')
// 复位成深色，后续断言在正常方案上继续。
conversationRow.children[2].children[1].value = '#1d3450'
conversationRow.children[2].children[1].dispatch('change')
await tick(400)

// 自定义：预设一键写入两套并保持自定义状态。
textCustom.checked = true
textCustom.dispatch('change')
await tick(400)
assert.equal(lastPut.text.mode, 'custom', '应进入自定义状态')
assert.equal(textRecommended.checked, false, '切换后推荐色应取消')
assert.equal(textCustomBox.style.display, 'flex', '自定义控件应展开')
const warm = debug.textPresets[0]
textPresets.children[0].dispatch('click')
await tick(400)
assert.equal(lastPut.text.mode, 'custom', '套预设仍属自定义')
assert.equal(lastPut.text.light.primary.color, warm.light[0], '浅色主文字应等于预设值')
assert.equal(lastPut.text.dark.primary.color, warm.dark[0], '深色主文字应等于预设值')

// 色域图：横轴取色相、纵轴取明度（尺寸在 stub 上手工给）。
gamutField.offsetWidth = 300
gamutField.offsetHeight = 54
textVivid.value = '60'
textVivid.dispatch('input')
await tick(400)
gamutField.dispatch('pointerdown', { pointerId: 1, clientX: 300, clientY: 27 })
await tick(400)
const picked = debug.hexToOklch(lastPut.text[editMode].primary.color)
const pickedHueDelta = Math.min(Math.abs(picked.H - 360), Math.abs(picked.H - 0))
assert.ok(pickedHueDelta < 25, `色域图右端应取到接近 360° 的色相，实际 ${picked.H.toFixed(0)}°`)

// 文字深度：拉到最远，主文字明度该朝远离表面的方向走，且始终达标。
const polarity = debug.textPolarity(editMode)
const beforeDepth = debug.hexToOklch(lastPut.text[editMode].primary.color).L
textDepth.value = '100'
textDepth.dispatch('input')
await tick(400)
const afterDepth = debug.hexToOklch(lastPut.text[editMode].primary.color).L
assert.ok(
	polarity === 'dark-text' ? afterDepth <= beforeDepth + 0.001 : afterDepth >= beforeDepth - 0.001,
	`文字深度拉满后明度方向不对（${beforeDepth.toFixed(3)} → ${afterDepth.toFixed(3)}，极性 ${polarity}）`,
)
for (const role of debug.textRoles) {
	for (const key of debug.regionKeys) {
		const ratio = debug.contrastRatio(lastPut.text[editMode][role].color, lastPut.regions[key][editMode].color)
		assert.ok(ratio >= debug.textTargets[role], `深度拉满后 ${role} 对 ${key} 仅 ${ratio.toFixed(1)}:1`)
	}
}

// 文字鲜亮度：彩度上升，色相基本不动（在中间深度上验，端点彩度本就很小）。
textDepth.value = '50'
textDepth.dispatch('input')
await tick(400)
const beforeVivid = debug.hexToOklch(lastPut.text[editMode].primary.color)
textVivid.value = '100'
textVivid.dispatch('input')
await tick(400)
const afterVivid = debug.hexToOklch(lastPut.text[editMode].primary.color)
assert.ok(afterVivid.C > beforeVivid.C, `鲜亮度升高应增加彩度（${beforeVivid.C.toFixed(3)} → ${afterVivid.C.toFixed(3)}）`)
if (afterVivid.C > 0.01) {
	const drift = Math.min(Math.abs(afterVivid.H - beforeVivid.H), 360 - Math.abs(afterVivid.H - beforeVivid.H))
	assert.ok((afterVivid.C * drift * Math.PI) / 180 < 0.012, `鲜亮度不应明显改变色相（漂移 ${drift.toFixed(1)}°）`)
}

// 逐档手改与逐档「跟随」。
const primaryRow = textRows.children[0]
primaryRow.children[2].value = '#123456'
primaryRow.children[2].dispatch('change')
await tick(400)
assert.equal(lastPut.text[editMode].primary.color, '#123456', '手改应写入配置')
const expectedWorst = Math.min(
	...debug.regionKeys.map((key) => debug.contrastRatio('#123456', lastPut.regions[key][editMode].color)),
)
assert.equal(primaryRow.children[3].textContent, expectedWorst.toFixed(1) + ':1', '对比度读数应等于最差表面的比值')
primaryRow.children[4].dispatch('click')
await tick(400)
assert.equal(lastPut.text[editMode].primary.color, '', '「跟随」应清除该档')
assert.equal(lastPut.text.mode, 'custom', '清除单档不应退出自定义')

// 整体「跟随主题」：回到 off，CSS 不再改写官方文字色。
const textClearAll = find(tuneWrap, (node) => node.tagName === 'BUTTON' && node.textContent === '跟随主题')[0]
textClearAll.dispatch('click')
await tick(400)
assert.equal(lastPut.text.mode, 'off', '整体回到官方主题应为 off')
assert.equal(liveStyle.textContent.includes('--dsw-alias-label-primary'), false, '清除后不应再改写官方文字色')
assert.equal(textCustom.checked, false, '清除后自定义开关应关闭')

globalThis.setInterval = realSetInterval
console.log('gui: 全部断言通过')
