/**
 * 文字色预设的校验/生成器：把候选取值对**全部方案表面**逐一验算对比度，
 * 并检查"同色相"预设的彩度是否真的看得见（避免又做成近黑近白）。
 * 运行：node scripts/gen-text-presets.mjs
 */
import { loadThemeColors } from './color-runtime.mjs'

const api = await loadThemeColors()
const roles = api.textRoles
const targets = api.textTargets

/** 候选文字色预设：每个含浅色面用的三档与深色面用的三档（主 / 次 / 三级）。 */
const CANDIDATES = {
	暖墨: { light: ['#2a231c', '#4a4036', '#6b5f52'], dark: ['#ece5db', '#c4b8a8', '#9d9184'] },
	冷墨: { light: ['#1b2029', '#3a4250', '#5a6373'], dark: ['#e2e7ef', '#b6bfcc', '#8c96a4'] },
	中性灰墨: { light: ['#262626', '#454545', '#666666'], dark: ['#e8e8e8', '#bdbdbd', '#949494'] },
	纯黑纯白: { light: ['#000000', '#333333', '#555555'], dark: ['#ffffff', '#cccccc', '#a3a3a3'] },
}

const surfacesByMode = {
	light: api.dayPresets.map((preset) => api.presetValues(preset)),
	dark: api.nightPresets.map((preset) => api.presetValues(preset)),
}

console.log('预设        最低对比度   约束命中情况（要求 主≥7 / 次≥4.5 / 三级≥3）')
for (const [name, set] of Object.entries(CANDIDATES)) {
	const perRole = []
	let worstOverall = Number.POSITIVE_INFINITY
	for (let i = 0; i < roles.length; i += 1) {
		let worstRole = Number.POSITIVE_INFINITY
		for (const modeKey of ['light', 'dark']) {
			const color = set[modeKey][i]
			for (const scheme of surfacesByMode[modeKey]) {
				for (const key of api.regionKeys) {
					worstRole = Math.min(worstRole, api.contrastRatio(color, scheme[key]))
				}
			}
		}
		perRole.push(`${roles[i]} ${worstRole.toFixed(1)}${worstRole >= targets[roles[i]] ? '✓' : '✗'}`)
		worstOverall = Math.min(worstOverall, worstRole)
	}
	console.log(`${name.padEnd(10)} ${worstOverall.toFixed(2)}:1   ${perRole.join('  ')}   C(浅/深) ${api.hexToOklch(set.light[0]).C.toFixed(3)} / ${api.hexToOklch(set.dark[0]).C.toFixed(3)}`)
}

console.log('\n推荐色 / 同色相（按当前方案表面色相推导，绝对彩度目标）——验证"看得见"：')
for (const [label, preset, modeKey] of [
	['日间 米白暖灰', api.dayPresets[0], 'light'],
	['日间 雾霾蓝', api.dayPresets[2], 'light'],
	['日间 燕麦米', api.dayPresets.find((p) => p.id === 'day-oat'), 'light'],
	['夜间 深蓝', api.nightPresets[0], 'dark'],
	['夜间 深绿', api.nightPresets.find((p) => p.id === 'night-pine'), 'dark'],
	['夜间 暗酒红', api.nightPresets.find((p) => p.id === 'night-wine'), 'dark'],
]) {
	const scheme = api.presetValues(preset)
	const tinted = api.deriveTintedTextColorsFor(scheme, modeKey)
	const surface = api.hexToOklch(scheme.conversation)
	const primary = api.hexToOklch(tinted.primary)
	const secondary = api.hexToOklch(tinted.secondary)
	console.log(
		`${label.padEnd(10)} 表面 ${scheme.conversation} (H ${surface.H.toFixed(0).padStart(3)} / C ${surface.C.toFixed(3)}) → ` +
			`主 ${tinted.primary} (C ${primary.C.toFixed(3)}, H ${primary.H.toFixed(0)})  次 ${tinted.secondary} (C ${secondary.C.toFixed(3)})  ` +
			`对比度 ${api.contrastRatio(tinted.primary, scheme.conversation).toFixed(1)}:1`,
	)
}
