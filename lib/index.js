/**
 * dsh-theme-colors —— DSH Web 配色调节插件的宿主侧。
 *
 * 三件事：
 * 1. 配色存在 `$DSH_HOME/.dsh-theme-colors.json`（原子写），与主题偏好各自独立。
 * 2. `webserver/index-inject` 每次渲染 index.html 时下发一条 `<style>`（当前配色）
 *    与 GUI 侧脚本：首帧就是目标配色，且每次刷新都以文件为准。
 * 3. 提供 `/dsh-theme-colors/config.json` 读写接口。界面里的调色面板与设置页的
 *    「配色」卡片都走这一个接口，改完即时生效并落盘。
 *
 * 配色语义与 CSS 生成在 palette.js；面板与设置卡片分别在 gui.js / client.js。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { CONFIG_VERSION, MODES, REGIONS, defaultConfig, normalizeConfig, renderCss } from './palette.js'

/** 包根目录：lib/index.js -> 包根；link: 本地安装与 node_modules 安装都成立。 */
const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** DSH 主目录；配置文件放这里，插件升级、重装都不会丢。 */
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')

/** 配色文件路径。 */
const CONFIG_FILE = path.join(DSH_HOME, '.dsh-theme-colors.json')

/** 本插件占用的路由前缀（无尾斜杠）。 */
const ROUTE_BASE = '/dsh-theme-colors'

/** 写接口要求的自定义请求头：挡住其它站点的简单跨站请求。 */
const SAVE_HEADER = 'x-dsh-theme-colors'

/** 请求体上限。 */
const MAX_BODY_BYTES = 64 * 1024

/** 官方主题偏好所在的设置命名空间与合法取值。 */
const THEME_NAMESPACE = 'ui-theme'
const THEME_PREFERENCES = ['light', 'dark', 'system']

/** 插件名（cordis 入口名）。 */
export const name = 'dsh-theme-colors'

/** 注册路由与监听 index 注入都依赖 webServer。 */
export const inject = ['webServer']

/** 读取配色；文件缺失或损坏时回落到默认配置。 */
function readConfig() {
	try {
		return normalizeConfig(JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')))
	} catch {
		return defaultConfig()
	}
}

/** 原子写入配色：先写同目录临时文件再 rename。 */
function writeConfig(raw) {
	const config = normalizeConfig(raw)
	fs.mkdirSync(DSH_HOME, { recursive: true })
	const tmp = `${CONFIG_FILE}.tmp-${process.pid}-${Date.now()}`
	fs.writeFileSync(tmp, JSON.stringify(config, null, 2) + '\n', 'utf8')
	fs.renameSync(tmp, CONFIG_FILE)
	return config
}

/** 发送文本响应；HEAD 只发头。 */
function sendText(req, res, status, contentType, body) {
	res.writeHead(status, {
		'Content-Type': contentType,
		'Content-Length': String(Buffer.byteLength(body)),
		'Cache-Control': 'no-store',
	})
	if (req.method === 'HEAD') res.end()
	else res.end(body)
}

/** 发送 JSON 响应。 */
function sendJson(req, res, status, payload) {
	sendText(req, res, status, 'application/json; charset=utf-8', JSON.stringify(payload))
}

/** 读取请求体（有上限）。 */
function readBody(req) {
	return new Promise((resolve, reject) => {
		const chunks = []
		let size = 0
		req.on('data', (chunk) => {
			size += chunk.length
			if (size > MAX_BODY_BYTES) {
				reject(new Error('请求体过大'))
				req.destroy()
				return
			}
			chunks.push(chunk)
		})
		req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
		req.on('error', reject)
	})
}

/** 读取包内静态文件；缺失返回 null 交给调用方报 500。 */
function readAsset(filename) {
	try {
		return fs.readFileSync(path.join(PACKAGE_ROOT, 'lib', filename), 'utf8')
	} catch {
		return null
	}
}

/** 接口响应：配置、默认值、渲染结果、文件位置与区域表一起给界面。 */
function payload(config) {
	return {
		ok: true,
		version: CONFIG_VERSION,
		config,
		defaults: defaultConfig(),
		css: renderCss(config),
		configFile: CONFIG_FILE,
		modes: MODES.map((mode) => mode.key),
		regions: REGIONS.map((region) => ({ key: region.key, label: region.label, hint: region.hint })),
	}
}

/**
 * 读出官方主题当前偏好与已注册的设置命名空间。
 * 命名空间一并返回，便于在偏好读不到时直接看出 ui-theme 是否存在。
 * @param settings - 宿主 settings 服务。
 * @returns 命名空间列表与（可读到时）当前偏好。
 */
function describeTheme(settings) {
	try {
		const descriptors = settings.describe({ redactSecrets: true })
		const namespaces = descriptors.map((descriptor) => descriptor.ns)
		const theme = descriptors.find((descriptor) => descriptor.ns === THEME_NAMESPACE)
		const value = theme === undefined ? undefined : theme.value
		const preference = value !== null && typeof value === 'object' && typeof value.preference === 'string' ? value.preference : undefined
		return { namespaces, preference }
	} catch (error) {
		return { namespaces: [], error: String((error && error.message) || error) }
	}
}

/**
 * 插件主体：注册配色接口与 index 注入。
 * @param ctx - 含 webServer 的宿主 cordis 上下文。
 */
export function apply(ctx) {
	const disposers = []

	/** 单个请求出错只回错误响应，绝不把宿主进程带下去。 */
	const fail = (res, error) => {
		if (res.headersSent) {
			res.end()
			return
		}
		res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' })
		res.end(`dsh-theme-colors: ${String((error && error.message) || error)}`)
	}

	const guard = (handler) => (req, res) => {
		try {
			const result = handler(req, res)
			if (result && typeof result.catch === 'function') result.catch((error) => fail(res, error))
		} catch (error) {
			fail(res, error)
		}
	}

	// 配色读写接口。
	disposers.push(ctx.webServer.register({
		kind: 'exact',
		path: `${ROUTE_BASE}/config.json`,
		handler: guard(async (req, res) => {
			if (req.method === 'GET' || req.method === 'HEAD') {
				sendJson(req, res, 200, payload(readConfig()))
				return
			}
			if (req.method !== 'PUT' && req.method !== 'POST') {
				sendJson(req, res, 405, { ok: false, error: '仅支持 GET/PUT' })
				return
			}
			if (req.headers[SAVE_HEADER] === undefined) {
				sendJson(req, res, 403, { ok: false, error: `缺少 ${SAVE_HEADER} 请求头` })
				return
			}
			sendJson(req, res, 200, payload(writeConfig(JSON.parse(await readBody(req)))))
		}),
	}))

	// 界面侧脚本：调色面板 + 配色实时应用。
	disposers.push(ctx.webServer.register({
		kind: 'exact',
		path: `${ROUTE_BASE}/gui.js`,
		handler: guard((req, res) => {
			if (req.method !== 'GET' && req.method !== 'HEAD') {
				sendJson(req, res, 405, { ok: false, error: '仅支持 GET' })
				return
			}
			const body = readAsset('gui.js')
			if (body === null) {
				sendJson(req, res, 500, { ok: false, error: '缺少 gui.js' })
				return
			}
			sendText(req, res, 200, 'application/javascript; charset=utf-8', body)
		}),
	}))

	// 配色语义模块：界面侧动态 import 同一份文件自己重算 CSS。文件按请求现读，
	// 因此 palette.js 的改动刷新即生效，不必重启宿主（宿主内已加载的模块是旧的）。
	disposers.push(ctx.webServer.register({
		kind: 'exact',
		path: `${ROUTE_BASE}/palette.js`,
		handler: guard((req, res) => {
			if (req.method !== 'GET' && req.method !== 'HEAD') {
				sendJson(req, res, 405, { ok: false, error: '仅支持 GET' })
				return
			}
			const body = readAsset('palette.js')
			if (body === null) {
				sendJson(req, res, 500, { ok: false, error: '缺少 palette.js' })
				return
			}
			sendText(req, res, 200, 'application/javascript; charset=utf-8', body)
		}),
	}))

	// 官方主题切换：官方主题偏好存在 ui-theme 设置命名空间，宿主 settings 服务是唯一
	// 权威写入方（它写的是 profile 的用户文档，并与界面互相同步）。该服务不存在的
	// 部署不注册这条路由，界面会提示改去 设置 → 通用 → 主题。
	ctx.inject(['settings'], (settingsCtx) => {
		disposers.push(ctx.webServer.register({
			kind: 'exact',
			path: `${ROUTE_BASE}/theme.json`,
			handler: guard(async (req, res) => {
				if (req.method === 'GET' || req.method === 'HEAD') {
					sendJson(req, res, 200, Object.assign({ ok: true }, describeTheme(settingsCtx.settings)))
					return
				}
				if (req.method !== 'PUT' && req.method !== 'POST') {
					sendJson(req, res, 405, { ok: false, error: '仅支持 GET/PUT' })
					return
				}
				if (req.headers[SAVE_HEADER] === undefined) {
					sendJson(req, res, 403, { ok: false, error: `缺少 ${SAVE_HEADER} 请求头` })
					return
				}
				const body = JSON.parse(await readBody(req))
				const preference = body === null || typeof body !== 'object' ? undefined : body.preference
				if (!THEME_PREFERENCES.includes(preference)) {
					sendJson(req, res, 400, { ok: false, error: 'preference 只能是 light / dark / system' })
					return
				}
				await settingsCtx.settings.update(THEME_NAMESPACE, { preference })
				sendJson(req, res, 200, Object.assign({ ok: true, preference }, describeTheme(settingsCtx.settings)))
			}),
		}))
	})

	// index 注入：每次渲染现读配置，所以手工改 JSON 后刷新即生效。
	disposers.push(ctx.on('webserver/index-inject', (table) => {
		table.push({ kind: 'style', text: renderCss(readConfig()) })
		table.push({ kind: 'script-src', placement: 'body', src: `${ROUTE_BASE}/gui.js` })
	}))

	ctx.effect(() => () => {
		for (const dispose of disposers) {
			try {
				dispose()
			} catch {
				/* 释放失败不影响其它路由 */
			}
		}
	})
}
