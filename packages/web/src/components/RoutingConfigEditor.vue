<template>
  <div class="routing-editor">
    <div class="editor-layout">
      <!-- 左侧：控制台 -->
      <div class="editor-sidebar">
        <div class="sidebar-section">
          <div class="section-title">基础配置</div>
          <n-form-item label="路由名称" :show-feedback="false" class="mb-4">
            <n-input 
              v-model:value="localFormValue.virtualModelName" 
              placeholder="例如: GPT-4-Failover" 
            />
          </n-form-item>
          <n-form-item label="描述 (可选)" :show-feedback="false">
            <n-input 
              v-model:value="localFormValue.description" 
              type="textarea" 
              placeholder="简要描述路由策略..." 
              :rows="2"
            />
          </n-form-item>
        </div>

        <n-divider class="my-4" />

        <div class="sidebar-section">
          <div class="section-title">路由策略</div>
          <n-radio-group v-model:value="localConfigType" class="strategy-selector">
            <n-grid :cols="1" :y-gap="8">
              <n-grid-item v-for="type in strategyTypes" :key="type.value">
                <div 
                  class="strategy-option" 
                  :class="{ active: localConfigType === type.value }"
                  @click="localConfigType = type.value"
                >
                  <n-icon class="strategy-icon" :component="type.icon" />
                  <div class="strategy-info">
                    <div class="strategy-label">{{ type.label }}</div>
                    <div class="strategy-desc">{{ type.desc }}</div>
                  </div>
                  <n-icon v-if="localConfigType === type.value" class="check-icon" :component="CheckmarkCircle" />
                </div>
              </n-grid-item>
            </n-grid>
          </n-radio-group>
        </div>

        <!-- 高级参数区 -->
        <div v-if="localConfigType === 'hash' || localConfigType === 'affinity'" class="sidebar-section advanced-params">
          <div class="section-title">高级参数</div>
          <n-form-item v-if="localConfigType === 'hash'" label="哈希源">
            <n-select 
              v-model:value="localFormValue.hashSource" 
              :options="[{ label: '虚拟密钥 (Virtual Key)', value: 'virtualKey' }, { label: '请���内容 (Request)', value: 'request' }]"
            />
          </n-form-item>
          <n-form-item v-if="localConfigType === 'affinity'" label="会话保持时间 (秒)">
            <n-input-number v-model:value="localFormValue.affinityTTLSeconds" :min="1" />
          </n-form-item>
        </div>
      </div>

      <!-- 右侧：可视化编排 -->
      <div class="editor-main">
        <div class="main-header">
          <div class="header-left">
            <n-tag :type="currentStrategyInfo.tagType" size="small" round :bordered="false">
              {{ currentStrategyInfo.label }}模式
            </n-tag>
            
            <!-- LoadBalance 提示 -->
            <div class="header-tip-group" v-if="localConfigType === 'loadbalance'">
              <span class="header-tip">总权重:</span>
              <div class="weight-progress-bar">
                <div 
                  class="weight-progress-fill" 
                  :class="{ 'is-valid': totalWeight === 1 }"
                  :style="{ width: `${Math.min(totalWeight * 100, 100)}%` }"
                ></div>
              </div>
              <span class="weight-text" :class="{ 'text-error': totalWeight !== 1, 'text-success': totalWeight === 1 }">
                {{ (totalWeight * 100).toFixed(0) }}%
              </span>
            </div>

            <!-- Fallback 提示 -->
            <span class="header-tip flex-center" v-if="localConfigType === 'fallback'">
              <n-icon :component="InformationCircleOutline" class="mr-1 icon-small" />
              请求将按列表顺序尝试，直到成功
            </span>

            <!-- Hash 提示 -->
            <span class="header-tip flex-center" v-if="localConfigType === 'hash'">
              <n-icon :component="InformationCircleOutline" class="mr-1 icon-small" />
              根据 {{ localFormValue.hashSource === 'request' ? '请求内容' : '虚拟密钥' }} 映射到固定目标
            </span>

            <!-- Affinity 提示 -->
            <span class="header-tip flex-center" v-if="localConfigType === 'affinity'">
              <n-icon :component="InformationCircleOutline" class="mr-1 icon-small" />
              同一用户的请求将在 {{ localFormValue.affinityTTLSeconds || 300 }}秒 内保持在同一目标
            </span>
          </div>
          <n-button size="small" type="primary" dashed @click="addTarget">
            <template #icon><n-icon :component="Add" /></template>
            添加目标
          </n-button>
        </div>

        <div class="targets-container">
          <n-empty v-if="localFormValue.targets.length === 0" description="暂无路由目标" class="mt-8">
            <template #extra>
              <n-button size="small" type="primary" @click="addTarget">添加第一个目标</n-button>
            </template>
          </n-empty>

          <TransitionGroup 
            v-else 
            name="list" 
            tag="div" 
            class="targets-list"
          >
            <div 
              v-for="(target, index) in localFormValue.targets" 
              :key="index"
              class="target-item"
              :class="localConfigType"
            >
              <!-- 序号/拖拽把手 -->
              <div class="item-handle">
                <div class="index-badge" :class="{ 'bg-primary': index === 0 && localConfigType === 'fallback' }">
                  {{ index + 1 }}
                </div>
                <div class="connector-line" v-if="index < localFormValue.targets.length - 1 && localConfigType === 'fallback'"></div>
              </div>

              <!-- 主体内容 -->
              <div class="item-content">
                <div class="content-row">
                  <div class="row-inputs">
                    <n-select 
                      v-model:value="target.providerId" 
                      :options="providerOptions" 
                      placeholder="选择提供商" 
                      size="small"
                      class="provider-select"
                      @update:value="() => target.modelName = ''"
                    />
                    <n-select 
                      v-model:value="target.modelName" 
                      :options="getModelOptionsByProvider(target.providerId)" 
                      placeholder="选择模型" 
                      size="small"
                      class="model-select"
                      :disabled="!target.providerId"
                    />
                  </div>
                  
                  <!-- 权重设置 (LoadBalance/Hash/Affinity) -->
                  <div v-if="['loadbalance', 'hash', 'affinity'].includes(localConfigType)" class="weight-control">
                    <span class="label">权重</span>
                    <n-input-number 
                      v-model:value="target.weight" 
                      :min="0" :max="1" :step="0.1" 
                      size="small" 
                      class="weight-input"
                      :show-button="false"
                    />
                  </div>

                  <n-button text class="delete-btn" @click="removeTarget(index)">
                    <n-icon :component="TrashOutline" />
                  </n-button>
                </div>

                <!-- 额外配置 (Fallback 状态码) -->
                <div v-if="localConfigType === 'fallback'" class="extra-row">
                  <span class="label">触发条件:</span>
                  <n-select 
                    v-model:value="target.onStatusCodes" 
                    multiple 
                    :options="statusCodeOptions" 
                    placeholder="默认: 429, 503 (空则不触发)" 
                    size="tiny"
                    class="status-select"
                  />
                </div>

                <!-- 移动按钮 (Fallback 排序) -->
                <div v-if="localConfigType === 'fallback'" class="sort-actions">
                  <n-button text size="tiny" :disabled="index === 0" @click="moveTargetUp(index)">
                    <n-icon :component="ArrowUp" />
                  </n-button>
                  <n-button text size="tiny" :disabled="index === localFormValue.targets.length - 1" @click="moveTargetDown(index)">
                    <n-icon :component="ArrowDown" />
                  </n-button>
                </div>
              </div>
            </div>
          </TransitionGroup>
        </div>
      </div>
    </div>

    <div class="editor-footer">
      <n-button @click="$emit('cancel')">取消</n-button>
      <n-button type="primary" @click="handleSave" :loading="saving" :disabled="!isValid">
        {{ isEditing ? '保存修改' : '创建路由' }}
      </n-button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, watch } from 'vue';
import { 
  GitNetworkOutline, 
  GitMergeOutline, 
  TimeOutline, 
  KeyOutline,
  CheckmarkCircle,
  Add,
  TrashOutline,
  ArrowUp,
  ArrowDown,
  InformationCircleOutline
} from '@vicons/ionicons5';
import { 
  NFormItem, NInput, NInputNumber, NSelect, NRadioGroup, 
  NGrid, NGridItem, NIcon, NDivider, NButton, NTag, NEmpty
} from 'naive-ui';
import type { VirtualModelFormValue, RoutingConfigType } from '@/types/virtual-model';

interface StrategyType {
  label: string;
  value: RoutingConfigType;
  desc: string;
  icon: any;
  tagType: 'info' | 'success' | 'warning' | 'error' | 'default' | 'primary';
}

const props = defineProps<{
  configType: RoutingConfigType;
  formValue: VirtualModelFormValue;
  providerOptions: Array<{ label: string; value: string }>;
  getModelOptionsByProvider: (providerId: string) => Array<{ label: string; value: string }>;
  statusCodeOptions: Array<{ label: string; value: number }>;
  saving: boolean;
  isEditing?: boolean;
}>();

const emit = defineEmits(['update:configType', 'update:formValue', 'save', 'cancel']);

// Strategy Definitions
const strategyTypes: StrategyType[] = [
  { 
    label: '负载均衡', 
    value: 'loadbalance', 
    desc: '按权重分发流量', 
    icon: GitNetworkOutline,
    tagType: 'info'
  },
  { 
    label: '故障转移', 
    value: 'fallback', 
    desc: '主备自动切换', 
    icon: GitMergeOutline,
    tagType: 'warning'
  },
  { 
    label: '一致性哈希', 
    value: 'hash', 
    desc: '固定源路由', 
    icon: KeyOutline,
    tagType: 'success'
  },
  { 
    label: '亲和性', 
    value: 'affinity', 
    desc: '时间窗口保持', 
    icon: TimeOutline,
    tagType: 'error'
  }
];

// Local State Proxies
const localConfigType = computed({
  get: () => props.configType,
  set: (v) => emit('update:configType', v)
});

const localFormValue = computed({
  get: () => props.formValue,
  set: (v) => emit('update:formValue', v)
});

const currentStrategyInfo = computed(() => 
  strategyTypes.find(s => s.value === localConfigType.value) || strategyTypes[0]
);

const totalWeight = computed(() => {
  if (!['loadbalance', 'hash', 'affinity'].includes(localConfigType.value)) return 0;
  return localFormValue.value.targets.reduce((sum, t) => sum + (t.weight || 0), 0);
});

const isValid = computed(() => {
  if (!localFormValue.value.virtualModelName) return false;
  if (localFormValue.value.targets.length === 0) return false;
  return localFormValue.value.targets.every(t => t.providerId && t.modelName);
});

// Actions
function addTarget() {
  localFormValue.value.targets.push({
    providerId: '',
    modelName: '',
    weight: ['loadbalance', 'hash', 'affinity'].includes(localConfigType.value) ? 0.5 : undefined,
    onStatusCodes: localConfigType.value === 'fallback' ? [] : undefined,
  });
}

function removeTarget(index: number) {
  localFormValue.value.targets.splice(index, 1);
}

function moveTargetUp(index: number) {
  if (index <= 0) return;
  const items = [...localFormValue.value.targets];
  [items[index - 1], items[index]] = [items[index], items[index - 1]];
  localFormValue.value.targets = items;
}

function moveTargetDown(index: number) {
  if (index >= localFormValue.value.targets.length - 1) return;
  const items = [...localFormValue.value.targets];
  [items[index + 1], items[index]] = [items[index], items[index + 1]];
  localFormValue.value.targets = items;
}

function handleSave() {
  // Set createVirtualModel to true implicitly as we are designing for "Smart Routing" which implies a virtual model entry
  localFormValue.value.createVirtualModel = true;
  localFormValue.value.name = localFormValue.value.virtualModelName; 
  emit('save');
}

// Watchers
watch(localConfigType, () => {
  // Clear targets on type change to avoid incompatible configs? 
  // Or maybe keep them but reset strategy-specific fields. 
  // For UX, keeping providers is nice, but weights need reset.
  localFormValue.value.targets = localFormValue.value.targets.map(t => ({
    ...t,
    weight: ['loadbalance', 'hash', 'affinity'].includes(localConfigType.value) ? 0.5 : undefined,
    onStatusCodes: localConfigType.value === 'fallback' ? [] : undefined
  }));
});
</script>

<style scoped>
.routing-editor {
  display: flex;
  flex-direction: column;
  height: 100%;
  max-height: calc(90vh - 120px);
  min-height: 500px;
}

.editor-layout {
  display: flex;
  flex: 1;
  overflow: hidden;
  border-bottom: 1px solid #f0f0f0;
  min-height: 0;
}

/* Sidebar */
.editor-sidebar {
  width: 280px;
  background: #fafafa;
  border-right: 1px solid #f0f0f0;
  padding: 20px;
  overflow-y: auto;
  overflow-x: hidden;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

/* 修复左侧滚动条样式 */
.editor-sidebar::-webkit-scrollbar {
  width: 4px;
}
.editor-sidebar::-webkit-scrollbar-track {
  background: transparent;
}
.editor-sidebar::-webkit-scrollbar-thumb {
  background-color: rgba(0, 0, 0, 0.1);
  border-radius: 4px;
}
.editor-sidebar:hover::-webkit-scrollbar-thumb {
  background-color: rgba(0, 0, 0, 0.2);
}

.section-title {
  font-size: 12px;
  font-weight: 600;
  color: #999;
  text-transform: uppercase;
  margin-bottom: 12px;
  letter-spacing: 0.5px;
}

.mb-4 { margin-bottom: 16px; }
.mt-4 { margin-top: 16px; }
.my-4 { margin: 16px 0; }
.advanced-params { margin-top: 16px; flex-shrink: 0; }
.mr-1 { margin-right: 4px; }
.icon-small { font-size: 14px; vertical-align: sub; }
.flex-center { display: flex; align-items: center; }

.strategy-option {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 12px;
  border: 1px solid #e0e0e0;
  border-radius: 8px;
  background: #fff;
  cursor: pointer;
  transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
  position: relative;
  width: 100%;
  box-sizing: border-box;
}

.strategy-selector {
  width: 100%;
}

.strategy-selector :deep(.n-grid) {
  width: 100%;
}

.strategy-option:hover {
  border-color: var(--n-color-primary);
  background: rgba(24, 160, 88, 0.02);
  transform: translateY(-1px);
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.04);
}

.strategy-option.active {
  border-color: var(--n-color-primary);
  background: rgba(24, 160, 88, 0.05);
  box-shadow: 0 2px 6px rgba(24, 160, 88, 0.1);
}

.strategy-icon {
  font-size: 20px;
  color: #666;
  transition: color 0.2s;
}

.strategy-option.active .strategy-icon {
  color: var(--n-color-primary);
}

.strategy-info {
  flex: 1;
}

.strategy-label {
  font-size: 13px;
  font-weight: 500;
  color: #333;
}

.strategy-desc {
  font-size: 11px;
  color: #999;
}

.check-icon {
  color: var(--n-color-primary);
  font-size: 16px;
}

/* Main Area */
.editor-main {
  flex: 1;
  display: flex;
  flex-direction: column;
  background: #fff;
}

.main-header {
  padding: 16px 24px;
  border-bottom: 1px solid #f0f0f0;
  display: flex;
  justify-content: space-between;
  align-items: center;
  height: 64px; /* Fix header height */
  box-sizing: border-box;
}

.header-left {
  display: flex;
  align-items: center;
  gap: 16px;
}

.header-tip-group {
  display: flex;
  align-items: center;
  gap: 8px;
}

.header-tip {
  font-size: 13px;
  color: #666;
}

.weight-progress-bar {
  width: 80px;
  height: 6px;
  background: #f0f0f0;
  border-radius: 3px;
  overflow: hidden;
}

.weight-progress-fill {
  height: 100%;
  background: #d03050; /* Error color by default */
  transition: width 0.3s ease, background-color 0.3s ease;
}

.weight-progress-fill.is-valid {
  background: #18a058; /* Success color */
}

.weight-text {
  font-weight: 600;
  font-size: 13px;
  min-width: 36px;
}

.text-error { color: #d03050; }
.text-success { color: #18a058; }

.targets-container {
  flex: 1;
  overflow-y: auto;
  padding: 24px;
  background: #fff;
}

/* List Transitions */
.targets-list {
  position: relative;
}

.list-move,
.list-enter-active,
.list-leave-active {
  transition: all 0.3s cubic-bezier(0.55, 0, 0.1, 1);
}

.list-enter-from,
.list-leave-to {
  opacity: 0;
  transform: translateX(-10px);
}

.list-leave-active {
  position: absolute;
  width: 100%;
}

.target-item {
  display: flex;
  gap: 16px;
  margin-bottom: 16px;
  padding: 16px;
  border: 1px solid #eee;
  border-radius: 8px;
  background: #fff;
  transition: all 0.2s;
  position: relative;
}

.target-item:hover {
  border-color: #d9d9d9;
  box-shadow: 0 4px 12px rgba(0,0,0,0.05);
  transform: translateY(-1px);
}

.item-handle {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding-top: 4px;
  width: 24px;
}

.index-badge {
  width: 20px;
  height: 20px;
  border-radius: 50%;
  background: #f0f0f0;
  color: #999;
  font-size: 11px;
  font-weight: 600;
  display: flex;
  justify-content: center;
  align-items: center;
}

.index-badge.bg-primary {
  background: var(--n-color-primary);
  color: #fff;
}

.connector-line {
  width: 2px;
  flex: 1;
  background: #f0f0f0;
  margin-top: 8px;
  min-height: 20px;
}

.item-content {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.content-row {
  display: flex;
  align-items: center;
  gap: 12px;
}

.row-inputs {
  display: flex;
  flex: 1;
  gap: 12px;
}

.provider-select { 
  flex: 1;
}

.provider-select :deep(.n-base-selection) {
  border: 1px solid #d9d9d9;
}

.provider-select :deep(.n-base-selection:hover) {
  border-color: #18a058;
}

.model-select { 
  flex: 1;
}

.model-select :deep(.n-base-selection) {
  border: 1px solid #d9d9d9;
}

.model-select :deep(.n-base-selection:hover) {
  border-color: #18a058;
}

.weight-control {
  display: flex;
  align-items: center;
  gap: 8px;
  background: #f9f9f9;
  padding: 2px 8px;
  border-radius: 4px;
  border: 1px solid transparent;
  transition: border-color 0.2s;
}

.target-item:hover .weight-control {
  border-color: #eee;
}

.weight-control .label {
  font-size: 11px;
  color: #666;
}

.weight-input {
  width: 70px;
}

.delete-btn {
  color: #999;
  opacity: 0.6;
  transition: all 0.2s;
}
.target-item:hover .delete-btn {
  opacity: 1;
}
.delete-btn:hover { 
  color: #d03050; 
  background-color: rgba(208, 48, 80, 0.1);
  border-radius: 4px;
}

.extra-row {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 11px;
  color: #666;
  background: #fffbf0;
  padding: 4px 8px;
  border-radius: 4px;
  width: fit-content;
}

.status-select {
  width: 220px;
}

.sort-actions {
  position: absolute;
  right: 12px;
  top: 50%;
  transform: translateY(-50%);
  display: flex;
  flex-direction: column;
  opacity: 0;
  transition: opacity 0.2s;
  background: #fff;
  box-shadow: -2px 0 10px #fff;
}

.target-item:hover .sort-actions {
  opacity: 1;
}

.editor-footer {
  padding: 16px 24px;
  border-top: 1px solid #f0f0f0;
  display: flex;
  justify-content: flex-end;
  gap: 12px;
  background: #fff;
}
</style>
