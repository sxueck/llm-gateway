import { defineStore } from 'pinia';
import { ref } from 'vue';
import i18n, { resolveLocale, type AppLocale } from '@/i18n';

export type Locale = AppLocale;

export const useLocaleStore = defineStore('locale', () => {
  const currentLocale = ref<Locale>(resolveLocale(localStorage.getItem('locale')));

  function setLocale(locale: Locale) {
    currentLocale.value = locale;
    localStorage.setItem('locale', locale);
    i18n.global.locale.value = locale;
  }

  function toggleLocale() {
    const newLocale = currentLocale.value === 'zh-CN' ? 'en-US' : 'zh-CN';
    setLocale(newLocale);
  }

  return {
    currentLocale,
    setLocale,
    toggleLocale,
  };
});

