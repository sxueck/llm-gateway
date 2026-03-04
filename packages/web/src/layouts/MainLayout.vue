<template>
  <n-layout has-sider class="app-layout">
    <n-layout-sider
      :collapsed="collapsed"
      collapse-mode="width"
      :collapsed-width="80"
      :width="260"
      :show-trigger="false"
      class="app-sider"
    >
      <div class="logo" :class="{ 'logo-collapsed': collapsed }">
        <div class="logo-icon">
          <img src="/assets/logo.png" alt="LLM Gateway" class="logo-image" />
        </div>
        <span v-if="!collapsed" class="logo-text">LLM Gateway</span>
      </div>

      <div v-if="!collapsed" class="menu-section-label">{{ t('layout.menu') }}</div>

      <n-menu
        :collapsed="collapsed"
        :collapsed-width="64"
        :collapsed-icon-size="22"
        :options="menuOptions"
        :value="activeKey"
        :default-expanded-keys="defaultExpandedKeys"
        @update:value="handleMenuSelect"
        class="custom-menu"
      />

      <div v-if="!collapsed" class="menu-section-label">{{ t('layout.general') }}</div>

      <n-menu
        :collapsed="collapsed"
        :collapsed-width="64"
        :collapsed-icon-size="22"
        :options="generalMenuOptions"
        :value="activeKey"
        @update:value="handleMenuSelect"
        class="custom-menu"
      />
    </n-layout-sider>

    <n-layout class="app-main-layout" :native-scrollbar="false">
      <n-layout-header class="app-header">
        <div class="header-left">
          <n-button circle quaternary @click="toggleSidebar">
            <template #icon>
              <n-icon size="24"><MenuOutline /></n-icon>
            </template>
          </n-button>
        </div>
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

      <n-layout-content content-style="padding: 8px 32px 32px 32px; background-color: transparent;">
        <router-view />
      </n-layout-content>
    </n-layout>
  </n-layout>
</template>

<script setup lang="ts">
import { computed, h, onMounted, ref, onUnmounted } from 'vue';
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
  CubeOutline,
  MailOutline,
  GitNetworkOutline,
  LayersOutline,
  ConstructOutline,
  ListOutline,
  OptionsOutline,
  FlaskOutline,
  GitBranchOutline,
  ShieldOutline,
  CloudDownloadOutline,
  CashOutline,
  MenuOutline,
} from '@vicons/ionicons5';
import { useAuthStore } from '@/stores/auth';
import LanguageSwitcher from '@/components/LanguageSwitcher.vue';

const router = useRouter();
const route = useRoute();
const authStore = useAuthStore();
const { t } = useI18n();

const collapsed = ref(false);
const windowWidth = ref(window.innerWidth);
const windowHeight = ref(window.innerHeight);

const toggleSidebar = () => {
  collapsed.value = !collapsed.value;
};

const isShortScreen = computed(() => windowHeight.value < 800);

const handleResize = () => {
  windowWidth.value = window.innerWidth;
  windowHeight.value = window.innerHeight;
  if (windowWidth.value < 768) {
    collapsed.value = true;
  } else {
    collapsed.value = false;
  }
};

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
    label: t('menu.experimentalFeatures'),
    key: 'experimental-features',
    icon: () => h(NIcon, null, { default: () => h(FlaskOutline) }),
    children: [
      {
        label: t('menu.expertRouting'),
        key: 'expert-routing',
        icon: () => h(NIcon, null, { default: () => h(GitBranchOutline) }),
      },
      {
        label: t('menu.costAnalysis'),
        key: 'cost-analysis',
        icon: () => h(NIcon, null, { default: () => h(CashOutline) }),
      },
    ],
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

const defaultExpandedKeys = computed(() => {
  // 小屏幕时只展开核心菜单，折叠实验性功能与系统设置
  if (isShortScreen.value) {
    return ['model-management', 'tools'];
  }
  return ['model-management', 'tools', 'settings', 'experimental-features'];
});

const generalMenuOptions = computed(() => [
  {
    label: t('menu.settings'),
    key: 'settings',
    icon: () => h(NIcon, null, { default: () => h(OptionsOutline) }),
    children: [
      {
        label: t('settings.general'),
        key: 'settings',
        icon: () => h(NIcon, null, { default: () => h(OptionsOutline) }),
      },
      {
        label: t('settings.security'),
        key: 'security-settings',
        icon: () => h(NIcon, null, { default: () => h(ShieldOutline) }),
      },
      {
        label: t('settings.backup'),
        key: 'backup',
        icon: () => h(NIcon, null, { default: () => h(CloudDownloadOutline) }),
      },
      {
        label: t('settings.developerDebug'),
        key: 'developer-settings',
        icon: () => h(NIcon, null, { default: () => h(FlaskOutline) }),
      },
    ],
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
  window.addEventListener('resize', handleResize);
  handleResize(); // Initial check
});

onUnmounted(() => {
  window.removeEventListener('resize', handleResize);
});
</script>

<style scoped>
.app-layout {
  height: 100vh;
  overflow: hidden; /* 布局容器本身不滚动，滚动统一交给内容区域 */
  background-color: #f5f5f5;
}

.app-sider {
  border-right: none;
  background-color: rgba(248, 248, 248, 0.85);
  padding: 16px 12px;
  margin: 16px;
  border-radius: 20px;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.08), 0 2px 8px rgba(0, 0, 0, 0.04);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  z-index: 100;
  height: calc(100vh - 32px);
  overflow-y: auto;
  overflow-x: hidden;
}

/* 细滚动条样式 */
.app-sider::-webkit-scrollbar {
  width: 4px;
}

.app-sider::-webkit-scrollbar-track {
  background: transparent;
}

.app-sider::-webkit-scrollbar-thumb {
  background-color: rgba(0, 0, 0, 0.1);
  border-radius: 4px;
}

.app-sider:hover::-webkit-scrollbar-thumb {
  background-color: rgba(0, 0, 0, 0.2);
}

.app-main-layout {
  background-color: #f5f5f5;
  height: 100vh;
}

.app-header {
  height: 72px;
  padding: 0 32px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  border-bottom: none;
  background-color: transparent;
}

.logo-image {
  width: 38px;
  height: 38px;
  object-fit: contain;
}

.logo {
  height: 72px;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 12px;
  margin-bottom: 24px;
  padding: 0 8px;
  transition: all 0.3s ease;
}

.logo-collapsed {
  padding: 0;
  justify-content: center;
}

.logo-icon {
  width: 44px;
  height: 44px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 12px;
}

.logo-text {
  font-size: 20px;
  font-weight: 600;
  color: #1a1a1a;
  letter-spacing: -0.02em;
  user-select: none;
  -webkit-user-select: none;
}

.menu-section-label {
  font-size: 11px;
  font-weight: 600;
  color: #8c8c8c;
  letter-spacing: 0.05em;
  padding: 16px 12px 8px 12px;
  text-transform: uppercase;
  user-select: none;
  -webkit-user-select: none;
}

.custom-menu {
  padding: 0 8px;
  margin-bottom: 16px;
  user-select: none;
  -webkit-user-select: none;
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
  border-radius: 6px;
}

.app-layout .custom-menu :deep(.n-menu-item-content:hover) {
  background: rgba(15, 107, 74, 0.06) !important;
  color: #0f6b4a !important;
}

.app-layout .custom-menu :deep(.n-menu-item-content:hover .n-menu-item-content__icon) {
  color: #0f6b4a !important;
}

.app-layout .custom-menu :deep(.n-menu-item-content:hover::before) {
  display: none;
}

.app-layout .custom-menu :deep(.n-menu-item-content--selected) {
  background: rgba(15, 107, 74, 0.08) !important;
  color: #0f6b4a !important;
  box-shadow: none;
}

.app-layout .custom-menu :deep(.n-menu-item-content--selected .n-menu-item-content__icon) {
  color: #0f6b4a !important;
}

.app-layout .custom-menu :deep(.n-menu-item-content--selected::before) {
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
