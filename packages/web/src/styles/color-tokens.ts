/**
 * 前端颜色唯一来源（single source of truth）。
 *
 * 消费关系（由 color-tokens.test.ts 逐条锁定）：
 * - `packages/web/src/style.css` 的 `:root`：本模块的 CSS 镜像，全部 `--color-*`
 *   声明必须与 `cssColorVars` 一致（改色值必须先改这里）。
 * - `packages/web/src/styles/shadcn.css` 的 `:root`：只允许通过 `var(--color-*)`
 *   引用上面的镜像，不得再写裸 hex。
 * - `App.vue` 的 naive-ui themeOverrides：通过 `buildNaiveCommonOverrides()` 消费。
 *   naive-ui 2.43 不会从 seed 自动派生 hover/pressed/suppl，各状态必须显式传入。
 * - Canvas/ECharts 等拿不到 CSS 变量的场景直接 import 本模块的 JS 色值
 *   （见 `CHART_LINE_COLORS` / `chartPalette`）。
 *
 * 本文件全部为纯常量与纯函数，不访问 DOM，SSR 与单测环境安全。
 *
 * 色阶方法：品牌 50–900 与中性灰在 OKLCH 空间生成——L 单调递减、彩度克制、
 * 色相锚定绿色系；600/700/900 三步钉死为既有品牌 hex（#0f6b4a / #006241 / #1e3932），
 * 不参与插值。交互状态色规则：hover 比 base 深（L − 0.05）、pressed 更深（L − 0.10），
 * 每降一步彩度同步下调 0.005（OKLCH 降彩度递进）；disabled 提亮至 L ≈ 0.82–0.86
 * 且彩度压至 base 的 ~30%（naive-ui 自身走 opacityDisabled 半透明）。
 */

import type { GlobalThemeOverrides } from 'naive-ui'

// ---------------------------------------------------------------------------
// OKLCH ↔ sRGB 转换（Björn Ottosson 的 OKLab 公式；通道超出 sRGB 色域时钳制）
// ---------------------------------------------------------------------------

export interface Oklch {
  /** 明度 0–1 */
  L: number
  /** 彩度（约 0–0.4，本项目刻意压低） */
  C: number
  /** 色相角 0–360 */
  H: number
}

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value))

export function hexToRgb(hex: string): [number, number, number] {
  const value = hex.replace('#', '')
  if (!/^[0-9a-fA-F]{6}$/.test(value)) {
    throw new Error(`color-tokens: 期望 6 位 hex，收到 ${hex}`)
  }
  return [
    parseInt(value.slice(0, 2), 16),
    parseInt(value.slice(2, 4), 16),
    parseInt(value.slice(4, 6), 16)
  ]
}

const toHexChannel = (channel: number): string =>
  Math.round(clamp(channel, 0, 255))
    .toString(16)
    .padStart(2, '0')

export function rgbToHex(r: number, g: number, b: number): string {
  return `#${toHexChannel(r)}${toHexChannel(g)}${toHexChannel(b)}`
}

const srgbToLinear = (channel: number): number => {
  const c = channel / 255
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
}

const linearToSrgb = (c: number): number =>
  255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055)

export function hexToOklch(hex: string): Oklch {
  const [r, g, b] = hexToRgb(hex).map(srgbToLinear)
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s
  const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s
  const b2 = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s
  const C = Math.sqrt(a * a + b2 * b2)
  let H = (Math.atan2(b2, a) * 180) / Math.PI
  if (H < 0) H += 360
  return { L, C, H }
}

export function oklchToHex(L: number, C: number, H: number): string {
  const rad = (H * Math.PI) / 180
  const a = C * Math.cos(rad)
  const b = Math.sin(rad) * C
  const lRoot = L + 0.3963377774 * a + 0.2158037573 * b
  const mRoot = L - 0.1055613458 * a - 0.0638541728 * b
  const sRoot = L - 0.0894841775 * a - 1.291485548 * b
  const l = lRoot * lRoot * lRoot
  const m = mRoot * mRoot * mRoot
  const s = sRoot * sRoot * sRoot
  const r = linearToSrgb(
    clamp(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, 0, 1)
  )
  const g = linearToSrgb(
    clamp(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, 0, 1)
  )
  const b2 = linearToSrgb(
    clamp(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s, 0, 1)
  )
  return rgbToHex(r, g, b2)
}

/** Canvas/naive 主题用的 rgba 字符串（与 DashboardView 既有格式一致：逗号后带空格）。 */
export function withAlpha(hex: string, alpha: number): string {
  const [r, g, b] = hexToRgb(hex)
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

/** WCAG 2.x 相对亮度与对比度（1.4.3 / 1.4.11 核算用）。 */
export function relativeLuminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex).map(srgbToLinear)
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a)
  const lb = relativeLuminance(b)
  const hi = Math.max(la, lb)
  const lo = Math.min(la, lb)
  return (hi + 0.05) / (lo + 0.05)
}

// ---------------------------------------------------------------------------
// 品牌色阶 50–900（OKLCH 生成，克制渐变）
// ---------------------------------------------------------------------------

/** 既有品牌锚点：主色（600）、深绿（700）、墨绿标题色（900）。 */
export const BRAND_ANCHORS = {
  primary: '#0f6b4a',
  deep: '#006241',
  ink: '#1e3932'
} as const

export const BRAND_SCALE_STEPS = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900] as const
export type BrandStep = (typeof BRAND_SCALE_STEPS)[number]

/**
 * 各步 OKLCH 生成参数（测试会验证 `oklchToHex(spec) === 字面量` 的生成保真）。
 * 锚点步 600/700/900 不在表内；800 在 700（H 161.7）与 900（H 175.4）之间线性过渡。
 */
export const BRAND_OKLCH_SPEC: Readonly<
  Record<Exclude<BrandStep, 600 | 700 | 900>, Oklch>
> = {
  50: { L: 0.975, C: 0.012, H: 162.0 },
  100: { L: 0.945, C: 0.018, H: 162.0 },
  200: { L: 0.9, C: 0.026, H: 162.0 },
  300: { L: 0.845, C: 0.034, H: 162.0 },
  400: { L: 0.75, C: 0.05, H: 162.2 },
  500: { L: 0.62, C: 0.07, H: 162.4 },
  800: { L: 0.38, C: 0.07, H: 168.6 }
}

export const brandScale: Readonly<Record<BrandStep, string>> = {
  50: '#f0f9f4',
  100: '#e3f1e9',
  200: '#d0e4d9',
  300: '#b9d3c5',
  400: '#92b8a4',
  500: '#5e947a',
  600: BRAND_ANCHORS.primary,
  700: BRAND_ANCHORS.deep,
  800: '#0e4e3c',
  900: BRAND_ANCHORS.ink
}

// ---------------------------------------------------------------------------
// 绿调中性灰 0–950（OKLCH 生成，色相 ~160°，彩度 ≤ 0.018 的克制绿味）
// ---------------------------------------------------------------------------

export const NEUTRAL_SCALE_STEPS = [0, 50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950] as const
export type NeutralStep = (typeof NEUTRAL_SCALE_STEPS)[number]

/** 0 步为纯白（卡片表面基色），不参与 OKLCH 生成。 */
export const NEUTRAL_OKLCH_SPEC: Readonly<Record<Exclude<NeutralStep, 0>, Oklch>> = {
  50: { L: 0.983, C: 0.004, H: 160 },
  100: { L: 0.96, C: 0.006, H: 160 },
  200: { L: 0.925, C: 0.008, H: 160 },
  300: { L: 0.885, C: 0.009, H: 160 },
  400: { L: 0.8, C: 0.01, H: 160 },
  500: { L: 0.64, C: 0.01, H: 160 },
  600: { L: 0.55, C: 0.011, H: 160 },
  700: { L: 0.46, C: 0.012, H: 160 },
  800: { L: 0.33, C: 0.014, H: 160 },
  900: { L: 0.24, C: 0.016, H: 160 },
  950: { L: 0.18, C: 0.018, H: 160 }
}

export const neutralScale: Readonly<Record<NeutralStep, string>> = {
  0: '#ffffff',
  50: '#f7faf8',
  100: '#eef3f0',
  200: '#e2e8e4',
  300: '#d4dbd7',
  400: '#b8c0bb',
  500: '#878e8a',
  600: '#6c746f',
  700: '#535a56',
  800: '#2f3833',
  900: '#19221d',
  950: '#0a140f'
}

// ---------------------------------------------------------------------------
// 语义交互色：base / hover / pressed / disabled / suppl
// ---------------------------------------------------------------------------

export interface StatefulColor {
  /** 常态 */
  base: string
  /** 悬停：比 base 深（OKLCH L − 0.03 左右） */
  hover: string
  /** 按下：比 hover 更深（OKLCH L − 0.06 左右） */
  pressed: string
  /** 禁用：提亮并降彩度至 base 的 ~30%（naive-ui 自身走 opacityDisabled 半透明） */
  disabled: string
  /** naive-ui Suppl 补充色：沿用 naive 默认约定 = hover */
  suppl: string
}

/** 主交互色。hover/pressed 保留上线既有值（视觉零回归），disabled 由 OKLCH 派生。 */
export const primaryColor: StatefulColor = {
  base: brandScale[600],
  hover: '#0d5a3e',
  pressed: '#0a4830',
  disabled: '#7a8f84',
  suppl: '#0d5a3e'
}

/**
 * 语义四色（低饱和、非荧光，OKLCH 降彩度递进派生）。
 * 对白底对比度（WCAG 2.x，测试逐条锁定 ≥ 4.5；白字压在这些色上同样达标）：
 * - success  #337344 5.71:1 / hover #276438 7.08 / pressed #1b552c 8.81
 * - info     #3e6596 5.99:1 / hover #335784 7.40 / pressed #284972 9.19
 * - warning  #804d0c 7.04:1 / hover #704000 8.67 / pressed #5f3300 10.71
 * - error    #92413d 6.89:1 / hover #803531 8.50 / pressed #6e2826 10.53
 */
export const successColor: StatefulColor = {
  base: '#337344',
  hover: '#276438',
  pressed: '#1b552c',
  disabled: '#b7caba',
  suppl: '#276438'
}

export const infoColor: StatefulColor = {
  base: '#3e6596',
  hover: '#335784',
  pressed: '#284972',
  disabled: '#c0ccdb',
  suppl: '#335784'
}

export const warningColor: StatefulColor = {
  base: '#804d0c',
  hover: '#704000',
  pressed: '#5f3300',
  disabled: '#dfcdbd',
  suppl: '#704000'
}

export const errorColor: StatefulColor = {
  base: '#92413d',
  hover: '#803531',
  pressed: '#6e2826',
  disabled: '#dec4c1',
  suppl: '#803531'
}

export const statefulColors = {
  primary: primaryColor,
  success: successColor,
  info: infoColor,
  warning: warningColor,
  error: errorColor
} as const

export type StatefulColorName = keyof typeof statefulColors

/** naive-ui 禁用态由透明度实现（commonLight.opacityDisabled 默认 0.5），显式钉住。 */
export const DISABLED_OPACITY = '0.5'

// ---------------------------------------------------------------------------
// CSS custom property 镜像（style.css :root 的唯一权威清单）
// ---------------------------------------------------------------------------

function scaleVars(
  prefix: 'brand' | 'neutral',
  scale: Readonly<Record<number, string>>
): Record<string, string> {
  const vars: Record<string, string> = {}
  for (const step of Object.keys(scale)) {
    vars[`--color-${prefix}-${step}`] = scale[Number(step)]
  }
  return vars
}

function statefulVars(name: StatefulColorName, color: StatefulColor): Record<string, string> {
  return {
    [`--color-${name}`]: color.base,
    [`--color-${name}-hover`]: color.hover,
    [`--color-${name}-pressed`]: color.pressed,
    [`--color-${name}-disabled`]: color.disabled
  }
}

/**
 * `style.css :root` 必须逐条声明的 `--color-*` 清单（值必须一致；允许
 * `var(--color-brand-600)` 这类指向清单内其它键的别名引用，由测试解析比对）。
 * `--color-text` / `--color-border` 是既有业务代码里带 fallback 的引用，
 * 在此补齐定义后从 fallback 切换到统一 token。
 */
export const cssColorVars: Readonly<Record<string, string>> = {
  ...scaleVars('brand', brandScale),
  ...scaleVars('neutral', neutralScale),
  ...statefulVars('primary', primaryColor),
  ...statefulVars('success', successColor),
  ...statefulVars('info', infoColor),
  ...statefulVars('warning', warningColor),
  ...statefulVars('error', errorColor),
  '--color-title': brandScale[900],
  '--color-text': neutralScale[800],
  '--color-border': neutralScale[300]
}

// ---------------------------------------------------------------------------
// naive-ui themeOverrides（App.vue 消费）
// ---------------------------------------------------------------------------

function semanticOverrides(
  naivePrefix: 'success' | 'info' | 'warning' | 'error',
  color: StatefulColor
): Record<string, string> {
  return {
    [`${naivePrefix}Color`]: color.base,
    [`${naivePrefix}ColorHover`]: color.hover,
    [`${naivePrefix}ColorPressed`]: color.pressed,
    [`${naivePrefix}ColorSuppl`]: color.suppl
  }
}

/**
 * naive-ui common 主题的颜色覆盖。naive-ui 2.43 的 use-theme 只做浅合并，
 * 不从 seed 派生任何状态色，因此 5 组语义色 × base/hover/pressed/suppl
 * 全部显式给出；非颜色项（圆角、字体等）留在 App.vue。
 */
export function buildNaiveCommonOverrides(): NonNullable<GlobalThemeOverrides['common']> {
  return {
    primaryColor: primaryColor.base,
    primaryColorHover: primaryColor.hover,
    primaryColorPressed: primaryColor.pressed,
    primaryColorSuppl: primaryColor.suppl,
    ...semanticOverrides('success', successColor),
    ...semanticOverrides('info', infoColor),
    ...semanticOverrides('warning', warningColor),
    ...semanticOverrides('error', errorColor),
    borderColor: neutralScale[300],
    dividerColor: neutralScale[200],
    opacityDisabled: DISABLED_OPACITY
  }
}

// ---------------------------------------------------------------------------
// Canvas / ECharts 真实 JS 色值（CSS 变量在 Canvas 中不可用）
// ---------------------------------------------------------------------------

/** Dashboard 折线图 8 色盘，保持既有视觉（台账 .pi/color-audit.md 记录的例外）。 */
export const CHART_LINE_COLORS = [
  '#006241',
  '#C4996C',
  '#1E3932',
  '#2D8A6D',
  '#A89F91',
  '#6CA68D',
  '#4A4A4A',
  '#D4E9E2'
] as const

export type ChartLineColor = (typeof CHART_LINE_COLORS)[number]

/** 与 DashboardView.COLOR_PALETTE 既有渐变字面量逐字节一致。 */
export function chartGradient(line: string): readonly [string, string] {
  return [withAlpha(line, 0.4), withAlpha(line, 0.05)]
}

export interface ChartPaletteEntry {
  line: string
  gradient: readonly [string, string]
}

export const chartPalette: readonly ChartPaletteEntry[] = CHART_LINE_COLORS.map((line) => ({
  line,
  gradient: chartGradient(line)
}))
