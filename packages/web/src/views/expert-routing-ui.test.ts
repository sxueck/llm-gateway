import { createSSRApp, h } from 'vue';
import { fileURLToPath } from 'node:url';
import { renderToString } from 'vue/server-renderer';
import { createI18n } from 'vue-i18n';
import { darkTheme, NConfigProvider, NMessageProvider } from 'naive-ui';
import { describe, expect, it } from 'vitest';
import { resolveConfig } from 'vite';
import { setup as setupCssSsr } from '@css-render/vue3-ssr';
import TierModelCard from '../components/TierModelCard.vue';
import SessionPolicyForm from '../components/SessionPolicyForm.vue';
import RoutingLogTable from '../components/RoutingLogTable.vue';
import ExpertRoutingStatistics from '../components/ExpertRoutingStatistics.vue';
import zhCN from '../i18n/locales/zh-CN';
import enUS from '../i18n/locales/en-US';

async function renderCard(locale = 'zh-CN', dark = false, first = true, last = false) {
  const app = createSSRApp({
    render: () => h(NConfigProvider, { theme: dark ? darkTheme : null }, {
      default: () => h(TierModelCard, {
        expert: { id: 'candidate-1', band: 'low', type: 'real', provider_id: 'provider', model: 'model' },
        label: 'A long model name',
        priority: 1,
        first,
        last,
      }),
    }),
  });
  app.use(createI18n({ legacy: false, locale, messages: { 'zh-CN': zhCN, 'en-US': enUS } }));
  return renderToString(app);
}

describe('tiered routing UI', () => {
  it('shows model identity and priority without duplicating the column band', async () => {
    const html = await renderCard();
    expect(html).toContain('A long model name');
    expect(html).toContain('实际模型');
    expect(html).toContain('provider / model');
    expect(html).toContain('优先级 1');
    expect(html).not.toContain('低档');
    expect(html).toContain('aria-label="上移"');
    expect(html).toContain('title="移除"');
  });

  it('keeps reorder boundaries disabled and localizes English actions', async () => {
    const html = await renderCard('en-US', false, true, true);
    expect(html).toContain('Priority 1');
    expect(html).toContain('aria-label="Move up"');
    expect(html).toContain('aria-label="Move down"');
    expect(html.match(/<button[^>]* disabled(?: |>|=)/g)).toHaveLength(2);
  });

  it('uses theme surfaces instead of forcing white model cards in dark mode', async () => {
    const light = await renderCard();
    const dark = await renderCard('zh-CN', true);
    const cardStyle = (html: string) => html.match(/class="tier-model-card" style="([^"]+)"/)?.[1];
    expect(cardStyle(light)).toBeTruthy();
    expect(cardStyle(dark)).toBeTruthy();
    expect(cardStyle(light)).not.toEqual(cardStyle(dark));
  });

  it('keeps the selected session mode description alongside its controls', async () => {
    const app = createSSRApp({
      render: () => h(SessionPolicyForm, {
        policy: { mode: 'sticky', idle_ttl_seconds: 86400, absolute_ttl_seconds: 604800 },
      }),
    });
    app.use(createI18n({ legacy: false, locale: 'zh-CN', messages: { 'zh-CN': zhCN } }));
    const html = await renderToString(app);
    expect(html).toContain('判决方式');
    expect(html).toContain('首个请求选定档位后绑定会话');
    expect(html).toContain('value="24"');
    expect(html).toContain('value="7"');
  });

  it.each([RoutingLogTable, ExpertRoutingStatistics])('renders one localized empty log state without pagination', async (component) => {
    const app = createSSRApp({
      render: () => h(NConfigProvider, {}, {
        default: () => h(NMessageProvider, {}, {
          default: () => h(component, { configId: 'preview' }),
        }),
      }),
    });
    app.use(createI18n({ legacy: false, locale: 'zh-CN', messages: { 'zh-CN': zhCN } }));
    setupCssSsr(app);
    const html = await renderToString(app);
    expect(html.match(/暂无路由日志/g)).toHaveLength(1);
    expect(html).not.toContain('expertRouting.band');
    expect(html).not.toContain('No Data');
    expect(html).not.toMatch(/class="[^"]*\bn-pagination\b/);
  });

  it('resolves production assets from the root even on nested detail URLs', async () => {
    const config = await resolveConfig({ configFile: fileURLToPath(new URL('../../vite.config.ts', import.meta.url)) }, 'build');
    expect(config.base).toBe('/');
    const url = new URL(`${config.base}assets/index.js`, 'https://example.com/expert-routing/config-id');
    expect(url.pathname).toBe('/assets/index.js');
  });
});
