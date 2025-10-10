<template>
  <n-layout has-sider style="height: 100vh; background-color: #ffffff;">
    <n-layout-sider
      :collapsed="collapsed"
      collapse-mode="width"
      :collapsed-width="64"
      :width="240"
      show-trigger
      @collapse="collapsed = true"
      @expand="collapsed = false"
      style="border-right: 1px solid #e8e8e8; background-color: #ffffff;"
    >
      <div class="logo">
        <span v-if="!collapsed">LLM Gateway</span>
        <span v-else>LG</span>
      </div>
      <n-menu
        :collapsed="collapsed"
        :collapsed-width="64"
        :collapsed-icon-size="22"
        :options="menuOptions"
        :value="activeKey"
        @update:value="handleMenuSelect"
      />
    </n-layout-sider>

    <n-layout style="background-color: #ffffff;">
      <n-layout-header style="height: 64px; padding: 0 24px; display: flex; align-items: center; justify-content: space-between; border-bottom: 1px solid #e8e8e8; background-color: #ffffff;">
        <div class="header-title">{{ currentTitle }}</div>
        <n-dropdown :options="userOptions" @select="handleUserAction">
          <n-button text>
            <template #icon>
              <n-icon><PersonOutline /></n-icon>
            </template>
            {{ authStore.user?.username }}
          </n-button>
        </n-dropdown>
      </n-layout-header>

      <n-layout-content content-style="padding: 24px; background-color: #ffffff;">
        <router-view />
      </n-layout-content>
    </n-layout>
  </n-layout>
</template>

<script setup lang="ts">
import { ref, computed, h, onMounted } from 'vue';
import { useRouter, useRoute } from 'vue-router';
import {
  NLayout,
  NLayoutSider,
  NLayoutHeader,
  NLayoutContent,
  NMenu,
  NButton,
  NDropdown,
  NIcon,
} from 'naive-ui';
import {
  HomeOutline,
  ServerOutline,
  KeyOutline,
  SettingsOutline,
  PersonOutline,
  LogOutOutline,
  DocumentTextOutline,
  TerminalOutline,
  CloudOutline,
  CubeOutline,
} from '@vicons/ionicons5';
import { useAuthStore } from '@/stores/auth';

const router = useRouter();
const route = useRoute();
const authStore = useAuthStore();

const collapsed = ref(false);

const menuOptions = [
  {
    label: '仪表盘',
    key: 'dashboard',
    icon: () => h(NIcon, null, { default: () => h(HomeOutline) }),
  },
  {
    label: '模型管理',
    key: 'model-management',
    icon: () => h(NIcon, null, { default: () => h(CubeOutline) }),
    children: [
      {
        label: '提供商列表',
        key: 'providers',
        icon: () => h(NIcon, null, { default: () => h(ServerOutline) }),
      },
      {
        label: '模型列表',
        key: 'models',
        icon: () => h(NIcon, null, { default: () => h(CubeOutline) }),
      },
    ],
  },
  {
    label: '虚拟密钥',
    key: 'virtual-keys',
    icon: () => h(NIcon, null, { default: () => h(KeyOutline) }),
  },
  {
    label: 'Gateway 管理',
    key: 'gateway',
    icon: () => h(NIcon, null, { default: () => h(CloudOutline) }),
  },
  {
    label: '路由配置',
    key: 'routing-config',
    icon: () => h(NIcon, null, { default: () => h(SettingsOutline) }),
  },
  {
    label: '工具',
    key: 'tools',
    icon: () => h(NIcon, null, { default: () => h(SettingsOutline) }),
    children: [
      {
        label: 'API 使用说明',
        key: 'api-guide',
        icon: () => h(NIcon, null, { default: () => h(DocumentTextOutline) }),
      },
      {
        label: '日志查看',
        key: 'logs',
        icon: () => h(NIcon, null, { default: () => h(TerminalOutline) }),
      },
      {
        label: '实时日志',
        key: 'realtime-logs',
        icon: () => h(NIcon, null, { default: () => h(TerminalOutline) }),
      },
      {
        label: 'API 请求日志',
        key: 'api-requests',
        icon: () => h(NIcon, null, { default: () => h(DocumentTextOutline) }),
      },
    ],
  },
  {
    label: '系统设置',
    key: 'settings',
    icon: () => h(NIcon, null, { default: () => h(SettingsOutline) }),
  },
];

const userOptions = [
  {
    label: '退出登录',
    key: 'logout',
    icon: () => h(NIcon, null, { default: () => h(LogOutOutline) }),
  },
];

const activeKey = computed(() => {
  const path = route.path.split('/')[1];
  return path || 'dashboard';
});

const currentTitle = computed(() => {
  for (const item of menuOptions) {
    if (item.key === activeKey.value) {
      return item.label;
    }
    if (item.children) {
      const child = item.children.find((c: any) => c.key === activeKey.value);
      if (child) {
        return child.label;
      }
    }
  }
  return '';
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
  height: 64px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 20px;
  font-weight: 600;
  color: #18a058;
  border-bottom: 1px solid #e8e8e8;
}

.header-title {
  font-size: 18px;
  font-weight: 500;
  color: #262626;
}
</style>

