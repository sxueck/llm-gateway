<template>
  <div class="section-shell" :class="{ 'section-shell-constrained': ['monitoring', 'tools', 'settings', 'experimental'].includes(hub?.key ?? ''), 'section-shell-experimental': hub?.key === 'experimental' }">
    <div v-if="hub && !hideTabs" class="section-tabs">
      <n-tabs :value="activeTab" type="line" @update:value="handleTabChange">
        <n-tab v-for="tab in hub.children" :key="tab.key" :name="tab.key" :tab="tab.label" />
      </n-tabs>
    </div>
    <router-view />
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { NTabs, NTab } from 'naive-ui';
import { useNavigation } from '@/composables/useNavigation';

const route = useRoute();
const router = useRouter();
const { hubByPath } = useNavigation();

// 路由层级固定为 /<枢纽>/<页面>，所以第一段对应枢纽、第二段是当前 tab。
const hub = computed(() => hubByPath(route.path));

const activeTab = computed(() => route.path.split('/').filter(Boolean)[1] ?? '');

// 详情页（如运行详情、路由详情）不属于 tab 分支，独占整页。
const hideTabs = computed(() => route.meta.hideSectionTabs === true);

function handleTabChange(key: string) {
  if (!hub.value) return;
  router.push(`${hub.value.path}/${key}`);
}
</script>

<style scoped>
.section-shell {
  display: flex;
  flex-direction: column;
}

.section-shell-constrained {
  width: 100%;
  max-width: 1500px;
  margin: 0 auto;
}

.section-shell-experimental {
  max-width: 1400px;
}

.section-tabs {
  margin-bottom: 8px;
}

.section-shell-constrained .section-tabs {
  margin-bottom: 20px;
}
</style>
