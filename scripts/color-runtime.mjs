/**
 * 最小运行环境：gui.js 是经典脚本，加载后会把颜色数学挂在 window.__dshThemeColors 上。
 * 只提供它 import 时用到的最少全局对象，不做网络与定时器。
 * @returns 颜色数学与预设表的只读入口。
 */
export async function loadThemeColors() {
	const node = () => ({
		style: {},
		dataset: {},
		appendChild() {},
		addEventListener() {},
		setAttribute() {},
		select() {},
	})
	globalThis.window = {
		addEventListener() {},
		dispatchEvent() {
			return true
		},
	}
	globalThis.document = {
		body: {},
		head: { appendChild() {} },
		visibilityState: 'hidden',
		createElement: node,
		getElementById: () => null,
		querySelector: () => null,
		addEventListener() {},
		removeEventListener() {},
	}
	globalThis.fetch = () => Promise.reject(new Error('颜色测试不使用网络'))
	globalThis.setInterval = () => 0

	await import('../lib/gui.js')
	const api = globalThis.window.__dshThemeColors
	if (api === undefined) throw new Error('gui.js 未暴露 window.__dshThemeColors')
	return api
}
