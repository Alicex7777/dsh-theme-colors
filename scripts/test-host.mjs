/**
 * 宿主侧冒烟测试：用桩 ctx + 真实 HTTP 服务器跑 apply()，验证路由、鉴权头、
 * 落盘与 index 注入行。
 * 运行：node scripts/test-host.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-theme-colors-test-'))
process.env.DSH_HOME = home

const { name, inject, apply } = await import('../lib/index.js')
assert.equal(name, 'dsh-theme-colors')
assert.deepEqual(inject, ['webServer'])

// —— 桩 ctx：exact 优先、最长 prefix 次之的路由匹配，外加事件、effect 与 settings ——
const exact = new Map()
const prefixes = []
const injections = []
const themeWrites = []
/** ui-theme 命名空间的替身：写入会真的改变它，便于验证"写后能读到"。 */
const themeState = { preference: 'light', fontSize: 14 }
const settingsService = {
	describe: () => [
		{ ns: 'ui-theme', value: Object.assign({}, themeState) },
		{ ns: 'ui-conversation', value: { busyEnter: 'steer' } },
	],
	async update(ns, patch) {
		if (ns !== 'ui-theme') throw new Error(`unknown namespace ${ns}`)
		themeWrites.push({ ns, patch })
		Object.assign(themeState, patch)
	},
}
const ctx = {
	webServer: {
		register(route) {
			if (route.kind === 'exact') {
				assert.ok(!exact.has(route.path), `重复的 exact 路由 ${route.path}`)
				exact.set(route.path, route.handler)
			} else {
				prefixes.push(route)
			}
			return () => {}
		},
	},
	on(event, listener) {
		if (event === 'webserver/index-inject') injections.push(listener)
		return () => {}
	},
	effect(fn) {
		fn()
		return () => {}
	},
	inject(names, callback) {
		if (names.includes('settings')) callback({ settings: settingsService })
	},
}

apply(ctx)
assert.equal(exact.size, 4, '应注册 config.json、gui.js、palette.js、theme.json 四条 exact 路由')
assert.equal(injections.length, 1, '应注册一条 index 注入监听')

const server = http.createServer((req, res) => {
	const pathname = new URL(req.url, 'http://127.0.0.1').pathname
	if (exact.has(pathname)) return exact.get(pathname)(req, res)
	const hit = prefixes.filter((route) => pathname === route.path || pathname.startsWith(`${route.path}/`)).sort((a, b) => b.path.length - a.path.length)[0]
	if (hit) return hit.handler(req, res)
	res.writeHead(404).end('nope')
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}`

try {
	// 首帧：接口给出完整默认配置与空 CSS。
	const first = await fetch(`${base}/dsh-theme-colors/config.json`)
	assert.equal(first.status, 200)
	const firstBody = await first.json()
	assert.equal(firstBody.ok, true)
	assert.equal(firstBody.configFile, path.join(home, '.dsh-theme-colors.json'))
	assert.equal(firstBody.regions.length, 3)
	assert.deepEqual(firstBody.regions.map((region) => region.key), ['conversation', 'sidebar', 'rightbar'])
	assert.deepEqual(firstBody.config.regions.conversation.light, { color: '', opacity: 100 })
	assert.ok(firstBody.css.includes('dsh-theme-colors'), 'CSS 注释头缺失')

	// 缺少自定义头：拒绝写入。
	const denied = await fetch(`${base}/dsh-theme-colors/config.json`, {
		method: 'PUT',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ regions: { conversation: { light: { color: '#101418' } } } }),
	})
	assert.equal(denied.status, 403)

	// 正常写入：返回新 CSS，并落到 $DSH_HOME；旧字段 background 被忽略。
	const saved = await fetch(`${base}/dsh-theme-colors/config.json`, {
		method: 'PUT',
		headers: { 'Content-Type': 'application/json', 'x-dsh-theme-colors': '1' },
		body: JSON.stringify({
			launcher: false,
			regions: {
				background: { light: { color: '#101418' }, dark: { color: '#07090c' } },
				conversation: { light: { color: '#1b2430', opacity: 100 }, dark: { color: '#0b1016' } },
				sidebar: { light: { color: '#e8ecf3', opacity: 80 } },
			},
		}),
	})
	assert.equal(saved.status, 200)
	const savedBody = await saved.json()
	assert.equal(savedBody.config.regions.background, undefined, '旧字段「页面背景」应被忽略')
	assert.ok(
		savedBody.css.includes('body:not([data-ds-dark-theme]){--dsw-specific-sidebar-fill:color-mix(in srgb, #e8ecf3 80%, transparent)}'),
		'浅色左栏 token 声明不符合预期',
	)
	assert.ok(
		savedBody.css.includes('body:not([data-ds-dark-theme]) [class*="centerCol"]{--dsw-alias-bg-base:#1b2430;background:#1b2430 !important}'),
		'浅色会话栏规则不符合预期',
	)
	assert.ok(
		savedBody.css.includes('body[data-ds-dark-theme][data-ds-dark-theme] [class*="centerCol"]{--dsw-alias-bg-base:#0b1016;background:#0b1016 !important}'),
		'深色会话栏规则不符合预期',
	)
	assert.equal(savedBody.config.launcher, false)

	const onDisk = JSON.parse(fs.readFileSync(path.join(home, '.dsh-theme-colors.json'), 'utf8'))
	assert.equal(onDisk.regions.background, undefined)
	assert.equal(onDisk.regions.conversation.light.color, '#1b2430')
	assert.equal(onDisk.regions.sidebar.light.opacity, 80)
	assert.ok(!fs.readdirSync(home).some((entry) => entry.includes('.tmp-')), '临时文件未清理')

	// 再次 GET 读到落盘结果。
	const reread = await (await fetch(`${base}/dsh-theme-colors/config.json`)).json()
	assert.equal(reread.config.regions.conversation.dark.color, '#0b1016')
	assert.equal(reread.config.launcher, false)

	// 界面脚本可访问且是脚本内容。
	const gui = await fetch(`${base}/dsh-theme-colors/gui.js`)
	assert.equal(gui.status, 200)
	assert.match(gui.headers.get('content-type'), /javascript/)
	assert.ok((await gui.text()).includes('dsh-theme-colors:open'), 'gui.js 内容异常')

	// palette 模块按请求现读磁盘：界面侧据此重算 CSS，宿主模块陈旧也能刷新生效。
	const palette = await fetch(`${base}/dsh-theme-colors/palette.js`)
	assert.equal(palette.status, 200)
	assert.match(palette.headers.get('content-type'), /javascript/)
	const paletteText = await palette.text()
	assert.ok(paletteText.includes('export function renderCss'), 'palette.js 不是可 import 的模块')
	assert.ok(paletteText.includes('scopedVar'), '磁盘上的 palette.js 应是含会话栏修正的版本')

	// 注入行：一条 style（当前配色）+ 一条 body 脚本。
	const table = []
	for (const listener of injections) listener(table)
	assert.equal(table.length, 2)
	assert.equal(table[0].kind, 'style')
	assert.ok(table[0].text.includes('--dsw-alias-bg-base:#1b2430'), '注入的 style 未使用当前配色')
	assert.ok(table[0].text.includes('--dsw-specific-sidebar-fill:color-mix(in srgb, #e8ecf3 80%, transparent)'), '注入的 style 缺少左栏规则')
	assert.deepEqual(table[1], { kind: 'script-src', placement: 'body', src: '/dsh-theme-colors/gui.js' })

	// 官方主题：读取现状 / 校验取值 / 通过 settings 服务写入。
	const themeRead = await fetch(`${base}/dsh-theme-colors/theme.json`)
	assert.equal(themeRead.status, 200)
	const themeBody = await themeRead.json()
	assert.equal(themeBody.preference, 'light')
	assert.ok(themeBody.namespaces.includes('ui-theme'), '未列出 ui-theme 命名空间')

	const themeDenied = await fetch(`${base}/dsh-theme-colors/theme.json`, {
		method: 'PUT',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ preference: 'dark' }),
	})
	assert.equal(themeDenied.status, 403, '缺少自定义头时应拒绝切主题')

	const themeInvalid = await fetch(`${base}/dsh-theme-colors/theme.json`, {
		method: 'PUT',
		headers: { 'Content-Type': 'application/json', 'x-dsh-theme-colors': '1' },
		body: JSON.stringify({ preference: 'sepia' }),
	})
	assert.equal(themeInvalid.status, 400, '非法偏好应被拒绝')

	const themeSwitched = await fetch(`${base}/dsh-theme-colors/theme.json`, {
		method: 'PUT',
		headers: { 'Content-Type': 'application/json', 'x-dsh-theme-colors': '1' },
		body: JSON.stringify({ preference: 'dark' }),
	})
	assert.equal(themeSwitched.status, 200)
	assert.equal((await themeSwitched.json()).preference, 'dark')
	assert.deepEqual(themeWrites, [{ ns: 'ui-theme', patch: { preference: 'dark' } }], '未通过 settings 服务写入')
	// 写入后能读回新值。
	assert.equal((await (await fetch(`${base}/dsh-theme-colors/theme.json`)).json()).preference, 'dark')

	// 未注册方法 / 未知路径。
	const wrongMethod = await fetch(`${base}/dsh-theme-colors/config.json`, { method: 'DELETE' })
	assert.equal(wrongMethod.status, 405)

	console.log('host: 全部断言通过')
} finally {
	server.close()
	fs.rmSync(home, { recursive: true, force: true })
}
