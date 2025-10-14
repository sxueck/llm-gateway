<template>
  <n-alert v-if="demoMode" type="warning" :bordered="false" style="margin-bottom: 16px;">
    <template #header>演示模式</template>
    当前系统运行在演示模式下，所有数据将每隔 3 天自动清空。
    <div v-if="nextCleanupTime" style="margin-top: 8px; font-size: 13px;">
      下次清理时间: {{ formatDateTime(nextCleanupTime) }}
    </div>
  </n-alert>
</template>

<script setup lang="ts">
import { NAlert } from 'naive-ui';
import { useSystemConfig } from '@/composables/useSystemConfig';
import { formatDateTime } from '@/utils/date';

const { demoMode, nextCleanupTime } = useSystemConfig();
</script>

