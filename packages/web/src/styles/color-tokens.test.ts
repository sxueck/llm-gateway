import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { commonLight } from 'naive-ui';

import {
  BRAND_ANCHORS,
  BRAND_OKLCH_SPEC,
  BRAND_SCALE_STEPS,
  CHART_LINE_COLORS,
  DISABLED_OPACITY,
  NEUTRAL_OKLCH_SPEC,
  NEUTRAL_SCALE_STEPS,
  brandScale,
  buildNaiveCommonOverrides,
  chartGradient,
  chartPalette,
  contrastRatio,
  cssColorVars,
  hexToOklch,
  neutralScale,
  oklchToHex,
  statefulColors
} from './color-tokens';

// 一致性断言直接读取源文件文本（SSR/单测安全，不依赖任何挂载的 DOM）。
const here = dirname(fileURLToPath(import.meta.url));
const readSource = (relative: string) => readFileSync(join(here, relative), 'utf8');

const HEX_RE = /^#[0-9a-f]{6}$/;

function extractRootBlock(css: string): string {
  const match = /:root\s*\{([^}]*)\}/.exec(css);
  if (!match) throw new Error('color-tokens test: :root block not found');
  return match[1];
}

function parseDeclarations(block: string): Record<string, string> {
  const withoutComments = block.replace(/\/\*[\s\S]*?\*\//g, '');
  const declarations: Record<string, string> = {};
  for (const match of withoutComments.matchAll(/(--[a-zA-Z0-9-]+)\s*:\s*([^;]+);/g)) {
    declarations[match[1]] = match[2].trim();
  }
  return declarations;
}

/** 解析（至多一跳）`var(--x)` 别名；要求终点必须是同一 :root 内的字面量。 */
function resolveValue(raw: string, declarations: Record<string, string>): string {
  const alias = /^var\((--[a-zA-Z0-9-]+)\)$/.exec(raw);
  if (!alias) return raw;
  const target = declarations[alias[1]];
  if (target === undefined) throw new Error(`color-tokens test: 悬空引用 ${raw}`);
  if (/^var\(/.test(target)) throw new Error(`color-tokens test: 禁止多级跳转 ${raw}`);
  return target;
}

describe('color-tokens 品牌色阶 50–900', () => {
  it('600/700/900 三步钉死既有品牌锚点 hex', () => {
    expect(brandScale[600]).toBe(BRAND_ANCHORS.primary);
    expect(brandScale[600]).toBe('#0f6b4a');
    expect(brandScale[700]).toBe(BRAND_ANCHORS.deep);
    expect(brandScale[700]).toBe('#006241');
    expect(brandScale[900]).toBe(BRAND_ANCHORS.ink);
    expect(brandScale[900]).toBe('#1e3932');
  });

  it('非锚点步与 OKLCH 生成参数逐字节一致（生成保真）', () => {
    for (const [step, spec] of Object.entries(BRAND_OKLCH_SPEC)) {
      expect(oklchToHex(spec.L, spec.C, spec.H)).toBe(brandScale[Number(step) as 50 | 100 | 200 | 300 | 400 | 500 | 800]);
    }
  });

  it('全部为 6 位 hex，明度单调递减且步距 ≥ 0.02', () => {
    const steps = BRAND_SCALE_STEPS.map((step) => hexToOklch(brandScale[step]).L);
    for (const step of BRAND_SCALE_STEPS) expect(brandScale[step]).toMatch(HEX_RE);
    for (let i = 1; i < steps.length; i++) {
      expect(steps[i - 1] - steps[i]).toBeGreaterThanOrEqual(0.02);
    }
  });

  it('彩度克制（≤ 0.1），色相保持绿色系（155°–180°）', () => {
    for (const step of BRAND_SCALE_STEPS) {
      const { C, H } = hexToOklch(brandScale[step]);
      expect(C).toBeLessThanOrEqual(0.1);
      expect(H).toBeGreaterThanOrEqual(155);
      expect(H).toBeLessThanOrEqual(180);
    }
  });
});

describe('color-tokens 绿调中性灰 0–950', () => {
  it('0 步为纯白（表面基色），其余与 OKLCH 生成参数一致', () => {
    expect(neutralScale[0]).toBe('#ffffff');
    for (const [step, spec] of Object.entries(NEUTRAL_OKLCH_SPEC)) {
      expect(oklchToHex(spec.L, spec.C, spec.H)).toBe(neutralScale[Number(step) as 50 | 100 | 200 | 300 | 400 | 500 | 600 | 700 | 800 | 900 | 950]);
    }
  });

  it('明度单调递减且步距 ≥ 0.015，绿味克制（C ≤ 0.025，H 150°–170°）', () => {
    const steps = NEUTRAL_SCALE_STEPS.map((step) => hexToOklch(neutralScale[step]).L);
    for (let i = 1; i < steps.length; i++) {
      expect(steps[i - 1] - steps[i]).toBeGreaterThanOrEqual(0.015);
    }
    for (const step of NEUTRAL_SCALE_STEPS) {
      const { C, H } = hexToOklch(neutralScale[step]);
      expect(C).toBeLessThanOrEqual(0.025);
      // 无彩色（纯白，C ≈ 0）的色相角无意义，不参与色相带检查
      if (C < 0.001) continue;
      expect(H).toBeGreaterThanOrEqual(150);
      expect(H).toBeLessThanOrEqual(170);
    }
  });
});

describe('color-tokens 语义色四态', () => {
  const families = Object.entries(statefulColors) as Array<
    [keyof typeof statefulColors, (typeof statefulColors)[keyof typeof statefulColors]]
  >;

  it('primary/success/info/warning/error 均提供 base/hover/pressed/disabled/suppl 且为 6 位 hex', () => {
    expect(families.map(([name]) => name)).toEqual(['primary', 'success', 'info', 'warning', 'error']);
    for (const [, color] of families) {
      for (const state of ['base', 'hover', 'pressed', 'disabled', 'suppl'] as const) {
        expect(color[state]).toMatch(HEX_RE);
      }
    }
  });

  it('按压加深：L(base) > L(hover) > L(pressed)；禁用提亮且彩度降至 base 的 40% 以下', () => {
    for (const [name, color] of families) {
      const base = hexToOklch(color.base);
      const hover = hexToOklch(color.hover);
      const pressed = hexToOklch(color.pressed);
      const disabled = hexToOklch(color.disabled);
      expect(base.L - hover.L, `${name} hover 应比 base 深`).toBeGreaterThan(0.01);
      expect(hover.L - pressed.L, `${name} pressed 应比 hover 深`).toBeGreaterThan(0.01);
      expect(disabled.L - base.L, `${name} disabled 应比 base 亮`).toBeGreaterThan(0.05);
      expect(disabled.C, `${name} disabled 彩度过高`).toBeLessThanOrEqual(base.C * 0.4);
    }
  });

  it('suppl 沿用 naive 默认约定 = hover', () => {
    for (const [name, color] of families) {
      expect(color.suppl, name).toBe(color.hover);
    }
  });

  it('低饱和非荧光：语义四色彩度 C ≤ 0.115（设计值 0.11，含 hex 取整容差），且 base 逐级向 hover/pressed 降彩度', () => {
    for (const [name, color] of families) {
      const base = hexToOklch(color.base);
      const hover = hexToOklch(color.hover);
      const pressed = hexToOklch(color.pressed);
      expect(base.C, `${name} base 彩度过高`).toBeLessThanOrEqual(0.115);
      expect(hover.C, `${name} hover 应较 base 降彩度`).toBeLessThan(base.C);
      expect(pressed.C, `${name} pressed 应较 hover 降彩度`).toBeLessThan(hover.C);
    }
  });

  it('WCAG 对比度：品牌锚点与正文灰达标', () => {
    expect(contrastRatio(brandScale[600], neutralScale[0])).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(brandScale[700], neutralScale[0])).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(brandScale[900], neutralScale[0])).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(neutralScale[900], neutralScale[0])).toBeGreaterThanOrEqual(7);
    expect(contrastRatio(neutralScale[500], neutralScale[0])).toBeGreaterThanOrEqual(3);
    // 交互加深后对比度只升不降
    for (const [name, color] of families) {
      const baseRatio = contrastRatio(color.base, neutralScale[0]);
      expect(contrastRatio(color.hover, neutralScale[0]), name).toBeGreaterThanOrEqual(baseRatio);
      expect(contrastRatio(color.pressed, neutralScale[0]), name).toBeGreaterThanOrEqual(baseRatio);
    }
    // 语义四色全部为适度深色：对白底（即作普通文字色）与压白字均 ≥ 4.5:1
    for (const name of ['success', 'info', 'warning', 'error'] as const) {
      expect(contrastRatio(statefulColors[name].base, neutralScale[0]), name).toBeGreaterThanOrEqual(4.5);
    }
  });
});

describe('color-tokens ↔ style.css :root 镜像一致性', () => {
  const styleCss = readSource('../style.css');
  const declared = parseDeclarations(extractRootBlock(styleCss));

  it('style.css :root 的每个 --color-* 都在 cssColorVars 清单中（无孤儿）', () => {
    for (const name of Object.keys(declared)) {
      if (!name.startsWith('--color-')) continue;
      expect(cssColorVars, name).toHaveProperty(name);
    }
  });

  it('cssColorVars 的每个变量都被声明且值一致（var() 别名解析一跳）', () => {
    for (const [name, expected] of Object.entries(cssColorVars)) {
      expect(declared, `style.css 缺少 ${name}`).toHaveProperty(name);
      expect(resolveValue(declared[name], declared), name).toBe(expected);
    }
  });

  it('别名引用（如 --color-primary: var(--color-brand-600)）指向清单内字面量', () => {
    for (const [name, raw] of Object.entries(declared)) {
      if (!/^var\(/.test(raw)) continue;
      expect(resolveValue(raw, declared), name).toMatch(HEX_RE);
    }
  });
});

describe('shadcn.css :root 从同一源引用且跳过 preflight', () => {
  const shadcnCss = readSource('./shadcn.css');
  const declared = parseDeclarations(extractRootBlock(shadcnCss));
  const styleDeclared = parseDeclarations(extractRootBlock(readSource('../style.css')));

  it('全部颜色 token 均为对共享 --color-* 源的单跳 var() 引用，映射符合设计', () => {
    const expected: Record<string, string> = {
      '--background': '--color-neutral-0',
      '--foreground': '--color-neutral-900',
      '--card': '--color-neutral-0',
      '--card-foreground': '--color-neutral-900',
      '--primary': '--color-brand-600',
      '--primary-foreground': '--color-neutral-0',
      '--secondary': '--color-neutral-100',
      '--secondary-foreground': '--color-neutral-900',
      '--muted': '--color-neutral-50',
      '--muted-foreground': '--color-neutral-700',
      '--accent': '--color-neutral-100',
      '--accent-foreground': '--color-neutral-900',
      '--destructive': '--color-error',
      '--destructive-foreground': '--color-neutral-0',
      '--border': '--color-neutral-200',
      '--input': '--color-neutral-200',
      '--ring': '--color-brand-600'
    };
    expect(Object.keys(declared).sort()).toEqual([...Object.keys(expected), '--radius'].sort());
    for (const [name, sourceVar] of Object.entries(expected)) {
      expect(declared[name], name).toBe(`var(${sourceVar})`);
      // 引用必须在 style.css 的共享源中真实存在
      expect(styleDeclared, `${name} 引用的 ${sourceVar}`).toHaveProperty(sourceVar);
      expect(cssColorVars[sourceVar], sourceVar).toBeDefined();
    }
  });

  it(':root 中除 --radius 外不再出现裸 hex', () => {
    for (const [name, value] of Object.entries(declared)) {
      if (name === '--radius') continue;
      expect(value, name).not.toMatch(/#[0-9a-fA-F]{3,8}/);
    }
  });

  it('只引入 theme + utilities 两层，preflight 保持跳过', () => {
    expect(shadcnCss).toContain('@import "tailwindcss/theme.css" layer(theme)');
    expect(shadcnCss).toContain('@import "tailwindcss/utilities.css" layer(utilities)');
    expect(shadcnCss).toContain('@layer theme, base, components, utilities');
    // 只检查 @import 语句本身（文件头注释会提到 preflight，属于说明而非引入）
    const imports = [...shadcnCss.matchAll(/@import\s+(["'][^"']+["'])/g)].map((m) => m[1]);
    expect(imports).toEqual(['"tailwindcss/theme.css"', '"tailwindcss/utilities.css"']);
  });
});

describe('naive-ui themeOverrides 状态覆盖', () => {
  const overrides = buildNaiveCommonOverrides();

  it('所有键都是 naive-ui commonLight 的合法变量名（防拼写被静默忽略）', () => {
    expect(Object.keys(overrides).length).toBeGreaterThan(0);
    for (const key of Object.keys(overrides)) {
      expect(commonLight, key).toHaveProperty(key);
    }
  });

  it('五组语义色 base/hover/pressed/suppl 全部显式给出', () => {
    const families: Record<'primary' | 'success' | 'info' | 'warning' | 'error', string> = {
      primary: 'primary',
      success: 'success',
      info: 'info',
      warning: 'warning',
      error: 'error'
    };
    // 动态键检查需要索引视图；值均为字符串
    const overridesAsRecord = overrides as unknown as Record<string, string>;
    for (const [prefix, key] of Object.entries(families)) {
      const color = statefulColors[key as keyof typeof statefulColors];
      expect(overridesAsRecord[`${prefix}Color`], prefix).toBe(color.base);
      expect(overridesAsRecord[`${prefix}ColorHover`], prefix).toBe(color.hover);
      expect(overridesAsRecord[`${prefix}ColorPressed`], prefix).toBe(color.pressed);
      expect(overridesAsRecord[`${prefix}ColorSuppl`], prefix).toBe(color.suppl);
    }
  });

  it('边框/分隔线取绿调中性灰，禁用透明度显式钉住', () => {
    expect(overrides.borderColor).toBe(neutralScale[300]);
    expect(overrides.dividerColor).toBe(neutralScale[200]);
    expect(overrides.opacityDisabled).toBe(DISABLED_OPACITY);
    expect(overrides.opacityDisabled).toBe('0.5');
  });
});

describe('Canvas/ECharts 真实 JS 色值', () => {
  it('8 色盘与台账基线一致，且与 DashboardView 未迁移的 COLOR_PALETTE 字面量逐字节对齐', () => {
    const dashboardSource = readSource('../views/DashboardView.vue');
    expect([...CHART_LINE_COLORS]).toEqual([
      '#006241',
      '#C4996C',
      '#1E3932',
      '#2D8A6D',
      '#A89F91',
      '#6CA68D',
      '#4A4A4A',
      '#D4E9E2'
    ]);
    expect(chartPalette).toHaveLength(8);
    for (const entry of chartPalette) {
      expect(dashboardSource, entry.line).toContain(`line: '${entry.line}'`);
      expect(dashboardSource).toContain(`'${entry.gradient[0]}'`);
      expect(dashboardSource).toContain(`'${entry.gradient[1]}'`);
    }
  });

  it('chartGradient 输出格式与既有 rgba 字面量一致', () => {
    expect(chartGradient('#006241')).toEqual(['rgba(0, 98, 65, 0.4)', 'rgba(0, 98, 65, 0.05)']);
    expect(chartGradient('#D4E9E2')).toEqual(['rgba(212, 233, 226, 0.4)', 'rgba(212, 233, 226, 0.05)']);
  });
});

describe('App.vue themeOverrides 消费唯一来源', () => {
  const appVue = readSource('../App.vue');
  const scriptStart = appVue.indexOf('<script setup lang="ts">');
  const scriptEnd = appVue.indexOf('</script>');
  const scriptBody = appVue.slice(scriptStart, scriptEnd);
  // 历史注释里允许提及旧 hex（如 Layout 的 #f5f5f5 说明），只约束实际代码
  const scriptCode = scriptBody.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  it('script setup 展开使用 buildNaiveCommonOverrides，不再出现裸 hex', () => {
    expect(scriptStart).toBeGreaterThanOrEqual(0);
    expect(scriptCode).toContain('...buildNaiveCommonOverrides()');
    expect(scriptCode).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });

  it('Menu 高亮色由品牌 600 派生 rgba，与迁移前字面量一致', () => {
    expect(scriptCode).toContain('withAlpha(brandScale[600], 0.08)');
    expect(scriptCode).toContain('withAlpha(brandScale[600], 0.04)');
  });
});
