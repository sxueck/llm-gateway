import { createSSRApp, h } from 'vue';
import { renderToString } from 'vue/server-renderer';
import { describe, expect, it } from 'vitest';

import Divider from './Divider.vue';
import { Divider as DividerFromIndex } from './index';

// 覆盖迁移前 NDivider 在本仓库的全部用法形态：
// 裸用法、内联 style 覆盖间距、class 透传（form-section / my-4）、
// 默认插槽标题（居中默认 + title-placement left/right + 富内容插槽）。
function renderDivider(props: Record<string, unknown> = {}, slot?: () => unknown) {
  const app = createSSRApp({
    render: () => h(Divider, props, slot === undefined ? undefined : { default: slot }),
  });
  return renderToString(app);
}

function count(haystack: string, needle: string) {
  return haystack.split(needle).length - 1;
}

function classOf(html: string, marker: string) {
  // SSR 输出中 class 属性位于 data-slot 之后：<div data-slot="…" class="…">
  const at = html.indexOf(marker);
  const start = html.indexOf('class="', at);
  return html.slice(start + 7, html.indexOf('"', start + 7));
}

describe('ui Divider (NDivider replacement)', () => {
  it('renders a bare horizontal separator with the NDivider default 24px spacing', async () => {
    const html = await renderDivider();
    expect(html).toContain('role="separator"');
    expect(html).toContain('data-slot="divider"');
    // 默认上下 24px，与 NDivider 一致（WorkerPluginsView/BackupView 的裸用法依赖）
    expect(html).toContain('margin-top:24px');
    expect(html).toContain('margin-bottom:24px');
    expect(count(html, 'data-slot="divider-line"')).toBe(1);
    expect(html).not.toContain('data-slot="divider-title"');
    expect(classOf(html, 'data-slot="divider-line"')).toContain('bg-border');
  });

  it('lets a caller inline style override the default spacing (margin: 4px 0)', async () => {
    const html = await renderDivider({ style: 'margin: 4px 0' });
    const compact = html.replace(/\s+/g, '');
    // 合并后的行内样式中，使用处的 margin 简写须排在组件默认长写之后才能生效
    expect(compact.indexOf('margin:4px0')).toBeGreaterThan(compact.indexOf('margin-bottom:24px'));
  });

  it('passes custom classes through while keeping the default margins', async () => {
    // 与迁移前一致：form-section / my-4 这类 class 不改动默认 24px 间距
    for (const klass of ['form-section', 'my-4']) {
      const html = await renderDivider({ class: klass });
      expect(classOf(html, 'data-slot="divider"')).toContain(klass);
      expect(html).toContain('margin-top:24px');
      expect(html).toContain('margin-bottom:24px');
    }
  });

  it('renders slot content as a centered title between two lines', async () => {
    const html = await renderDivider({}, () => 'Section title');
    expect(count(html, 'data-slot="divider-line"')).toBe(2);
    expect(html).toContain('Section title');
    expect(html).toContain('data-slot="divider-title"');
    const firstLine = html.indexOf('data-slot="divider-line"');
    const title = html.indexOf('data-slot="divider-title"');
    const secondLine = html.indexOf('data-slot="divider-line"', title);
    expect(title).toBeGreaterThan(firstLine);
    expect(secondLine).toBeGreaterThan(title);
    // 标题两侧线均分（居中），标题左右 12px、字重 500
    expect(classOf(html, 'data-slot="divider-title"')).toContain('mx-3');
    expect(classOf(html, 'data-slot="divider-title"')).toContain('font-medium');
    expect(classOf(html, 'data-slot="divider-title"')).not.toContain('w-7');
  });

  it('docks the title left with a fixed 28px lead line (title-placement="left")', async () => {
    const html = await renderDivider({ 'title-placement': 'left' }, () => 'Basic');
    const title = html.indexOf('data-slot="divider-title"');
    const lead = classOf(html.slice(0, title), 'data-slot="divider-line"');
    const tail = classOf(html.slice(title), 'data-slot="divider-line"');
    expect(lead).toContain('w-7');
    expect(lead).toContain('grow-0');
    expect(tail).toContain('grow');
    expect(tail).not.toContain('w-7');
  });

  it('docks the title right with a fixed 28px tail line', async () => {
    const html = await renderDivider({ titlePlacement: 'right' }, () => 'Meta');
    const title = html.indexOf('data-slot="divider-title"');
    expect(classOf(html.slice(0, title), 'data-slot="divider-line"')).not.toContain('w-7');
    expect(classOf(html.slice(title), 'data-slot="divider-line"')).toContain('w-7');
  });

  it('renders rich slot content (spaces + buttons) inside the title', async () => {
    const html = await renderDivider({}, () => h('span', { class: 'title-inner' }, 'Attributes'));
    expect(html).toContain('title-inner');
    expect(html).toContain('Attributes');
  });

  it('supports the dashed and vertical NDivider props for drop-in parity', async () => {
    const dashed = await renderDivider({ dashed: true }, () => 'Dashed');
    expect(dashed).toContain('border-dashed');
    expect(dashed).toContain('border-border');

    const vertical = await renderDivider({ vertical: true }, () => 'ignored');
    expect(vertical).toContain('role="separator"');
    expect(vertical).toContain('inline-block');
    expect(vertical).toContain('w-px');
    expect(vertical).toContain('mx-2');
    // 竖向忽略标题与横向线，与 NDivider 行为一致
    expect(vertical).not.toContain('data-slot="divider-line"');
    expect(vertical).not.toContain('ignored');
  });

  it('re-exports Divider from the barrel index', () => {
    expect(DividerFromIndex).toBe(Divider);
  });
});
