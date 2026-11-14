import { createSSRApp, h } from 'vue';
import { renderToString } from 'vue/server-renderer';
import { describe, expect, it } from 'vitest';

import Empty from './Empty.vue';
import { Empty as EmptyFromIndex, emptyVariants } from './index';

// 覆盖迁移前 NEmpty 在本仓库的全部用法形态：
// 裸用法（description + 默认图标）、show-icon=false、size="small"、
// class 透传、内联 style、#extra 插槽、默认插槽覆盖描述、#icon 插槽覆盖图标。
function renderEmpty(
  props: Record<string, unknown> = {},
  slots: { default?: () => unknown; icon?: () => unknown; extra?: () => unknown } = {},
) {
  const app = createSSRApp({
    render: () => h(Empty, props, slots),
  });
  return renderToString(app);
}

describe('ui Empty (NEmpty replacement)', () => {
  it('exports from index and exposes cva variants', () => {
    expect(EmptyFromIndex).toBe(Empty);
    expect(emptyVariants({ size: 'small' })).toContain('flex');
    expect(emptyVariants()).toContain('text-sm'); // medium 默认
  });

  it('renders description with default icon (accessible decorative icon)', async () => {
    const html = await renderEmpty({ description: '暂无数据' });
    expect(html).toContain('data-slot="empty"');
    expect(html).toContain('data-slot="empty-icon"');
    expect(html).toContain('aria-hidden="true"'); // 装饰图标对读屏隐藏
    expect(html).toContain('data-slot="empty-description"');
    expect(html).toContain('暂无数据');
    expect(html).toContain('data-slot="empty"');
  });

  it('hides the icon when show-icon is false (DashboardView 用法)', async () => {
    const html = await renderEmpty({ description: 'no data', showIcon: false });
    expect(html).not.toContain('data-slot="empty-icon"');
    expect(html).toContain('data-slot="empty-description"');
  });

  it('renders the extra action slot below the description (VirtualModelsView 用法)', async () => {
    const html = await renderEmpty(
      { description: 'empty' },
      { extra: () => h('button', { type: 'button' }, '创建第一个') },
    );
    expect(html.indexOf('data-slot="empty-description"')).toBeGreaterThan(-1);
    expect(html).toContain('data-slot="empty-extra"');
    expect(html).toContain('创建第一个');
    // extra 在描述之后
    expect(html.indexOf('data-slot="empty-extra"')).toBeGreaterThan(
      html.indexOf('data-slot="empty-description"'),
    );
  });

  it('supports the default slot overriding the description (NEmpty 语义)', async () => {
    const html = await renderEmpty(
      { description: 'prop-desc' },
      { default: () => 'slot-desc' },
    );
    expect(html).toContain('slot-desc');
    expect(html).not.toContain('prop-desc');
  });

  it('supports a custom icon via the icon slot', async () => {
    const html = await renderEmpty(
      { description: 'x' },
      { icon: () => h('span', ' ICON ') },
    );
    expect(html).toContain('data-slot="empty-icon"');
    expect(html).toContain('ICON');
  });

  it('applies size variants (small shrinks icon and text)', async () => {
    const small = await renderEmpty({ description: 'x', size: 'small' });
    const medium = await renderEmpty({ description: 'x' });
    expect(small).toContain('text-xs');
    expect(medium).toContain('text-sm');
    expect(small).toContain('text-[28px]');
    expect(medium).toContain('text-[36px]');
  });

  it('forwards class and inline style to the root (padding 用法)', async () => {
    const html = await renderEmpty({
      description: 'x',
      class: 'chat-empty',
      style: 'padding: 48px 0',
    });
    expect(html).toContain('chat-empty');
    expect(html).toContain('padding:48px 0');
  });

  it('renders nothing for description when neither prop nor slot given', async () => {
    const html = await renderEmpty();
    expect(html).toContain('data-slot="empty-icon"');
    expect(html).not.toContain('data-slot="empty-description"');
    expect(html).not.toContain('data-slot="empty-extra"');
  });
});
