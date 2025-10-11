<template>
  <n-config-provider :theme-overrides="themeOverrides">
    <n-message-provider>
      <n-dialog-provider>
        <router-view />
      </n-dialog-provider>
    </n-message-provider>
  </n-config-provider>
</template>

<script setup lang="ts">
import { NConfigProvider, NMessageProvider, NDialogProvider } from 'naive-ui';

const themeOverrides = {
  common: {
    primaryColor: '#0f6b4a',
    primaryColorHover: '#0d5a3e',
    primaryColorPressed: '#0a4830',
    borderRadius: '12px',
    borderColor: 'transparent',
    dividerColor: '#e8e8e8',
    fontFamily: '__Inter_1c856b, __Inter_Fallback_1c856b, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
  },
  Card: {
    borderRadius: '16px',
    borderColor: 'transparent',
    color: '#ffffff',
    boxShadow: '0 1px 3px rgba(0, 0, 0, 0.08)',
    paddingMedium: '20px',
    paddingSmall: '16px',
  },
  Layout: {
    color: '#f5f5f5',
    siderColor: '#f8f8f8',
    headerColor: '#ffffff',
  },
  Menu: {
    itemColorActive: '#0f6b4a',
    itemColorHover: 'rgba(15, 107, 74, 0.08)',
    itemTextColorActive: '#ffffff',
    itemTextColorHover: '#0f6b4a',
    itemIconColorActive: '#ffffff',
    itemIconColorHover: '#0f6b4a',
    borderRadius: '10px',
    itemHeight: '40px',
  },
  Modal: {
    borderRadius: '16px',
    boxShadow: '0 4px 12px rgba(0, 0, 0, 0.15)',
  },
  Input: {
    borderRadius: '10px',
  },
  Button: {
    borderRadius: '10px',
  },
};
</script>

