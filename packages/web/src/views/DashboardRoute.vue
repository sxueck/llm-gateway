<template>
  <DashboardView v-if="authStore.isAdmin" />
  <UserDashboardView v-else />
</template>

<script setup lang="ts">
import { useAuthStore } from '@/stores/auth';
import DashboardView from '@/views/DashboardView.vue';
import UserDashboardView from '@/views/UserDashboardView.vue';

/**
 * /dashboard 的角色分发入口：管理员看全局仪表盘，普通用户看个人概览。
 * 用组件级 v-if 而不是路由级重定向，两种角色共享同一个书签地址与登录跳转目标。
 */
const authStore = useAuthStore();
</script>
