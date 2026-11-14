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
          {{ t('virtualModels.viewConfig') }}
        </n-tooltip>
        <n-tooltip trigger="hover">
          <template #trigger>
            <n-button text size="small" @click="$emit('edit', config)">
              <template #icon>
                <n-icon><CreateOutline /></n-icon>
              </template>
            </n-button>
          </template>
          {{ t('common.edit') }}
        </n-tooltip>
        <n-popconfirm @positive-click="$emit('delete', config.id)">
          <template #trigger>
            <n-button text type="error" size="small">
              <template #icon>
                <n-icon><TrashOutline /></n-icon>
              </template>
            </n-button>
          </template>
          {{ t('virtualModels.deleteThis') }}
        </n-popconfirm>
      </div>
    </template>

    <div class="card-body">
      <div v-if="config.type === 'fallback'" class="strategy-view fallback-view">
        <div class="timeline-connector"></div>
        <div class="target-list">
          <div
            v-for="(target, index) in enrichedTargets"
            :key="target.provider + '-' + (target.modelName || index)"
            class="target-item fallback-item"
          >
            <div class="target-icon">
              <n-icon v-if="index === 0" :color="primaryColor.base"><CheckmarkCircle /></n-icon>
              <n-icon v-else :color="warningColor.base"><AlertCircleOutline /></n-icon>
            </div>
            <div class="target-content">
              <div class="target-main target-main-split">
                <div class="target-identity">
                  <n-tag size="tiny" :bordered="false" class="provider-tag">
                    {{ target.providerName }}
                  </n-tag>
                  <span class="model-name">{{ target.modelName }}</span>
                </div>
                <div class="target-main-side" v-if="getTargetStatus(target)">
                  <n-tag
                    size="tiny"
                    :type="getCircuitStateType(getTargetStatus(target)!.circuitState)"
                    class="status-badge"
                  >
                    {{ getCircuitStateLabel(getTargetStatus(target)!.circuitState) }}
                  </n-tag>
                  <n-tag
                    v-if="getTargetStatus(target)!.isAnonymousAffinitySelected"
                    size="tiny"
                    type="info"
                    class="status-badge is-secondary"
                  >
                    {{ t('virtualModels.selectedThisWindow') }}
                  </n-tag>
                </div>
              </div>
              <div class="target-meta" v-if="index > 0 && target.onStatusCodes?.length">
                <span class="meta-label">{{ t('virtualModels.trigger') }}</span>
                <span class="status-codes">{{ target.onStatusCodes.join(', ') }}</span>
              </div>
              <div class="target-subline" v-if="getBoundSessionCount(target) > 0">
                {{ t('virtualModels.boundSessions', { count: getBoundSessionCount(target) }) }}
              </div>
            </div>
            <div class="priority-badge">P{{ index + 1 }}</div>
          </div>
        </div>
      </div>

      <div v-else-if="config.type === 'loadbalance'" class="strategy-view lb-view">
        <div
          v-for="(target, index) in enrichedTargets"
          :key="target.provider + '-' + (target.modelName || index)"
          class="target-item lb-item"
        >
          <div class="lb-info">
            <div class="target-main target-main-split">
              <div class="target-identity">
                <n-tag size="tiny" :bordered="false" class="provider-tag">
                  {{ target.providerName }}
                </n-tag>
                <span class="model-name">{{ target.modelName }}</span>
              </div>
              <div class="target-main-side">
                <div class="target-status-inline" v-if="getTargetStatus(target)">
                  <n-tag
                    size="tiny"
                    :type="getCircuitStateType(getTargetStatus(target)!.circuitState)"
                    class="status-badge"
                  >
                    {{ getCircuitStateLabel(getTargetStatus(target)!.circuitState) }}
                  </n-tag>
                  <n-tag
                    v-if="getTargetStatus(target)!.isAnonymousAffinitySelected"
                    size="tiny"
                    type="info"
                    class="status-badge is-secondary"
                  >
                    {{ t('virtualModels.selectedThisWindow') }}
                  </n-tag>
                </div>
                <span class="weight-label">{{ (target.weight * 100).toFixed(0) }}%</span>
              </div>
            </div>
          </div>
          <n-progress
            type="line"
            :percentage="Math.round(target.weight * 100)"
            :show-indicator="false"
            :height="4"
            :color="getWeightColor(target.weight)"
            processing
          />
          <div class="target-subline" v-if="getBoundSessionCount(target) > 0">
            {{ t('virtualModels.boundSessions', { count: getBoundSessionCount(target) }) }}
          </div>
        </div>
      </div>

      <div v-else class="strategy-view default-view">
        <div
          v-for="(target, index) in enrichedTargets"
          :key="target.provider + '-' + (target.modelName || index)"
          class="target-item default-item"
        >
          <div class="target-content">
            <div class="target-main target-main-split">
              <div class="target-identity">
                <n-tag size="tiny" :bordered="false" class="provider-tag">
                  {{ target.providerName }}
                </n-tag>
                <span class="model-name">{{ target.modelName }}</span>
              </div>
              <div class="target-main-side" v-if="getTargetStatus(target)">
                <n-tag
                  size="tiny"
                  :type="getCircuitStateType(getTargetStatus(target)!.circuitState)"
                  class="status-badge"
                >
                  {{ getCircuitStateLabel(getTargetStatus(target)!.circuitState) }}
                </n-tag>
                <n-tag
                  v-if="getTargetStatus(target)!.isAnonymousAffinitySelected"
                  size="tiny"
                  type="info"
                  class="status-badge is-secondary"
                >
                  {{ t('virtualModels.selectedThisWindow') }}
                </n-tag>
              </div>
            </div>
            <div class="target-subline" v-if="getBoundSessionCount(target) > 0">
              {{ t('virtualModels.boundSessions', { count: getBoundSessionCount(target) }) }}
            </div>
          </div>
          <div class="priority-badge" v-if="config.type === 'time_priority'">P{{ index + 1 }}</div>
        </div>
        <div class="strategy-meta" v-if="config.type === 'affinity'">
          <n-icon><TimeOutline /></n-icon>
          <span>{{ t('virtualModels.affinityTtl', { seconds: (config.config.strategy.affinityTTL > 0 ? config.config.strategy.affinityTTL : DEFAULT_AFFINITY_TTL_MS) / 1000 }) }}</span>
        </div>
        <div class="strategy-meta" v-if="config.type === 'hash'">
          <n-icon><KeyOutline /></n-icon>
          <span>{{ t('virtualModels.hashSource', { source: config.config.strategy.hashSource }) }}</span>
        </div>
        <div class="strategy-meta" v-if="config.type === 'time_priority'">
          <n-icon><TimeOutline /></n-icon>
          <span>
            {{ t('virtualModels.timePriorityTimezone', { tz: config.config.strategy?.timezone || 'UTC' }) }}
            · {{ t('virtualModels.timePriorityRulesCount', { count: timeRules.length }) }}
          </span>
        </div>
        <div
          v-for="(rule, ruleIndex) in timeRules"
          :key="`time-rule-${ruleIndex}`"
          class="time-rule-summary"
        >
          <div class="rule-line">
            <span class="rule-days">{{ formatRuleDays(rule.days) }}</span>
            <span class="rule-range">
              {{ rule.start }}–{{ rule.end }}
              <template v-if="ruleCrossesMidnight(rule)">({{ t('wizard.crossMidnightTag') }})</template>
            </span>
          </div>
          <div class="rule-order">
            <n-tag
              v-for="(pos, position) in rule.target_order"
              :key="`${ruleIndex}-${pos}`"
              size="tiny"
              :bordered="false"
              class="order-chip"
            >
              {{ position + 1 }}. {{ ruleTargetLabel(pos) }}
            </n-tag>
          </div>
        </div>
      </div>
    </div>
  </n-card>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { 
  NCard, NTag, NText, NIcon, NButton, NTooltip, NPopconfirm, 
  NProgress 
} from 'naive-ui';
import {
  Code as CodeOutline, Pencil as CreateOutline, Trash2 as TrashOutline,
  CircleCheck as CheckmarkCircle, CircleAlert as AlertCircleOutline,
  Clock as TimeOutline, Key as KeyOutline
} from 'lucide-vue-next';

import type { RoutingTargetStatus } from '@/api/config';
import { primaryColor, infoColor, warningColor } from '@/styles/color-tokens';
import { ruleCrossesMidnight, type TimePriorityTimeRule } from '@/utils/time-priority';

const props = defineProps<{
  config: any;
  providers: any[];
  models: any[];
  routingStatus?: RoutingTargetStatus[];
}>();

defineEmits(['edit', 'preview', 'delete']);

const { t } = useI18n();

// 后端未配置 affinityTTL 时的回退值：与 EXPLICIT_AFFINITY_IDLE_TTL_MS 默认值（60 分钟）保持一致。
const DEFAULT_AFFINITY_TTL_MS = 3_600_000;

const typeConfig = computed(() => {
  const map: Record<string, any> = {
    'loadbalance': { label: t('virtualModels.typeLoadBalance'), tagType: 'info' },
    'fallback': { label: t('virtualModels.typeFallback'), tagType: 'warning' },
    'hash': { label: t('virtualModels.typeHash'), tagType: 'success' },
    'affinity': { label: t('virtualModels.typeAffinity'), tagType: 'error' },
    'time_priority': { label: t('virtualModels.typeTimePriority'), tagType: 'info' }
  };
  return map[props.config.type] || { label: props.config.type, tagType: 'default' };
});

function getTargetKey(target: any): string {
  const overrideModel = target.override_params?.model?.trim();
  if (!overrideModel) {
    return target.provider;
  }
  return `${target.provider}::${overrideModel}`;
}

function getTargetStatus(target: any): RoutingTargetStatus | undefined {
  if (!props.routingStatus) return undefined;
  const key = getTargetKey(target);
  return props.routingStatus.find(s => s.targetKey === key);
}

function getBoundSessionCount(target: any): number {
  return getTargetStatus(target)?.boundSessionCount ?? 0;
}

function getCircuitStateType(state: string): 'success' | 'error' | 'warning' {
  switch (state) {
    case 'OPEN':
      return 'error';
    case 'HALF_OPEN':
      return 'warning';
    case 'CLOSED':
    default:
      return 'success';
  }
}

function getCircuitStateLabel(state: string): string {
  switch (state) {
    case 'OPEN':
      return t('virtualModels.circuitOpen');
    case 'HALF_OPEN':
      return t('virtualModels.circuitHalfOpen');
    case 'CLOSED':
    default:
      return t('virtualModels.circuitClosed');
  }
}

const enrichedTargets = computed(() => {
  if (!props.config.config?.targets) return [];

  return props.config.config.targets.map((t: any) => {
    const provider = props.providers.find(p => p.id === t.provider);
    const modelId = t.override_params?.model;
    const model = props.models.find(m => m.modelIdentifier === modelId && m.providerId === t.provider);

    return {
      ...t,
      providerName: provider?.name || t.provider,
      modelName: model?.name || modelId || 'Default Model'
    };
  });
});

const timeRules = computed<TimePriorityTimeRule[]>(() => {
  if (props.config.type !== 'time_priority') return [];
  const raw = props.config.config?.strategy?.time_rules;
  return Array.isArray(raw) ? (raw as TimePriorityTimeRule[]) : [];
});

const weekdayShortLabels = computed(() => [
  t('wizard.weekdayShort0'),
  t('wizard.weekdayShort1'),
  t('wizard.weekdayShort2'),
  t('wizard.weekdayShort3'),
  t('wizard.weekdayShort4'),
  t('wizard.weekdayShort5'),
  t('wizard.weekdayShort6'),
]);

function formatRuleDays(days: number[]) {
  return [...days]
    .sort((a, b) => a - b)
    .map(day => weekdayShortLabels.value[day] ?? String(day))
    .join(' ');
}

function ruleTargetLabel(pos: number) {
  const target = enrichedTargets.value[pos];
  if (!target) return `#${pos + 1}`;
  return `${target.providerName}/${target.modelName}`;
}

function getWeightColor(weight: number) {
  if (weight >= 0.8) return primaryColor.base;
  if (weight >= 0.4) return infoColor.base;
  return warningColor.base;
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

.type-fallback:hover { border-color: color-mix(in srgb, var(--color-warning) 30%, transparent); }
.type-loadbalance:hover { border-color: color-mix(in srgb, var(--color-info) 30%, transparent); }

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
  gap: 8px;
}

.card-body {
  padding-top: 8px;
  flex: 1;
}

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
  background: var(--color-neutral-200);
  z-index: 0;
}

.fallback-item {
  display: flex;
  align-items: center;
  gap: 8px;
  position: relative;
  z-index: 1;
  background: var(--color-neutral-0);
  padding: 4px 0;
}

.target-icon {
  font-size: 18px;
  background: var(--color-neutral-0);
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

.target-main-split {
  justify-content: space-between;
  gap: 12px;
}

.target-identity {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  flex: 1;
}

.target-main-side {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  flex-wrap: wrap;
}

.target-status-inline {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  justify-content: flex-end;
}

.target-meta {
  font-size: 11px;
  color: var(--color-neutral-700);
  margin-top: 6px;
}

.status-badge {
  font-size: 10px;
  height: 18px;
  padding: 0 6px;
}

.status-badge.is-secondary {
  opacity: 0.92;
}

.target-subline {
  font-size: 11px;
  color: var(--color-neutral-700);
  margin-top: 6px;
}

.priority-badge {
  font-size: 10px;
  color: var(--color-neutral-700);
  font-family: monospace;
}

.provider-tag {
  background: var(--color-neutral-50);
  color: var(--color-neutral-700);
  font-size: 11px;
  height: 18px;
  padding: 0 4px;
}

.model-name {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  font-weight: 500;
  color: var(--color-text);
}

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
}

.weight-label {
  font-size: 12px;
  color: var(--color-neutral-700);
  font-weight: 600;
  font-family: monospace;
}

.default-view {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.default-item {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  background: var(--color-neutral-50);
  padding: 6px 10px;
  border-radius: 6px;
}

@media (max-width: 768px) {
  .target-main-split {
    align-items: flex-start;
    flex-direction: column;
  }

  .target-main-side,
  .target-status-inline {
    justify-content: flex-start;
  }
}

.strategy-meta {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--color-neutral-700);
  margin-top: 4px;
  padding-left: 2px;
}

.time-rule-summary {
  display: flex;
  flex-direction: column;
  gap: 4px;
  background: var(--color-neutral-50);
  border-radius: 6px;
  padding: 6px 10px;
  margin-top: 6px;
}

.rule-line {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  font-size: 12px;
}

.rule-days {
  color: var(--color-text);
  font-weight: 500;
}

.rule-range {
  color: var(--color-neutral-700);
  font-family: monospace;
  white-space: nowrap;
}

.rule-order {
  display: flex;
  gap: 4px;
  flex-wrap: wrap;
}

.rule-order .order-chip {
  font-size: 10px;
  height: 18px;
  padding: 0 6px;
  max-width: 100%;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
</style>
