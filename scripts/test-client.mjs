/**
 * 客户端卡片测试：不依赖浏览器，用一个最小 React 运行时把 lib/client.js 的
 * 工厂包真正执行一遍——校验 require 规格、cordis 插件导出、槽位注册参数，
 * 并渲染出设置卡片、触发它的事件。
 * 运行：node scripts/test-client.mjs
 */
import assert from 'node:assert/strict'

// —— 浏览器环境最小替身 ——
const appendedStyles = []
const dispatched = []
let loadedSpec = null

globalThis.window = {
	__ModuleLoader__: {
		load(spec) {
			loadedSpec = spec
		},
	},
	addEventListener() {},
	removeEventListener() {},
	dispatchEvent(event) {
		dispatched.push(event)
		return true
	},
}
globalThis.CustomEvent = class CustomEvent {
	constructor(type) {
		this.type = type
	}
}
globalThis.MutationObserver = class MutationObserver {
	observe() {}
	disconnect() {}
}
globalThis.document = {
	body: { hasAttribute: () => false },
	head: {
		appendChild(node) {
			appendedStyles.push(node)
		},
	},
	createElement() {
		return { dataset: {}, textContent: '' }
	},
	querySelector: () => null,
}
globalThis.fetch = async () => ({
	ok: true,
	json: async () => ({
		ok: true,
		regions: [
			{ key: 'background', label: '页面背景', hint: '旧字段，应被过滤掉' },
			{ key: 'conversation', label: '会话栏', hint: '中列' },
			{ key: 'sidebar', label: '左侧会话列表栏', hint: '左列' },
			{ key: 'rightbar', label: '右侧栏', hint: '右列' },
		],
		config: {
			launcher: true,
			regions: {
				background: { light: { color: '#101418', opacity: 100 }, dark: { color: '#07090c', opacity: 100 } },
				conversation: { light: { color: '', opacity: 100 }, dark: { color: '', opacity: 100 } },
				sidebar: { light: { color: '#e8ecf3', opacity: 80 }, dark: { color: '', opacity: 100 } },
				rightbar: { light: { color: '', opacity: 100 }, dark: { color: '', opacity: 100 } },
			},
		},
	}),
})

// —— 最小 React 运行时：createElement / useState / useEffect ——
const states = []
const effects = []
let cursor = 0
let rendering = false
let tree = null
let component = null

const sameDeps = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((value, index) => Object.is(value, b[index]))

const ReactImpl = {
	createElement(type, props, ...children) {
		const flat = children.flat(Infinity).filter((child) => child !== null && child !== undefined && child !== false)
		return { type, props: Object.assign({}, props || {}), children: flat }
	},
	useState(initial) {
		const index = cursor++
		if (!(index in states)) states[index] = typeof initial === 'function' ? initial() : initial
		const setState = (next) => {
			states[index] = typeof next === 'function' ? next(states[index]) : next
			render()
		}
		return [states[index], setState]
	},
	useEffect(fn, deps) {
		const index = cursor++
		const slot = effects[index]
		if (!slot || !sameDeps(slot.deps, deps)) effects[index] = { deps, fn, ran: false }
	},
}

function render() {
	if (rendering || component === null) return
	rendering = true
	cursor = 0
	tree = component({})
	rendering = false
	let guard = 0
	for (let index = 0; index < effects.length; index += 1) {
		const slot = effects[index]
		if (slot && !slot.ran) {
			slot.ran = true
			slot.cleanup = slot.fn()
			guard += 1
			if (guard > 20) throw new Error('effect 循环')
		}
	}
}

/** 把元素树序列化成 HTML 片段，便于断言。 */
function serialize(node) {
	if (node === null || node === undefined || typeof node === 'boolean') return ''
	if (typeof node === 'string' || typeof node === 'number') return String(node)
	if (Array.isArray(node)) return node.map(serialize).join('')
	if (typeof node.type === 'function') return serialize(node.type(node.props))
	const attrs = Object.keys(node.props)
		.filter((key) => key !== 'children' && key !== 'onClick' && typeof node.props[key] !== 'object')
		.map((key) => ` ${key}="${String(node.props[key])}"`)
		.join('')
	return `<${node.type}${attrs}>${node.children.map(serialize).join('')}</${node.type}>`
}

/** 收集满足条件的节点。 */
function find(node, predicate, found = []) {
	if (node === null || node === undefined || typeof node !== 'object') return found
	if (Array.isArray(node)) {
		node.forEach((child) => find(child, predicate, found))
		return found
	}
	if (predicate(node)) found.push(node)
	;(node.children || []).forEach((child) => find(child, predicate, found))
	return found
}

// —— 1. 工厂包形状与外部依赖 ——
await import('../lib/client.js')
assert.ok(loadedSpec !== null, '未调用 window.__ModuleLoader__.load')
assert.equal(loadedSpec.id, 'dsh-theme-colors')
assert.equal(typeof loadedSpec.factory, 'function')

const requested = []
loadedSpec.factory((specifier) => {
	requested.push(specifier)
	throw new Error(`unexpected require: ${specifier}`)
})
assert.deepEqual(requested, ['react'], `外部依赖应只有 react，实际 ${requested.join(',')}`)

// —— 2. cordis 插件导出与槽位注册 ——
const exportsObject = loadedSpec.factory((specifier) => {
	if (specifier === 'react') return ReactImpl
	throw new Error(`unexpected require: ${specifier}`)
})
assert.deepEqual(Object.keys(exportsObject).sort(), ['apply', 'inject'])
assert.deepEqual(exportsObject.inject, ['slots'])

let registered = null
const slotCalls = []
const fakeCtx = {
	slots: {
		inject(name, contribute) {
			slotCalls.push(['inject', name])
			contribute()
		},
		register(options, registeredComponent) {
			slotCalls.push(['register', options])
			registered = { options, component: registeredComponent }
		},
	},
}
assert.doesNotThrow(() => exportsObject.apply(fakeCtx))
assert.deepEqual(slotCalls[0], ['inject', 'settings.general.item'])
assert.equal(slotCalls[1][0], 'register')
assert.deepEqual(
	{ name: slotCalls[1][1].name, id: slotCalls[1][1].id, order: slotCalls[1][1].order },
	{ name: 'settings.general.item', id: 'dsh-theme-colors', order: 12 },
)
assert.equal(typeof registered.component, 'function')
assert.equal(appendedStyles.length, 1, '应注入一次卡片样式')
assert.equal(appendedStyles[0].dataset.pluginPss, undefined)
assert.equal(appendedStyles[0].dataset.pluginCss, 'dsh-theme-colors/settings-row.css')

// —— 3. 渲染卡片 ——
component = registered.component
render()

const initial = serialize(tree)
assert.ok(initial.includes('dtc-row'), '卡片根节点缺少 dtc-row')
assert.ok(initial.includes('data-dsh-theme-colors-row'), '卡片缺少调试标记')
assert.ok(initial.includes('配色'), '卡片缺少标题')
assert.ok(initial.includes('正在读取配色…'), '初始态应先显示读取中')

// 等待 fetch 的微任务完成后重渲染：应有 3 个色块（旧字段 background 被过滤）与当前主题描述。
await new Promise((resolve) => setTimeout(resolve, 0))
const loaded = serialize(tree)
assert.equal((loaded.match(/dtc-swatch"/g) || []).length, 3, `应有 3 个色块（不含已删除的「页面背景」），实际渲染：${loaded}`)
assert.ok(loaded.includes('当前 浅色主题'), '描述未反映当前主题')
assert.ok(loaded.includes('调整配色…'), '缺少打开面板的按钮')

const following = find(tree, (node) => node.props && node.props.className === 'dtc-swatch' && node.props['data-following'] === 'yes')
assert.equal(following.length, 2, '会话栏与右侧栏默认应跟随主题')

const colored = find(tree, (node) => node.props && node.props.className === 'dtc-swatch' && node.props['data-following'] === 'no')
assert.equal(colored.length, 1, '只有左侧栏应带自定义颜色')
assert.equal(colored[0].props.style.background, 'color-mix(in srgb, #e8ecf3 80%, transparent)')

// —— 4. 点按钮：派发打开面板事件 ——
const button = find(tree, (node) => node.props && node.props.className === 'dtc-open')[0]
assert.ok(button, '找不到打开按钮')
button.props.onClick()
assert.equal(dispatched.length, 1)
assert.equal(dispatched[0].type, 'dsh-theme-colors:open')

console.log('client: 全部断言通过')
