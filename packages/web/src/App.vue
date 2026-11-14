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
import type { GlobalThemeOverrides } from 'naive-ui'
import { useLoadingStore } from '@/stores/loading'
// 颜色全部来自唯一来源 color-tokens；themeOverrides 内不得再写裸 hex
import { buildNaiveCommonOverrides, brandScale, neutralScale, withAlpha } from '@/styles/color-tokens'

const loadingStore = useLoadingStore()

const themeOverrides: GlobalThemeOverrides = {
  common: {
    // 品牌/语义色全状态（含 Suppl）由 token 源显式给出，naive-ui 2.43 不自动派生
    ...buildNaiveCommonOverrides(),
    borderRadius: '12px',
    fontFamily:
      'MiSans, PingFang SC, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, "Noto Sans", sans-serif'
  },
  Card: {
    borderRadius: '16px',
    borderColor: 'transparent',
    color: neutralScale[0],
    boxShadow: '0 1px 3px rgba(0, 0, 0, 0.08)',
    paddingMedium: '20px',
    paddingSmall: '16px'
  },
  Layout: {
    // Transparent so the body's gradient background shows through the whole layout,
    // instead of a flat patch painted by .n-layout / .n-layout-scroll-container.
    color: 'transparent',
    siderColor: 'transparent',
    headerColor: 'transparent'
  },
  Menu: {
    itemColorActive: withAlpha(brandScale[600], 0.08),
    itemColorHover: withAlpha(brandScale[600], 0.04),
    itemTextColorActive: brandScale[600],
    itemTextColorHover: brandScale[600],
    itemIconColorActive: brandScale[600],
    itemIconColorHover: brandScale[600],
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
