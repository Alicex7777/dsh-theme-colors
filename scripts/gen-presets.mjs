/**
 * 预设生成器：用 gui.js 里同一份 OKLCH 数学，按「明度 + 彩度 + 色相」目标值反解十六进制。
 * 运行：node scripts/gen-presets.mjs
 *
 * 目标值取法：
 * - 浅色主题：会话栏 L≈0.88、左栏 L≈0.82（够亮仍看得清近黑文字，又有明显色调）
 * - 深色主题：会话栏 L≈0.32、左栏 L≈0.26（比纯黑有层次，接近主流编辑器深色）
 * - 彩度按各色系给绝对 C（不是色域上限的比例），便于控制"像不像那个颜色"
 * 同时打印每个结果的 WCAG 对比度（与官方对应主题的文字色），确保都 ≥ 4.5:1。
 */
const stub = {
	addEventListener() {},
	dispatchEvent() {
		return true
	},
}
const node = () => ({ style: {}, dataset: {}, appendChild() {}, addEventListener() {}, setAttribute() {}, select() {} })
globalThis.window = stub
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
globalThis.fetch = () => Promise.reject(new Error('generator does not use the network'))
globalThis.setInterval = () => 0

await import('../lib/gui.js')
const api = globalThis.window.__dshThemeColors

const THEME_TEXT = api.themeText
const rows = []

/** 色系：名称 + 色相 + 彩度。日间与夜间各自成组。 */
const DAY_FAMILIES = [
	{ name: '米白暖灰', H: 74, C: 0.012 },
	{ name: '青灰清透', H: 186, C: 0.014 },
	{ name: '雾霾蓝', H: 243, C: 0.024 },
	{ name: '天青蓝', H: 215, C: 0.022 },
	{ name: '鼠尾草绿', H: 138, C: 0.020 },
	{ name: '薄荷雾绿', H: 165, C: 0.020 },
	{ name: '藕荷灰紫', H: 302, C: 0.018 },
	{ name: '丁香紫', H: 285, C: 0.020 },
	{ name: '燕麦米', H: 78, C: 0.026 },
	{ name: '灰粉胭脂', H: 16, C: 0.018 },
	{ name: '樱粉', H: 350, C: 0.016 },
	{ name: '蜜桃珊瑚', H: 35, C: 0.024 },
]
const NIGHT_FAMILIES = [
	{ name: '深蓝', H: 255, C: 0.058 },
	{ name: '深青蓝', H: 230, C: 0.035 },
	{ name: '墨绿蓝', H: 200, C: 0.04 },
	{ name: '青灰夜', H: 175, C: 0.02 },
	{ name: '深绿', H: 150, C: 0.048 },
	{ name: '深橄榄', H: 110, C: 0.032 },
	{ name: '暗紫', H: 312, C: 0.034 },
	{ name: '墨蓝紫', H: 285, C: 0.045 },
	{ name: '暗酒红', H: 20, C: 0.04 },
	{ name: '暖褐可可', H: 62, C: 0.022 },
	{ name: '暖黑（低蓝光）', H: 52, C: 0.014, L: 0.28 },
	{ name: '墨黑', H: 260, C: 0.006, L: 0.2 },
	{ name: '石墨黑', H: 250, C: 0.008 },
]

/** 一个色系在某种模式下解出「会话栏 / 左栏」两个色值。 */
function solve(family, modeKey) {
	const isDay = modeKey === 'light'
	const conversationL = family.L !== undefined ? family.L : isDay ? 0.9 : 0.32
	const sidebarL = family.L !== undefined ? family.L - 0.06 : isDay ? 0.85 : 0.26
	const conversation = api.oklchToHex({ L: conversationL, C: family.C, H: family.H })
	const sidebar = api.oklchToHex({ L: sidebarL, C: family.C * (isDay ? 1.15 : 0.85), H: family.H })
	return { conversation, sidebar }
}

/** 打印一组预设（含对比度）。 */
function report(title, families, modeKey) {
	console.log(`\n=== ${title} ===`)
	let worst = Number.POSITIVE_INFINITY
	const text = modeKey === 'light' ? api.themeText.light : api.themeText.dark
	for (const family of families) {
		const solved = solve(family, modeKey)
		const ratio = Math.min(
			api.contrastRatio(text, solved.conversation),
			api.contrastRatio(text, solved.sidebar),
		)
		worst = Math.min(worst, ratio)
		const lch = api.hexToOklch(solved.conversation)
		console.log(
			`  ${family.name.padEnd(16)} ${solved.conversation} / ${solved.sidebar}   ` +
				`(L ${lch.L.toFixed(2)}, C ${lch.C.toFixed(3)}, H ${lch.H.toFixed(0)})  对比度 ${ratio.toFixed(1)}:1`,
		)
	}
	console.log(`  最低对比度 ${worst.toFixed(2)}:1`)
}

report('日间方案（配官方浅色主题）', DAY_FAMILIES, 'light')
report('夜间方案（配官方深色主题）', NIGHT_FAMILIES, 'dark')

console.log('\n=== 可粘贴 ===')
for (const family of DAY_FAMILIES) {
	const solved = solve(family, 'light')
	console.log(`\t\t{ id: 'day-...', name: '${family.name}', colors: { conversation: '${solved.conversation}', sidebar: '${solved.sidebar}' } },`)
}
for (const family of NIGHT_FAMILIES) {
	const solved = solve(family, 'dark')
	console.log(`\t\t{ id: 'night-...', name: '${family.name}', colors: { conversation: '${solved.conversation}', sidebar: '${solved.sidebar}' } },`)
}
