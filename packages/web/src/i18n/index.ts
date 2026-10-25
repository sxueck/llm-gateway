import { createI18n } from 'vue-i18n';
import zhCN from './locales/zh-CN';
import enUS from './locales/en-US';

export type AppLocale = 'zh-CN' | 'en-US';

export function resolveLocale(value: string | null): AppLocale {
  return value === 'en-US' ? 'en-US' : 'zh-CN';
}

const i18n = createI18n({
  legacy: false,
  locale: resolveLocale(localStorage.getItem('locale')),
  fallbackLocale: 'zh-CN',
  messages: {
    'zh-CN': zhCN,
    'en-US': enUS,
  },
});

export default i18n;

