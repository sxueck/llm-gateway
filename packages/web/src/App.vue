<template>
  <n-config-provider
    :theme-overrides="themeOverrides"
    inline-theme-disabled
    preflight-style-disabled
  >
    <n-message-provider>
      <n-dialog-provider>
        <n-spin
          :show="loadingStore.routeLoading"
          size="large"
          class="route-loading"
          :stroke-width="18"
        >
          <router-view />
        </n-spin>
      </n-dialog-provider>
    </n-message-provider>
  </n-config-provider>
</template>

<script setup lang="ts">
import { NConfigProvider, NMessageProvider, NDialogProvider, NSpin } from 'naive-ui'
import { useLoadingStore } from '@/stores/loading'

const loadingStore = useLoadingStore()

const themeOverrides = {
  common: {
    primaryColor: '#0f6b4a',
    primaryColorHover: '#0d5a3e',
    primaryColorPressed: '#0a4830',
    borderRadius: '12px',
    borderColor: '#dcdcdc',
    dividerColor: '#e8e8e8',
    fontFamily:
      'MiSans, PingFang SC, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, "Noto Sans", sans-serif'
  },
  Card: {
    borderRadius: '16px',
    borderColor: 'transparent',
    color: '#ffffff',
    boxShadow: '0 1px 3px rgba(0, 0, 0, 0.08)',
    paddingMedium: '20px',
    paddingSmall: '16px'
  },
  Layout: {
    // Transparent so the body's gradient background shows through the whole layout,
    // instead of a flat #f5f5f5 patch painted by .n-layout / .n-layout-scroll-container.
    color: 'transparent',
    siderColor: 'transparent',
    headerColor: 'transparent'
  },
  Menu: {
    itemColorActive: 'rgba(15, 107, 74, 0.08)',
    itemColorHover: 'rgba(15, 107, 74, 0.04)',
    itemTextColorActive: '#0f6b4a',
    itemTextColorHover: '#0f6b4a',
    itemIconColorActive: '#0f6b4a',
    itemIconColorHover: '#0f6b4a',
    borderRadius: '10px',
    itemHeight: '40px'
  },
  Modal: {
    borderRadius: '16px',
    boxShadow: '0 4px 12px rgba(0, 0, 0, 0.15)'
  },
  Input: {
    borderRadius: '10px'
  },
  Button: {
    borderRadius: '10px'
  }
}
</script>

<style scoped>
.route-loading {
  /* 路由懒加载期间内容为空,容器高度会塌缩为 0,spinner 会贴到视口顶部;
     撑满一屏让 spinner 落在视口中央。 */
  min-height: 100vh;
}

.route-loading :deep(.n-spin-content) {
  opacity: 1;
}

.route-loading :deep(.n-spin-mask) {
  background-color: rgba(255, 255, 255, 0.6);
  backdrop-filter: blur(2px);
}
</style>
