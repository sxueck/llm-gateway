<template>
  <n-card title="熔断器状态" size="small">
    <template #header-extra>
      <n-space>
        <n-button size="small" @click="refresh" :loading="loading">
          刷新
        </n-button>
        <n-popconfirm @positive-click="resetAll">
          <template #trigger>
            <n-button size="small" type="warning">
              重置全部
            </n-button>
          </template>
          确定要重置所有熔断器吗？
        </n-popconfirm>
      </n-space>
    </template>

    <n-spin :show="loading">
      <n-empty v-if="providers.length === 0" description="暂无熔断器数据" />
      
      <n-space v-else vertical :size="12">
        <n-card
          v-for="provider in providers"
          :key="provider.providerId"
          size="small"
          :bordered="false"
          style="background-color: var(--n-color-target)"
        >
          <n-space justify="space-between" align="center">
            <n-space vertical :size="4">
              <n-space align="center">
                <n-text strong>{{ provider.providerId }}</n-text>
                <n-tag :type="getStateType(provider.state)" size="small">
                  {{ getStateText(provider.state) }}
                </n-tag>
              </n-space>
              
              <n-space :size="16">
                <n-text depth="3" style="font-size: 12px">
                  失败: {{ provider.failures }}
                </n-text>
                <n-text depth="3" style="font-size: 12px">
                  成功: {{ provider.successes }}
                </n-text>
                <n-text v-if="provider.state === 'HALF_OPEN'" depth="3" style="font-size: 12px">
                  半开尝试: {{ provider.halfOpenAttempts }}
                </n-text>
                <n-text v-if="provider.lastFailureTime > 0" depth="3" style="font-size: 12px">
                  最后失败: {{ formatTime(provider.lastFailureTime) }}
                </n-text>
              </n-space>
            </n-space>

            <n-popconfirm @positive-click="resetProvider(provider.providerId)">
              <template #trigger>
                <n-button size="small" quaternary>
                  重置
                </n-button>
              </template>
              确定要重置此熔断器吗？
            </n-popconfirm>
          </n-space>
        </n-card>
      </n-space>
    </n-spin>
  </n-card>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { NCard, NSpace, NButton, NTag, NText, NSpin, NEmpty, NPopconfirm, useMessage } from 'naive-ui';
import request from '@/utils/request';

interface CircuitBreakerProvider {
  providerId: string;
  state: 'CLOSED' | 'OPEN' | 'HALF_OPEN';
  failures: number;
  successes: number;
  lastFailureTime: number;
  halfOpenAttempts: number;
}

const message = useMessage();
const loading = ref(false);
const providers = ref<CircuitBreakerProvider[]>([]);

async function fetchStatus() {
  loading.value = true;
  try {
    const response = await request.get('/config/circuit-breaker/status');
    providers.value = response.providers || [];
  } catch (error: any) {
    message.error(error.message || '获取熔断器状态失败');
  } finally {
    loading.value = false;
  }
}

async function resetProvider(providerId: string) {
  try {
    await request.post(`/config/circuit-breaker/reset/${providerId}`);
    message.success('重置成功');
    await fetchStatus();
  } catch (error: any) {
    message.error(error.message || '重置失败');
  }
}

async function resetAll() {
  try {
    await request.post('/config/circuit-breaker/reset-all');
    message.success('重置成功');
    await fetchStatus();
  } catch (error: any) {
    message.error(error.message || '重置失败');
  }
}

function refresh() {
  fetchStatus();
}

function getStateType(state: string): 'success' | 'warning' | 'error' {
  switch (state) {
    case 'CLOSED':
      return 'success';
    case 'HALF_OPEN':
      return 'warning';
    case 'OPEN':
      return 'error';
    default:
      return 'success';
  }
}

function getStateText(state: string): string {
  switch (state) {
    case 'CLOSED':
      return '正常';
    case 'HALF_OPEN':
      return '半开';
    case 'OPEN':
      return '熔断';
    default:
      return state;
  }
}

function formatTime(timestamp: number): string {
  if (!timestamp) return '-';
  const now = Date.now();
  const diff = now - timestamp;
  
  if (diff < 60000) {
    return `${Math.floor(diff / 1000)}秒前`;
  } else if (diff < 3600000) {
    return `${Math.floor(diff / 60000)}分钟前`;
  } else if (diff < 86400000) {
    return `${Math.floor(diff / 3600000)}小时前`;
  } else {
    return new Date(timestamp).toLocaleString('zh-CN');
  }
}

onMounted(() => {
  fetchStatus();
});
</script>

