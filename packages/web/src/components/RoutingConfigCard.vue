<template>
  <n-card class="routing-card" :class="`type-${config.type}`" hoverable size="small">
    <template #header>
      <div class="card-header">
        <div class="header-main">
          <n-text strong class="config-name">{{ config.name }}</n-text>
          <n-tag :type="typeConfig.tagType" size="small" round :bordered="false">
            {{ typeConfig.label }}
          </n-tag>
        </div>
        <n-text depth="3" class="config-desc" v-if="config.description">
          {{ config.description }}
        </n-text>
      </div>
    </template>
    
    <template #header-extra>
      <div class="card-actions">
        <n-tooltip trigger="hover">
          <template #trigger>
            <n-button text size="small" @click="$emit('preview', config)">
              <template #icon>
                <n-icon><CodeOutline /></n-icon>
              </template>
            </n-button>
          </template>
          查看配置
        </n-tooltip>
        <n-tooltip trigger="hover">
          <template #trigger>
            <n-button text size="small" @click="$emit('edit', config)">
              <template #icon>
                <n-icon><CreateOutline /></n-icon>
              </template>
            </n-button>
          </template>
          编辑
        </n-tooltip>
        <n-popconfirm @positive-click="$emit('delete', config.id)">
          <template #trigger>
            <n-button text type="error" size="small">
              <template #icon>
                <n-icon><TrashOutline /></n-icon>
              </template>
            </n-button>
          </template>
          确定删除此智能路由？
        </n-popconfirm>
      </div>
    </template>

    <div class="card-body">
      <!-- 故障转移视图 (Fallback) -->
      <div v-if="config.type === 'fallback'" class="strategy-view fallback-view">
        <div class="timeline-connector"></div>
        <div class="target-list">
          <div 
            v-for="(target, index) in enrichedTargets" 
            :key="index"
            class="target-item fallback-item"
          >
            <div class="target-icon">
              <n-icon v-if="index === 0" color="#18a058"><CheckmarkCircle /></n-icon>
              <n-icon v-else color="#f0a020"><AlertCircleOutline /></n-icon>
            </div>
            <div class="target-content">
              <div class="target-main">
                <n-tag size="tiny" :bordered="false" class="provider-tag">
                  {{ target.providerName }}
                </n-tag>
                <span class="model-name">{{ target.modelName }}</span>
              </div>
              <div class="target-meta" v-if="index > 0 && target.onStatusCodes?.length">
                <span class="meta-label">触发条件:</span>
                <span class="status-codes">{{ target.onStatusCodes.join(', ') }}</span>
              </div>
            </div>
            <div class="priority-badge">P{{ index + 1 }}</div>
          </div>
        </div>
      </div>

      <!-- 负载均衡视图 (Load Balance) -->
      <div v-else-if="config.type === 'loadbalance'" class="strategy-view lb-view">
        <div 
          v-for="(target, index) in enrichedTargets" 
          :key="index"
          class="target-item lb-item"
        >
          <div class="lb-info">
            <div class="target-main">
              <n-tag size="tiny" :bordered="false" class="provider-tag">
                {{ target.providerName }}
              </n-tag>
              <span class="model-name">{{ target.modelName }}</span>
            </div>
            <span class="weight-label">{{ (target.weight * 100).toFixed(0) }}%</span>
          </div>
          <n-progress 
            type="line" 
            :percentage="Math.round(target.weight * 100)" 
            :show-indicator="false"
            :height="4"
            :color="getWeightColor(target.weight)"
            processing
          />
        </div>
      </div>

      <!-- 其他视图 (Hash/Affinity) -->
      <div v-else class="strategy-view default-view">
        <div 
          v-for="(target, index) in enrichedTargets" 
          :key="index"
          class="target-item default-item"
        >
           <n-tag size="tiny" :bordered="false" class="provider-tag">
              {{ target.providerName }}
           </n-tag>
           <span class="model-name">{{ target.modelName }}</span>
        </div>
        <div class="strategy-meta" v-if="config.type === 'affinity'">
          <n-icon><TimeOutline /></n-icon>
          <span>会话保持: {{ (config.config.strategy.affinityTTL || 0) / 1000 }}s</span>
        </div>
        <div class="strategy-meta" v-if="config.type === 'hash'">
          <n-icon><KeyOutline /></n-icon>
          <span>Hash源: {{ config.config.strategy.hashSource }}</span>
        </div>
      </div>
    </div>
  </n-card>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { 
  NCard, NTag, NText, NIcon, NButton, NTooltip, NPopconfirm, 
  NProgress 
} from 'naive-ui';
import { 
  CodeOutline, CreateOutline, TrashOutline, 
  CheckmarkCircle, AlertCircleOutline,
  TimeOutline, KeyOutline
} from '@vicons/ionicons5';

const props = defineProps<{
  config: any;
  providers: any[];
  models: any[];
}>();

defineEmits(['edit', 'preview', 'delete']);

const typeConfig = computed(() => {
  const map: Record<string, any> = {
    'loadbalance': { label: '负载均衡', tagType: 'info' },
    'fallback': { label: '故障转移', tagType: 'warning' },
    'hash': { label: '一致性哈希', tagType: 'success' },
    'affinity': { label: '时间窗口亲和', tagType: 'error' }
  };
  return map[props.config.type] || { label: props.config.type, tagType: 'default' };
});

const enrichedTargets = computed(() => {
  if (!props.config.config?.targets) return [];
  
  return props.config.config.targets.map((t: any) => {
    const provider = props.providers.find(p => p.id === t.provider);
    const modelId = t.override_params?.model;
    // Attempt to find model name, fallback to ID
    const model = props.models.find(m => m.modelIdentifier === modelId && m.providerId === t.provider);
    
    return {
      ...t,
      providerName: provider?.name || t.provider,
      modelName: model?.name || modelId || 'Default Model'
    };
  });
});

function getWeightColor(weight: number) {
  if (weight >= 0.8) return '#18a058'; // Green
  if (weight >= 0.4) return '#2080f0'; // Blue
  return '#f0a020'; // Orange
}
</script>

<style scoped>
.routing-card {
  height: 100%;
  display: flex;
  flex-direction: column;
  transition: all 0.3s ease;
  border-radius: 12px;
  border: 1px solid rgba(239, 239, 245, 1);
}

.routing-card:hover {
  transform: translateY(-2px);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.08);
  border-color: var(--n-color-target);
}

.type-fallback:hover { border-color: rgba(240, 160, 32, 0.3); }
.type-loadbalance:hover { border-color: rgba(32, 128, 240, 0.3); }

.card-header {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.header-main {
  display: flex;
  align-items: center;
  gap: 8px;
}

.config-name {
  font-size: 15px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.config-desc {
  font-size: 12px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 100%;
}

.card-actions {
  display: flex;
  gap: 4px;
}

.card-body {
  padding-top: 8px;
  flex: 1;
}

/* Fallback View Styles */
.fallback-view {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.timeline-connector {
  position: absolute;
  left: 9px;
  top: 10px;
  bottom: 10px;
  width: 2px;
  background: #f0f0f0;
  z-index: 0;
}

.fallback-item {
  display: flex;
  align-items: center;
  gap: 8px;
  position: relative;
  z-index: 1;
  background: #fff;
  padding: 4px 0;
}

.target-icon {
  font-size: 18px;
  background: #fff;
  display: flex;
  align-items: center;
  justify-content: center;
}

.target-content {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.target-main {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
}

.target-meta {
  font-size: 11px;
  color: #999;
  margin-top: 2px;
}

.priority-badge {
  font-size: 10px;
  color: #ccc;
  font-family: monospace;
}

.provider-tag {
  background: #f5f5f7;
  color: #666;
  font-size: 11px;
  height: 18px;
  padding: 0 4px;
}

.model-name {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  font-weight: 500;
  color: #333;
}

/* Load Balance View Styles */
.lb-view {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.lb-item {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.lb-info {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.weight-label {
  font-size: 12px;
  color: #666;
  font-weight: 600;
  font-family: monospace;
}

/* Default View Styles */
.default-view {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.default-item {
  display: flex;
  align-items: center;
  gap: 8px;
  background: #f9f9fa;
  padding: 6px 10px;
  border-radius: 6px;
}

.strategy-meta {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: #666;
  margin-top: 4px;
  padding-left: 2px;
}
</style>
