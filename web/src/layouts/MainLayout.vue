<template>
  <n-layout has-sider style="height: 100vh; background-color: #f5f5f5;">
    <n-layout-sider
      :collapsed="false"
      collapse-mode="width"
      :collapsed-width="80"
      :width="260"
      :show-trigger="false"
      style="border-right: none; background-color: #f8f8f8; padding: 16px 12px;"
    >
      <div class="logo">
        <div class="logo-icon">
          <n-icon size="28" color="#0f6b4a">
            <CloudOutline />
          </n-icon>
        </div>
        <span class="logo-text">LLM Gateway</span>
      </div>

      <div class="menu-section-label">{{ t('layout.menu') }}</div>

      <n-menu
        :collapsed="false"
        :collapsed-width="64"
        :collapsed-icon-size="22"
        :options="menuOptions"
        :value="activeKey"
        :default-expanded-keys="defaultExpandedKeys"
        @update:value="handleMenuSelect"
        class="custom-menu"
      />

      <div class="menu-section-label">{{ t('layout.general') }}</div>

      <n-menu
        :collapsed="false"
        :collapsed-width="64"
        :collapsed-icon-size="22"
        :options="generalMenuOptions"
        :value="activeKey"
        @update:value="handleMenuSelect"
        class="custom-menu"
      />
    </n-layout-sider>

    <n-layout style="background-color: #f5f5f5;">
      <n-layout-header style="height: 72px; padding: 0 32px; display: flex; align-items: center; justify-content: flex-end; border-bottom: none; background-color: transparent; margin-bottom: 8px;">
        <div class="header-right">
          <LanguageSwitcher />
          <n-button circle quaternary class="header-icon-btn">
            <template #icon>
              <n-icon size="20"><MailOutline /></n-icon>
            </template>
          </n-button>
          <n-dropdown :options="userOptions" @select="handleUserAction">
            <div class="user-avatar">
              <n-avatar
                round
                size="medium"
                :style="{ backgroundColor: '#0f6b4a' }"
              >
                {{ authStore.user?.username?.charAt(0).toUpperCase() }}
              </n-avatar>
              <div class="user-info">
                <div class="user-name">{{ authStore.user?.username }}</div>
              </div>
            </div>
          </n-dropdown>
        </div>
      </n-layout-header>

      <n-layout-content content-style="padding: 0 32px 32px 32px; background-color: transparent;">
        <router-view />
      </n-layout-content>
    </n-layout>
  </n-layout>
</template>

<script setup lang="ts">
import { computed, h, onMounted } from 'vue';
import { useRouter, useRoute } from 'vue-router';
import { useI18n } from 'vue-i18n';
import {
  NLayout,
  NLayoutSider,
  NLayoutHeader,
  NLayoutContent,
  NMenu,
  NButton,
  NDropdown,
  NIcon,
  NAvatar,
} from 'naive-ui';
import {
  HomeOutline,
  ServerOutline,
  KeyOutline,
  LogOutOutline,
  DocumentTextOutline,
  TerminalOutline,
  CloudOutline,
  CubeOutline,
  MailOutline,
  GitNetworkOutline,
  LayersOutline,
  ConstructOutline,
  ListOutline,
  OptionsOutline,
} from '@vicons/ionicons5';
import { useAuthStore } from '@/stores/auth';
import LanguageSwitcher from '@/components/LanguageSwitcher.vue';

const router = useRouter();
const route = useRoute();
const authStore = useAuthStore();
const { t } = useI18n();

const menuOptions = computed(() => [
  {
    label: t('menu.dashboard'),
    key: 'dashboard',
    icon: () => h(NIcon, null, { default: () => h(HomeOutline) }),
  },
  {
    label: t('menu.modelManagement'),
    key: 'model-management',
    icon: () => h(NIcon, null, { default: () => h(LayersOutline) }),
    children: [
      {
        label: t('menu.providers'),
        key: 'providers',
        icon: () => h(NIcon, null, { default: () => h(ServerOutline) }),
      },
      {
        label: t('menu.models'),
        key: 'models',
        icon: () => h(NIcon, null, { default: () => h(CubeOutline) }),
      },
      {
        label: t('menu.virtualModels'),
        key: 'virtual-models',
        icon: () => h(NIcon, null, { default: () => h(GitNetworkOutline) }),
      },
    ],
  },
  {
    label: t('menu.virtualKeys'),
    key: 'virtual-keys',
    icon: () => h(NIcon, null, { default: () => h(KeyOutline) }),
  },
  {
    label: t('menu.portkeyGateways'),
    key: 'portkey-gateways',
    icon: () => h(NIcon, null, { default: () => h(CloudOutline) }),
  },
  {
    label: t('menu.tools'),
    key: 'tools',
    icon: () => h(NIcon, null, { default: () => h(ConstructOutline) }),
    children: [
      {
        label: t('menu.apiGuide'),
        key: 'api-guide',
        icon: () => h(NIcon, null, { default: () => h(DocumentTextOutline) }),
      },
      {
        label: t('menu.logs'),
        key: 'logs',
        icon: () => h(NIcon, null, { default: () => h(TerminalOutline) }),
      },
      {
        label: t('menu.apiRequests'),
        key: 'api-requests',
        icon: () => h(NIcon, null, { default: () => h(ListOutline) }),
      },
    ],
  },
]);

const defaultExpandedKeys = ['model-management', 'tools'];

const generalMenuOptions = computed(() => [
  {
    label: t('menu.settings'),
    key: 'settings',
    icon: () => h(NIcon, null, { default: () => h(OptionsOutline) }),
  },
]);

const userOptions = computed(() => [
  {
    label: t('common.logout'),
    key: 'logout',
    icon: () => h(NIcon, null, { default: () => h(LogOutOutline) }),
  },
]);

const activeKey = computed(() => {
  const path = route.path.split('/')[1];
  return path || 'dashboard';
});

function handleMenuSelect(key: string) {
  router.push(`/${key}`);
}

function handleUserAction(key: string) {
  if (key === 'logout') {
    authStore.logout();
    router.push('/login');
  }
}

onMounted(async () => {
  if (authStore.token && !authStore.user) {
    await authStore.fetchProfile();
  }
});
</script>

<style scoped>
.logo {
  height: 72px;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 12px;
  margin-bottom: 24px;
  padding: 0 8px;
}

.logo-icon {
  width: 44px;
  height: 44px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: linear-gradient(135deg, #0f6b4a 0%, #0d5a3e 100%);
  border-radius: 12px;
  box-shadow: 0 2px 8px rgba(15, 107, 74, 0.2);
}

.logo-text {
  font-size: 18px;
  font-weight: 600;
  color: #1a1a1a;
  letter-spacing: -0.02em;
}

.menu-section-label {
  font-size: 11px;
  font-weight: 600;
  color: #8c8c8c;
  letter-spacing: 0.05em;
  padding: 16px 12px 8px 12px;
  text-transform: uppercase;
}

.custom-menu {
  padding: 0 8px;
  margin-bottom: 16px;
}

.custom-menu :deep(.n-menu-item) {
  margin-bottom: 4px;
}

.custom-menu :deep(.n-menu-item-content) {
  padding-left: 12px !important;
  border-radius: 8px;
  transition: all 0.2s ease;
}

.custom-menu :deep(.n-submenu-children .n-menu-item-content) {
  padding-left: 30px !important;
}

.custom-menu :deep(.n-menu-item-content:hover) {
  background: rgba(15, 107, 74, 0.06) !important;
}

.custom-menu :deep(.n-menu-item-content--selected) {
  background: rgba(15, 107, 74, 0.08) !important;
  color: #0f6b4a !important;
  box-shadow: none;
}

.custom-menu :deep(.n-menu-item-content--selected .n-menu-item-content__icon) {
  color: #0f6b4a !important;
}

.custom-menu :deep(.n-menu-item-content--selected::before) {
  display: none;
}

.custom-menu :deep(.n-submenu-children) {
  padding-left: 0 !important;
}

.header-title {
  font-size: 24px;
  font-weight: 600;
  color: #1a1a1a;
  letter-spacing: -0.02em;
}

.header-right {
  display: flex;
  align-items: center;
  gap: 12px;
}

.header-icon-btn {
  width: 40px;
  height: 40px;
  color: #595959;
}

.header-icon-btn:hover {
  background-color: rgba(0, 0, 0, 0.04);
}

.user-avatar {
  display: flex;
  align-items: center;
  gap: 12px;
  cursor: pointer;
  padding: 4px 12px 4px 4px;
  border-radius: 24px;
  transition: background-color 0.2s;
}

.user-avatar:hover {
  background-color: rgba(0, 0, 0, 0.04);
}

.user-info {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.user-name {
  font-size: 14px;
  font-weight: 500;
  color: #1a1a1a;
  line-height: 1.2;
}

.user-email {
  font-size: 12px;
  color: #8c8c8c;
  line-height: 1.2;
}
</style>

