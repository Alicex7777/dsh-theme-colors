/**
 * palette.js 单测：配置归一化与 CSS 生成。
 * 运行：node scripts/test-palette.mjs
 */
import assert from 'node:assert/strict'
import { REGIONS, REGION_KEYS, colorValue, defaultConfig, luminance, normalizeConfig, renderCss } from '../lib/palette.js'

const empty = defaultConfig()
for (const region of REGIONS) {
	assert.deepEqual(empty.regions[region.key].light, { color: '', opacity: 100 })
	assert.deepEqual(empty.regions[region.key].dark, { color: '', opacity: 100 })
}
// 只有三个区域：会话栏、左侧会话列表栏、右侧栏（「页面背景」已移除）。
assert.deepEqual(REGION_KEYS, ['conversation', 'sidebar', 'rightbar'])
assert.deepEqual(Object.keys(empty.regions), REGION_KEYS)

// 默认配置不产生任何覆盖声明。
const emptyCss = renderCss(empty)
assert.equal(emptyCss.trim().split('\n').length, 1, '默认配置应只有一行注释')
assert.ok(!emptyCss.includes('--dsw-alias-bg-base'), '默认配置不应改写 token')

// 非法颜色与非数值透明度被丢弃 / 回落；已删除的旧字段被忽略。
const dirty = normalizeConfig({
	launcher: false,
	regions: {
		background: { light: { color: '#ffffff', opacity: 100 } },
		sidebar: { light: { color: 'red', opacity: 'x' }, dark: { color: '#ABCDEF', opacity: 140 } },
		conversation: { light: { color: '#abc', opacity: 50.6 } },
		unknown: { light: { color: '#ffffff' } },
	},
})
assert.equal(dirty.launcher, false)
assert.equal(dirty.regions.background, undefined, '旧配置里的「页面背景」应被忽略')
assert.equal(dirty.regions.unknown, undefined, '未知区域应被忽略')
assert.deepEqual(dirty.regions.sidebar.light, { color: '', opacity: 100 })
assert.deepEqual(dirty.regions.sidebar.dark, { color: '#abcdef', opacity: 100 })
assert.deepEqual(dirty.regions.conversation.light, { color: '#abc', opacity: 51 })
assert.equal(dirty.regions.conversation.dark.color, '')

// 悬浮入口位置：默认自动（null），非法值回落，越界夹紧。
assert.equal(defaultConfig().launcherSpot, null)
assert.equal(dirty.launcherSpot, null)
assert.equal(normalizeConfig({ launcherSpot: { x: 'a', y: 1 } }).launcherSpot, null)
assert.equal(normalizeConfig({ launcherSpot: 'nope' }).launcherSpot, null)
assert.deepEqual(normalizeConfig({ launcherSpot: { x: -1, y: 5 } }).launcherSpot, { x: 0.02, y: 0.98 })
assert.deepEqual(normalizeConfig({ launcherSpot: { x: 0.25, y: 0.5 } }).launcherSpot, { x: 0.25, y: 0.5 })

// 左栏走 token，列区域走类名片段选择器；两边互不牵连。
const css = renderCss(dirty)
assert.ok(
	css.includes('body[data-ds-dark-theme][data-ds-dark-theme]{--dsw-specific-sidebar-fill:#abcdef}'),
	'深色左栏未写入 token（选择器需提升权重压过主题声明）',
)
// 会话栏必须就地重绑定 token：中列本身透明，栏内会话根元素会用自己的 bg-base 盖住背景色。
assert.ok(
	css.includes('body:not([data-ds-dark-theme]) [class*="centerCol"]{--dsw-alias-bg-base:color-mix(in srgb, #abc 51%, transparent);background:color-mix(in srgb, #abc 51%, transparent) !important}'),
	'会话栏规则未同时重绑定 token 与背景色',
)
assert.ok(!css.includes('backgroundColor'), '不应出现 JS 风格属性名')
assert.equal(css.includes('rightbarCol'), false, '未设置的右侧栏不应产生规则')

// 左侧栏走 token；右侧栏要在列内同时重绑定 base 与 layer-1（面板各页签自己铺底色）。
const filled = normalizeConfig({ regions: { sidebar: { light: { color: '#123456', opacity: 100 } }, rightbar: { dark: { color: '#654321' } } } })
const filledCss = renderCss(filled)
assert.ok(filledCss.includes('--dsw-specific-sidebar-fill:#123456'), '左侧栏未走 token')
assert.ok(
	filledCss.includes(
		'body[data-ds-dark-theme][data-ds-dark-theme] [class*="rightbarCol"]{--dsw-alias-bg-base:#654321;--dsw-alias-bg-layer-1:#654321;background:#654321 !important}',
	),
	'右侧栏规则缺失或未重绑定面板所用的两个 token',
)

// 区域之间互不牵连：只设会话栏时，输出里只有中列那一条规则。
const solo = renderCss(normalizeConfig({ regions: { conversation: { light: { color: '#010203' } } } }))
const soloRules = solo.split('\n').filter((line) => line.trim() !== '' && line.indexOf('/*') !== 0)
assert.equal(soloRules.length, 1, `只设会话栏时应只有一条规则，实际：${soloRules.join(' | ')}`)
assert.ok(soloRules[0].includes('centerCol'))
assert.equal(solo.includes('sidebarCol'), false)
assert.equal(solo.includes('rightbarCol'), false)
assert.equal(solo.includes('body:not([data-ds-dark-theme]){'), false, '不再有全局底色规则')

// 两套主题各自独立成规则。
const both = renderCss(normalizeConfig({ regions: { sidebar: { light: { color: '#111111' }, dark: { color: '#222222' } } } }))
assert.ok(both.includes('body:not([data-ds-dark-theme]){--dsw-specific-sidebar-fill:#111111}'))
assert.ok(both.includes('body[data-ds-dark-theme][data-ds-dark-theme]{--dsw-specific-sidebar-fill:#222222}'))

// colorValue 边界。
assert.equal(colorValue({ color: '', opacity: 100 }), null)
assert.equal(colorValue({ color: '#ffffff', opacity: 100 }), '#ffffff')
assert.equal(colorValue({ color: '#ffffff', opacity: 0 }), 'color-mix(in srgb, #ffffff 0%, transparent)')

// 亮度：黑 0、白 1、非法 null。
assert.equal(luminance('#000'), 0)
assert.equal(luminance('#ffffff'), 1)
assert.equal(luminance('nope'), null)
assert.ok(luminance('#101010') < 0.02)

console.log('palette: 全部断言通过')
