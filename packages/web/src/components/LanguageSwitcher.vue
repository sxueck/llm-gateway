<template>
  <n-dropdown :options="languageOptions" @select="handleLanguageSelect">
    <n-button circle quaternary class="language-btn">
      <template #icon>
        <n-icon size="20">
          <LanguageOutline />
        </n-icon>
      </template>
    </n-button>
  </n-dropdown>
</template>

<script setup lang="ts">
import { h, computed } from 'vue';
import { NButton, NDropdown, NIcon } from 'naive-ui';
import { LanguageOutline, CheckmarkOutline } from '@vicons/ionicons5';
import { useI18n } from 'vue-i18n';
import { useLocaleStore, type Locale } from '@/stores/locale';

const { locale } = useI18n();
const localeStore = useLocaleStore();

const languageOptions = computed(() => [
  {
    label: '简体中文',
    key: 'zh-CN',
    icon: localeStore.currentLocale === 'zh-CN' 
      ? () => h(NIcon, null, { default: () => h(CheckmarkOutline) })
      : undefined,
  },
  {
    label: 'English',
    key: 'en-US',
    icon: localeStore.currentLocale === 'en-US'
      ? () => h(NIcon, null, { default: () => h(CheckmarkOutline) })
      : undefined,
  },
]);

function handleLanguageSelect(key: string) {
  const newLocale = key as Locale;
  localeStore.setLocale(newLocale);
  locale.value = newLocale;
}
</script>

<style scoped>
.language-btn {
  width: 40px;
  height: 40px;
  color: #595959;
}

.language-btn:hover {
  background-color: rgba(0, 0, 0, 0.04);
}
</style>

