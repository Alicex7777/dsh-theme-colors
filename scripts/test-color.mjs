/**
 * 颜色科学测试：OKLab/OKLCH 换算精度、深度与鲜亮度两个滑杆的行为，
 * 以及"整条滑杆范围内都不掉到 WCAG AA 以下"的可读性保证。
 * 运行：node scripts/test-color.mjs
 */
import assert from 'node:assert/strict'
import { loadThemeColors } from './color-runtime.mjs'

const api = await loadThemeColors()
const { hexToOklch, oklchToHex, maxChroma, deriveScheme, contrastRatio, themeText } = api

/** 逐通道差（0..255）。 */
const channelDelta = (a, b) => {
	const pa = a.slice(1).match(/../g).map((v) => parseInt(v, 16))
	const pb = b.slice(1).match(/../g).map((v) => parseInt(v, 16))
	return Math.max(...pa.map((v, i) => Math.abs(v - pb[i])))
}

// —— 1. Oklab 权威参考值（Björn Ottosson 文中给出的 sRGB 原色换算）——
const red = hexToOklch('#ff0000')
assert.ok(Math.abs(red.L - 0.6279) < 0.002, `红 L=${red.L}`)
assert.ok(Math.abs(red.C - 0.2577) < 0.004, `红 C=${red.C}`)
assert.ok(Math.abs(red.H - 29.23) < 0.5, `红 H=${red.H}`)
const white = hexToOklch('#ffffff')
assert.ok(Math.abs(white.L - 1) < 0.001 && white.C < 0.001, '白应为 L=1、C=0')
const black = hexToOklch('#000000')
assert.ok(black.L < 0.001 && black.C < 0.001, '黑应为 L=0、C=0')
assert.equal(hexToOklch('nope'), null, '非法颜色应返回 null')

// —— 2. 往返精度：hex → OKLCH → hex 基本原样（色域边界色允许 2/255 误差）——
for (const color of ['#ffffff', '#000000', '#808080', '#1d3450', '#e3ddd5', '#ff0000', '#00ff00', '#0000ff', '#b5c7d5']) {
	const back = oklchToHex(hexToOklch(color))
	assert.ok(channelDelta(color, back) <= 2, `${color} 往返后变成 ${back}（差 ${channelDelta(color, back)}/255）`)
}

// —— 3. 色域上限：中性明度下彩度为正、两端为 0，且超过上限会被压回 ——
assert.ok(maxChroma(0.5, 30) > 0.15, 'L=0.5 的红色方向应允许较高彩度')
assert.equal(maxChroma(0, 30), 0)
const impossible = oklchToHex({ L: 0.5, C: 5, H: 30 })
assert.ok(contrastRatio('#ffffff', impossible) > 1, '离谱彩度应被压回色域内而不是溢出')
assert.ok(maxChroma(0.5, 30) >= hexToOklch(impossible).C - 0.002, '压回后的彩度不应超过上限')

// —— 4. 深度滑杆：单调、双向一致，且两端都在可读范围内 ——
const presets = api.dayPresets.map((preset) => ({ preset, modeKey: 'light' })).concat(
	api.nightPresets.map((preset) => ({ preset, modeKey: 'dark' })),
)
for (const { preset, modeKey } of presets) {
	const base = api.presetValues(preset)
	let previousL = Number.POSITIVE_INFINITY
	for (let depth = 0; depth <= 100; depth += 5) {
		const derived = deriveScheme(base, modeKey, depth, 40)
		const lch = hexToOklch(derived.colors.conversation)
		// 索引 100 会因可读性夹紧停在边界，因此只要求"不升"。
		assert.ok(lch.L <= previousL + 0.002, `「${preset.name}」深度 ${depth} 时明度反而升高`)
		previousL = lch.L
	}
	// 明度 → 深度 → 明度 往返一致（滑杆范围外的明度会被钳到端点，按钳制后的期望校验）。
	const endA = api.depthToLightness(modeKey, 0)
	const endB = api.depthToLightness(modeKey, 100)
	const low = Math.min(endA, endB)
	const high = Math.max(endA, endB)
	for (const lchL of [0.02, 0.2, 0.32, 0.5, 0.66, 0.9, 0.98]) {
		const back = api.depthToLightness(modeKey, api.lightnessToDepth(modeKey, lchL))
		const expected = Math.min(high, Math.max(low, lchL))
		assert.ok(Math.abs(back - expected) < 0.01, `深度往返偏差过大：${lchL} → ${back}（期望 ${expected.toFixed(2)}）`)
	}
}

// —— 5. 可读性保证：整条滑杆 × 鲜亮度范围内，三个区域都 ≥ 4.5:1 ——
let worst = Number.POSITIVE_INFINITY
for (const { preset, modeKey } of presets) {
	const base = api.presetValues(preset)
	for (let depth = 0; depth <= 100; depth += 10) {
		for (const vividness of [0, 50, 100]) {
			const { colors } = deriveScheme(base, modeKey, depth, vividness)
			for (const key of api.regionKeys) {
				const ratio = contrastRatio(themeText[modeKey], colors[key])
				worst = Math.min(worst, ratio)
				assert.ok(
					ratio >= 4.5,
					`「${preset.name}」depth=${depth} vividness=${vividness} 的 ${key} 对比度只有 ${ratio.toFixed(2)}:1`,
				)
			}
		}
	}
}
console.log(`color: 滑杆全范围最低对比度 ${worst.toFixed(2)}:1（要求 ≥ 4.5:1）`)

// —— 6. 鲜亮度滑杆：彩度单调上升、色相不变、0 时接近中性 ——
for (const { preset, modeKey } of presets) {
	const base = api.presetValues(preset)
	const hue = hexToOklch(base.conversation).H
	let previousC = -1
	for (const vividness of [0, 25, 50, 75, 100]) {
		const { colors } = deriveScheme(base, modeKey, 50, vividness)
		const lch = hexToOklch(colors.conversation)
		assert.ok(lch.C >= previousC - 0.001, `「${preset.name}」鲜亮度升高但彩度下降`)
		previousC = lch.C
		if (lch.C > 0.01) {
			const delta = Math.min(Math.abs(lch.H - hue), 360 - Math.abs(lch.H - hue))
			// 色相是精确保持的，这里的偏差只来自 8bit 量化：量化步长 ≈0.004 Oklab，
			// 换算成角度就是 0.004/C 弧度。容差按这个量级给，避免把量化误差当成色相漂移。
			const tolerance = Math.min(9, (0.35 / lch.C) * (lch.C > 0.02 ? 1 : 1.5))
			assert.ok(
				delta <= tolerance,
				`「${preset.name}」色相漂移 ${delta.toFixed(1)}°（C=${lch.C.toFixed(3)}，容差 ${tolerance.toFixed(1)}°）`,
			)
		}
	}
	const neutral = hexToOklch(deriveScheme(base, modeKey, 50, 0).colors.conversation)
	assert.ok(neutral.C < 0.002, `鲜亮度 0 时应当是中性灰，实际 C=${neutral.C.toFixed(4)}`)
}

// —— 7. 结构保持：左栏仍比会话栏深，右栏与左栏一致 ——
for (const { preset, modeKey } of presets) {
	const base = api.presetValues(preset)
	const { colors } = deriveScheme(base, modeKey, 40, 60)
	const conversation = hexToOklch(colors.conversation)
	const sidebar = hexToOklch(colors.sidebar)
	assert.ok(sidebar.L < conversation.L, `「${preset.name}」左栏应比会话栏更深`)
	assert.equal(colors.rightbar, colors.sidebar, '右栏应与左栏同色')
}

// —— 8. 夹紧兜底：基准色内部明暗差极大时（左栏比会话栏深得多），仍返回达标色 ——
const hostile = { conversation: '#ffffff', sidebar: '#2b2b2b', rightbar: '#2b2b2b' }
const hostileResult = deriveScheme(hostile, 'light', 0, 100)
assert.equal(hostileResult.clamped, true, '内部明暗差极大的基准色应触发可读性夹紧')
for (const key of api.regionKeys) {
	assert.ok(contrastRatio(themeText.light, hostileResult.colors[key]) >= 4.5, `${key} 夹紧后仍未达标`)
}
// 内置方案在整条滑杆范围内都不需要夹紧——两个端点的取值本身就留了可读余量。
for (const { preset, modeKey } of presets) {
	const base = api.presetValues(preset)
	for (const depth of [0, 50, 100]) {
		for (const vividness of [0, 50, 100]) {
			assert.equal(
				deriveScheme(base, modeKey, depth, vividness).clamped,
				false,
				`「${preset.name}」depth=${depth} vividness=${vividness} 不该触发夹紧`,
			)
		}
	}
}

console.log('color: 全部断言通过')
