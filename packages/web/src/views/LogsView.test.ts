import { createSSRApp, defineComponent, h } from 'vue';
import { renderToString } from '@vue/server-renderer';
import { NMessageProvider } from 'naive-ui';
import { describe, expect, it, vi } from 'vitest';

vi.mock('vue-i18n', () => ({
  useI18n: () => ({ t: (key: string, params?: { count: number }) => params ? `${key} ${params.count}` : key }),
}));
vi.mock('naive-ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('naive-ui')>();
  return {
    ...actual,
    NSelect: defineComponent({
      props: ['value', 'options'],
      setup: (props) => () => h('select', props.options.map((option: { label: string }) => h('option', option.label))),
    }),
  };
});
vi.mock('@/api/config', () => ({ configApi: { getLogs: vi.fn() } }));
vi.mock('@/utils/common', () => ({ formatTimestamp: (value: number) => String(value) }));

import LogsView from './LogsView.vue';

describe('LogsView', () => {
  it('renders the log controls inside the card without a card title', async () => {
    const app = createSSRApp({ render: () => h(NMessageProvider, null, { default: () => h(LogsView) }) });
    const html = await renderToString(app);

    expect(html).toContain('logs.pauseRefresh');
    expect(html).toContain('common.refresh');
    expect(html).toContain('logs.recent 100');
    expect(html).toContain('logs.searchPlaceholder');
  });
});
