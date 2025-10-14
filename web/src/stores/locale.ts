import { defineStore } from 'pinia';
import { ref } from 'vue';

export type Locale = 'zh-CN' | 'en-US';

export const useLocaleStore = defineStore('locale', () => {
  const currentLocale = ref<Locale>((localStorage.getItem('locale') as Locale) || 'zh-CN');

  function setLocale(locale: Locale) {
    currentLocale.value = locale;
    localStorage.setItem('locale', locale);
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

