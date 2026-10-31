<template>
  <n-layout has-sider class="app-layout">
    <aside class="app-sider" :class="{ 'app-sider-collapsed': collapsed }">
      <div class="brand" :class="{ 'brand-collapsed': collapsed }">
        <img src="/assets/logo.png" alt="LLM Gateway" class="logo-image" />
        <span v-if="!collapsed" class="brand-text">LLM Gateway</span>
      </div>

      <nav class="nav-scroll" :class="{ 'nav-scroll-collapsed': collapsed }">
        <template v-for="group in groups" :key="group.key">
          <div v-if="group.label && !collapsed" class="nav-section">{{ group.label }}</div>
          <router-link
            v-for="entry in group.entries"
            :key="entry.key"
            :to="entry.path"
            class="nav-item"
            active-class="nav-item-active"
            :title="collapsed ? entry.label : undefined"
          >
            <NavIcon class="nav-item-icon" :name="entry.iconName" :size="19" :stroke-width="1.8" />
            <span v-if="!collapsed" class="nav-item-label">{{ entry.label }}</span>
          </router-link>
        </template>
      </nav>
    </aside>

    <n-layout class="app-main-layout" :native-scrollbar="false">
      <n-layout-header class="app-header">
        <div class="header-left">
          <n-button circle quaternary @click="toggleSidebar">
            <template #icon>
              <NavIcon name="menu" :size="20" />
            </template>
          </n-button>
        </div>
        <div class="header-right">
          <button type="button" class="cmd-trigger" @click="openPalette">
            <NavIcon name="search" :size="16" />
            <span class="cmd-trigger-label">{{ t('commandPalette.open') }}</span>
            <kbd class="cmd-trigger-kbd">{{ shortcutLabel }}</kbd>
          </button>
          <LanguageSwitcher />
          <AlertCenter />
          <n-dropdown :options="userOptions" @select="handleUserAction">
            <div class="user-avatar">
              <n-avatar round size="medium" :style="{ backgroundColor: '#0f6b4a' }">
                {{ authStore.user?.username?.charAt(0).toUpperCase() }}
              </n-avatar>
              <div class="user-info">
                <div class="user-name">{{ authStore.user?.username }}</div>
              </div>
            </div>
          </n-dropdown>
        </div>
      </n-layout-header>

      <n-layout-content content-style="padding: 8px 24px 24px; background-color: transparent;">
        <router-view />
      </n-layout-content>
    </n-layout>

    <command-palette ref="paletteRef" />
  </n-layout>
</template>

<script setup lang="ts">
import { computed, h, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import {
  NLayout,
  NLayoutHeader,
  NLayoutContent,
  NButton,
  NDropdown,
  NAvatar,
} from 'naive-ui';
import { useAuthStore } from '@/stores/auth';
import LanguageSwitcher from '@/components/LanguageSwitcher.vue';
import AlertCenter from '@/components/AlertCenter.vue';
import CommandPalette from '@/components/CommandPalette.vue';
import NavIcon from '@/components/NavIcon.vue';
import { useDebouncedWindowSize } from '@/composables/useDebouncedWindowSize';
import { useNavigation } from '@/composables/useNavigation';

const COLLAPSE_BREAKPOINT = 1024;

const { groups } = useNavigation();

const router = useRouter();
const { t } = useI18n();
const authStore = useAuthStore();

const collapsed = ref(false);

useDebouncedWindowSize(200, (width) => {
  collapsed.value = width < COLLAPSE_BREAKPOINT;
});

function toggleSidebar() {
  collapsed.value = !collapsed.value;
}

const paletteRef = ref<{ open: () => void } | null>(null);

// 快捷键提示跟随平台：非 macOS 显示 Ctrl K，否则用 ⌘K 会误导。
const shortcutLabel = navigator.userAgent.includes('Mac') ? '⌘K' : 'Ctrl K';

function openPalette() {
  paletteRef.value?.open();
}

const userOptions = computed(() => [
  {
    label: t('common.logout'),
    key: 'logout',
    icon: () => h(NavIcon, { name: 'logout', size: 18 }),
  },
]);

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
.app-layout {
  height: 100vh;
  overflow: hidden; /* 布局容器本身不滚动，滚动统一交给内容区域 */
  background-color: transparent;
}

.app-sider {
  flex: 0 0 auto;
  box-sizing: border-box;
  width: 240px;
  height: calc(100vh - 32px);
  margin: 16px;
  padding: 16px 12px 12px;
  display: flex;
  flex-direction: column;
  border-radius: 20px;
  /* 仓库只打包了 MiSans-Medium 一个字重，600 以上会被浏览器伪粗体合成，
     在 11px 中文标题上糊成一团。侧栏内部禁止合成，层级只靠字号/颜色/字距。 */
  font-synthesis: none;
  background-color: rgba(255, 255, 255, 0.78);
  border: 1px solid rgba(25, 55, 43, 0.06);
  box-shadow: 0 4px 18px rgba(25, 55, 43, 0.045), 0 1px 3px rgba(25, 55, 43, 0.03);
  backdrop-filter: blur(10px) saturate(125%);
  -webkit-backdrop-filter: blur(10px) saturate(125%);
  overflow: hidden;
  transition: width 0.25s ease, padding 0.25s ease;
  z-index: 100;
}

.app-sider-collapsed {
  width: 80px;
  padding: 14px 8px 10px;
}

.brand {
  flex: 0 0 auto;
  height: 40px;
  display: flex;
  align-items: center;
  gap: 11px;
  padding: 0 8px;
  margin-bottom: 18px;
  user-select: none;
  -webkit-user-select: none;
}

.brand-collapsed {
  justify-content: center;
  padding: 0;
}

.logo-image {
  width: 32px;
  height: 32px;
  object-fit: contain;
}

.brand-text {
  font-size: 16px;
  font-weight: 500;
  line-height: 1.25;
  color: var(--color-title);
  letter-spacing: -0.015em;
  white-space: nowrap;
}

.nav-scroll {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
  scrollbar-width: thin;
}

.nav-scroll::-webkit-scrollbar {
  width: 4px;
}

.nav-scroll::-webkit-scrollbar-track {
  background: transparent;
}

.nav-scroll::-webkit-scrollbar-thumb {
  background-color: rgba(0, 0, 0, 0.1);
  border-radius: 4px;
}

.nav-scroll:hover::-webkit-scrollbar-thumb {
  background-color: rgba(0, 0, 0, 0.2);
}

.nav-section {
  position: sticky;
  top: 0;
  z-index: 2;
  padding: 16px 12px 7px;
  font-size: 12px;
  line-height: 1.25;
  font-weight: 500;
  color: #66756f;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  background-color: rgba(250, 252, 251, 0.96);
  backdrop-filter: blur(6px);
  -webkit-backdrop-filter: blur(6px);
  user-select: none;
  -webkit-user-select: none;
}

.nav-item {
  display: flex;
  align-items: center;
  gap: 12px;
  min-height: 40px;
  padding: 0 12px;
  border-radius: 9px;
  color: #42514b;
  font-size: 14px;
  line-height: 1.4;
  font-weight: 500;
  letter-spacing: 0;
  text-decoration: none;
  white-space: nowrap;
  transition: background-color 0.18s ease, color 0.18s ease;
  user-select: none;
  -webkit-user-select: none;
}

.nav-scroll-collapsed .nav-item {
  justify-content: center;
  padding: 0;
}

.nav-item:hover {
  background-color: rgba(15, 107, 74, 0.06);
  color: var(--color-primary);
}

.nav-item:focus-visible {
  outline: 2px solid var(--color-primary);
  outline-offset: -2px;
}

.nav-item-active {
  background-color: rgba(15, 107, 74, 0.1);
  color: var(--color-primary);
}

.nav-item-icon {
  flex: 0 0 auto;
  color: #71827a;
  transition: color 0.18s ease;
}

.nav-item-active .nav-item-icon,
.nav-item:hover .nav-item-icon {
  color: var(--color-primary);
}

.nav-item-label {
  overflow: hidden;
  text-overflow: ellipsis;
}

.app-main-layout {
  background-color: transparent;
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

.cmd-trigger {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 34px;
  padding: 0 8px 0 10px;
  border: 1px solid rgba(0, 0, 0, 0.08);
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.6);
  color: #6b7280;
  font-size: 13px;
  cursor: pointer;
  transition: border-color 0.18s ease, color 0.18s ease, background-color 0.18s ease;
}

.cmd-trigger:hover {
  border-color: rgba(15, 107, 74, 0.3);
  background: rgba(255, 255, 255, 0.9);
  color: var(--color-primary);
}

.cmd-trigger-kbd {
  padding: 2px 5px;
  border-radius: 5px;
  background: rgba(0, 0, 0, 0.05);
  font-family: inherit;
  font-size: 11px;
  color: #6b7280;
}

.header-right {
  display: flex;
  align-items: center;
  gap: 12px;
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
</style>
