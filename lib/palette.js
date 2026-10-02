/**
 * dsh-theme-colors —— 配色模型与 CSS 生成。
 *
 * 这里是配色语义的唯一来源：宿主侧用它把保存的配色渲染成 CSS（随 index.html
 * 一起下发，页面首帧就是目标配色，不会闪一下默认主题），编辑器页面直接以 ES
 * 模块方式 import 本文件，因此区域列表、默认值、取色规则只有一份。
 *
 * 生效方式分两类：
 * - 有 `varName` 的区域改写主题的 CSS 自定义属性（token）。token 是 ui-theme
 *   公开的扩展面，不依赖任何内部类名，DSH 升级后依然有效。
 * - 有 `className` 的区域（会话栏、右侧栏没有对应的 token）用
 *   `[class*="centerCol"]` 这类**类名片段**选择器命中布局列。CSS Modules 的
 *   类名形如 `pI_x6G_centerCol` 或 `_centerCol_1ypvv_12`，两种命名的可读部分
 *   都保留，因此该选择器不随构建哈希变化。
 */

/** 配置文件结构版本；2 去掉「页面背景」，3 加入推荐文字色（text）。 */
export const CONFIG_VERSION = 3

/** 合法颜色：`#rgb` 或 `#rrggbb`。 */
const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i

/** 深浅模式在 body 上的属性名（由 ui-theme 写入）。 */
const DARK_ATTR = 'data-ds-dark-theme'

/**
 * 可调区域。`key` 是配置字段名，两种主题各自保存一份取值；颜色为空表示「跟随主题」
 * （即不覆盖，界面保持 DSH 主题原样）。每个区域只作用于自己那一块，互不牵连：
 * - `sidebar`：左栏用 token `--dsw-specific-sidebar-fill`。
 * - `centerCol` / `rightbarCol`：按布局列命中并就地覆盖背景。中列还要重绑定
 *   `--dsw-alias-bg-base`，因为中列本身透明、真正铺满整列的是栏内会话根元素
 *   （`background: var(--dsw-alias-bg-base)`），只设 background 会被它盖住。
 */
export const REGIONS = [
	{
		key: 'conversation',
		label: '会话栏',
		hint: '中间那一条对话栏；栏内聊天底色、代码块等与它同源，会一起变化。',
		className: 'centerCol',
		scopedVar: '--dsw-alias-bg-base',
	},
	{
		key: 'sidebar',
		label: '左侧会话列表栏',
		hint: '左边会话与工作区列表那一列。',
		target: 'sidebar',
		varName: '--dsw-specific-sidebar-fill',
	},
	{
		key: 'rightbar',
		label: '右侧栏',
		hint: 'Ctrl+Shift+B 唤出的右侧面板（文件 / 浏览器 / 终端等页签）。',
		className: 'rightbarCol',
		/**
		 * 面板各页签自己铺底色（base 用于面板与浏览器页，layer-1 用于页签栏与终端），
		 * 所以要在这一列内就地重绑定这两个 token，只设 background 会被内容盖住。
		 */
		scopedVar: ['--dsw-alias-bg-base', '--dsw-alias-bg-layer-1'],
	},
]

/** 支持的区域 key，界面侧据此过滤宿主可能多给的行。 */
export const REGION_KEYS = REGIONS.map((region) => region.key)

/** 可分别调节的两套主题配色。 */
export const MODES = [
	{ key: 'light', label: '浅色主题' },
	{ key: 'dark', label: '深色主题' },
]

/**
 * 两种模式各自的选择器。深色一行把属性重复一次提升权重，压过主题自己的
 * `body[data-ds-dark-theme]`；浅色一行用 `:not()` 同样高于主题的 `body`。
 */
const SELECTORS = {
	light: `body:not([${DARK_ATTR}])`,
	dark: `body[${DARK_ATTR}][${DARK_ATTR}]`,
}

/** 一个区域的默认取值：不覆盖、完全不透明。 */
function defaultEntry() {
	return { color: '', opacity: 100 }
}

/** 推荐文字色的三个层级（空串表示未设置）。 */
export const TEXT_ROLES = ['primary', 'secondary', 'tertiary']

/**
 * 文字色的三种状态：
 * - `off`（默认）：完全跟随官方主题文字色；
 * - `recommended`：按当前方案表面推导（同色相 + 对比度目标），随方案变化自动更新；
 * - `custom`：用户自己指定（预设 / 色域图 / 深度鲜亮度 / 逐档手填）。
 */
export const TEXT_MODES = ['off', 'recommended', 'custom']

/** 官方主题里承载文字层级的 token；只接管这三层，dimmed / caption / inverted / 语义色留给主题。 */
export const TEXT_TOKEN_BY_ROLE = {
	primary: '--dsw-alias-label-primary',
	secondary: '--dsw-alias-label-secondary',
	tertiary: '--dsw-alias-label-tertiary',
}

/** 一组空的推荐文字色（与区域同结构，便于共用取值与容错逻辑）。 */
function defaultTextColors() {
	const colors = {}
	for (const role of TEXT_ROLES) colors[role] = defaultEntry()
	return colors
}

/** 未经用户修改的默认配置。 */
export function defaultConfig() {
	const regions = {}
	for (const region of REGIONS) {
		regions[region.key] = { light: defaultEntry(), dark: defaultEntry() }
	}
	return {
		version: CONFIG_VERSION,
		/** 是否在界面里显示悬浮入口按钮。 */
		launcher: true,
		/**
		 * 悬浮入口的位置，写成相对视口的比例（0..1）；null 表示自动——
		 * 贴在侧边栏右侧、会话区左下角，避开左侧边栏底部的「设置」等控件。
		 * 用比例而不是像素，换窗口大小后位置依然合理。
		 */
		launcherSpot: null,
		/**
		 * 文字色：默认 off（跟随官方主题）。recommended 按方案推导并跟随方案变化；
		 * custom 为用户自定。两种非 off 状态下用下面的取值覆盖主/次/三级文字色。
		 */
		text: {
			mode: 'off',
			light: defaultTextColors(),
			dark: defaultTextColors(),
		},
		regions,
	}
}

/** 取整并夹到区间内，非数值回落到兜底值。 */
function clampInt(value, min, max, fallback) {
	const n = typeof value === 'number' ? value : Number(value)
	if (!Number.isFinite(n)) return fallback
	return Math.min(max, Math.max(min, Math.round(n)))
}

/** 归一化一个区域在一种模式下的取值。 */
function normalizeEntry(entry) {
	const raw = typeof entry?.color === 'string' ? entry.color.trim() : ''
	return {
		color: HEX.test(raw) ? raw.toLowerCase() : '',
		opacity: clampInt(entry?.opacity, 0, 100, 100),
	}
}

/** 归一化悬浮入口位置：必须是两个 0..1 的数，否则回落自动定位。 */
function normalizeSpot(value) {
	if (value === null || value === undefined || typeof value !== 'object') return null
	const x = Number(value.x)
	const y = Number(value.y)
	if (!Number.isFinite(x) || !Number.isFinite(y)) return null
	return { x: Math.min(0.98, Math.max(0.02, x)), y: Math.min(0.98, Math.max(0.02, y)) }
}

/** 归一化一组推荐文字色。 */
function normalizeTextColors(value) {
	const source = value !== null && typeof value === 'object' ? value : {}
	const colors = {}
	for (const role of TEXT_ROLES) colors[role] = normalizeEntry(source[role])
	return colors
}

/**
 * 把任意输入收敛成完整合法的配置：缺字段补默认值，非法颜色丢弃，
 * 未知区域忽略。读写两侧都走这里，坏文件不会带崩界面。
 * @param raw - 已解析的 JSON 值或任意对象。
 * @returns 完整配置。
 */
export function normalizeConfig(raw) {
	const source = raw && typeof raw === 'object' ? raw : {}
	const regions = {}
	for (const region of REGIONS) {
		const entry = source.regions?.[region.key]
		regions[region.key] = {
			light: normalizeEntry(entry?.light),
			dark: normalizeEntry(entry?.dark),
		}
	}
	const text = source.text !== null && typeof source.text === 'object' ? source.text : {}
	// 早期版本用的是布尔开关 text.enabled，这里迁移成三态 mode（老配置视为 custom）。
	const legacyOn = text.enabled === true
	const mode = TEXT_MODES.includes(text.mode) ? text.mode : legacyOn ? 'custom' : 'off'
	return {
		version: CONFIG_VERSION,
		launcher: source.launcher !== false,
		launcherSpot: normalizeSpot(source.launcherSpot),
		text: {
			mode,
			light: normalizeTextColors(text.light),
			dark: normalizeTextColors(text.dark),
		},
		regions,
	}
}

/**
 * 一个区域取值的 CSS 颜色文本，未设置时返回 null。
 * 不透明度 100 直接用十六进制；更低时用 color-mix 与透明混合。
 * @param entry - 归一化后的区域取值。
 * @returns 可直接写入 CSS 的颜色，或 null 表示不覆盖。
 */
export function colorValue(entry) {
	if (!entry?.color || !HEX.test(entry.color)) return null
	if (entry.opacity >= 100) return entry.color
	return `color-mix(in srgb, ${entry.color} ${entry.opacity}%, transparent)`
}

/** 区域就地重绑定的 token 列表；单个 token 也统一成数组。 */
function scopedTokens(region) {
	if (region.scopedVar === undefined) return []
	return Array.isArray(region.scopedVar) ? region.scopedVar : [region.scopedVar]
}

/**
 * 渲染整份配色 CSS。深浅各出一段；未设置的区域不产生任何声明，
 * 因此「全部跟随主题」时输出只有一行注释。每个区域只影响自己那一块：
 * 会话栏只改中列，左栏只改左列，右侧栏只改右列。
 *
 * 推荐文字色开启时，同一段里再补上主/次/三级文字 token（默认关闭时输出与从前逐字节相同）。
 * @param config - 任意配置（内部先归一化）。
 * @returns CSS 文本。
 */
export function renderCss(config) {
	const cfg = normalizeConfig(config)
	const lines = ['/* dsh-theme-colors —— 由 .dsh-theme-colors.json 生成，请勿手工编辑。 */']
	for (const mode of MODES) {
		const selector = SELECTORS[mode.key]
		// 同一选择器下的声明合并到一条规则里：左栏 token + 推荐文字色 token。
		const declarations = []
		for (const region of REGIONS) {
			if (!region.varName) continue
			const value = colorValue(cfg.regions[region.key][mode.key])
			if (value !== null) declarations.push(`${region.varName}:${value}`)
		}
		if (cfg.text.mode !== 'off') {
			for (const role of TEXT_ROLES) {
				const value = colorValue(cfg.text[mode.key][role])
				if (value !== null) declarations.push(`${TEXT_TOKEN_BY_ROLE[role]}:${value}`)
			}
		}
		if (declarations.length > 0) lines.push(`${selector}{${declarations.join(';')}}`)

		for (const region of REGIONS) {
			if (!region.className) continue
			const value = colorValue(cfg.regions[region.key][mode.key])
			if (value === null) continue
			const parts = scopedTokens(region)
				.map((name) => `${name}:${value}`)
				.concat([`background:${value} !important`])
			lines.push(`${selector} [class*="${region.className}"]{${parts.join(';')}}`)
		}
	}
	return lines.join('\n') + '\n'
}

/** 十六进制颜色转 [r,g,b]，非法输入返回 null。 */
export function toRgb(color) {
	if (typeof color !== 'string') return null
	const raw = color.trim()
	if (!HEX.test(raw)) return null
	let hex = raw.slice(1)
	if (hex.length === 3) hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2]
	return [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16)]
}

/**
 * 相对亮度（0 黑，1 白），用于编辑器提示文字明暗是否搭配当前主题。
 * @param color - 十六进制颜色。
 * @returns 0..1 的亮度，非法输入返回 null。
 */
export function luminance(color) {
	const rgb = toRgb(color)
	if (rgb === null) return null
	const [r, g, b] = rgb.map((channel) => {
		const v = channel / 255
		return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
	})
	return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
