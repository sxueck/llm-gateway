<template>
  <div class="time-rules-editor">
    <div class="rules-header">
      <span class="rules-title">{{ t('wizard.timeRules') }}</span>
      <n-button size="small" type="primary" dashed @click="addRule">
        <template #icon><n-icon :component="Add" /></template>
        {{ t('wizard.addTimeRule') }}
      </n-button>
    </div>
    <div class="rules-hint">{{ t('wizard.timePrioritySoftHint') }}</div>

    <div v-if="rules.length === 0" class="rules-empty">{{ t('wizard.tpRuleRequired') }}</div>

    <div
      v-for="(rule, index) in rules"
      :key="index"
      class="rule-item"
      :class="{ 'is-active': index === activeRuleIndex }"
    >
      <div class="rule-top">
        <span class="rule-index">{{ index + 1 }}</span>
        <div class="rule-days">
          <n-button
            v-for="day in 7"
            :key="day - 1"
            size="tiny"
            :type="rule.days.includes(day - 1) ? 'primary' : 'default'"
            :secondary="rule.days.includes(day - 1)"
            class="day-btn"
            @click="toggleDay(index, day - 1)"
          >
            {{ weekdayShortLabels[day - 1] }}
          </n-button>
        </div>
        <n-tag
          v-if="ruleCrossesMidnight(rule)"
          size="tiny"
          :bordered="false"
          type="warning"
          class="overnight-tag"
        >
          {{ t('wizard.crossMidnightTag') }}
        </n-tag>
        <n-tag v-if="index === activeRuleIndex" size="tiny" type="success" class="now-tag">
          {{ t('wizard.activeNowTag') }}
        </n-tag>
        <n-button text size="tiny" class="rule-remove" @click="removeRule(index)">
          <n-icon :component="TrashOutline" />
        </n-button>
      </div>

      <div class="rule-times">
        <div class="time-field">
          <span class="field-label">{{ t('wizard.timeRuleStartLabel') }}</span>
          <n-time-picker
            :value="hhmmToTimeValue(rule.start)"
            format="HH:mm"
            size="small"
            class="time-picker"
            @update:value="(value: number | null) => updateRule(index, { start: timeValueToHHmm(value) })"
          />
        </div>
        <span class="time-sep">–</span>
        <div class="time-field">
          <span class="field-label">{{ t('wizard.timeRuleEndLabel') }}</span>
          <div class="end-control">
            <!-- 后端契约允许 end='24:00'（当天收尾）；naive-ui 时间选择器只到 23:59，
                 因此用显式按钮切换，读取/保存均原样保留 '24:00'，不做静默改写 -->
            <n-button
              v-if="isEndOfDay(rule.end)"
              size="small"
              type="primary"
              secondary
              class="time-picker end-of-day-btn"
              :title="t('wizard.timeRuleEndOfDayHint')"
              @click="updateRule(index, { end: END_OF_DAY_PICKER_FALLBACK })"
            >
              {{ END_OF_DAY_HHMM }}
            </n-button>
            <n-time-picker
              v-else
              :value="hhmmToTimeValue(rule.end)"
              format="HH:mm"
              size="small"
              class="time-picker"
              @update:value="(value: number | null) => updateRule(index, { end: timeValueToHHmm(value) })"
            />
            <n-button
              v-if="!isEndOfDay(rule.end)"
              size="tiny"
              dashed
              class="end-of-day-toggle"
              :title="t('wizard.timeRuleEndOfDayHint')"
              @click="updateRule(index, { end: END_OF_DAY_HHMM })"
            >
              {{ END_OF_DAY_HHMM }}
            </n-button>
          </div>
        </div>
      </div>

      <div class="rule-order">
        <span class="field-label">{{ t('wizard.timeRuleOrderLabel') }}</span>
        <div class="order-list">
          <div v-for="(pos, position) in rule.target_order" :key="pos" class="order-chip">
            <span class="order-rank">{{ position + 1 }}</span>
            <span class="order-name">{{ targetLabels[pos] ?? `#${pos + 1}` }}</span>
            <span class="order-actions">
              <n-button text size="tiny" :disabled="position === 0" @click="moveOrder(index, position, -1)">
                <n-icon :component="ArrowUp" />
              </n-button>
              <n-button
                text
                size="tiny"
                :disabled="position === rule.target_order.length - 1"
                @click="moveOrder(index, position, 1)"
              >
                <n-icon :component="ArrowDown" />
              </n-button>
            </span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { NButton, NIcon, NTag, NTimePicker } from 'naive-ui';
import { Add, TrashOutline, ArrowUp, ArrowDown } from '@vicons/ionicons5';
import {
  defaultTargetOrder,
  END_OF_DAY_HHMM,
  findActiveRuleIndex,
  getZonedParts,
  hhmmToTimeValue,
  isEndOfDayHHmm,
  isIanaTimezone,
  isValidTargetOrder,
  repairTargetOrder,
  ruleCrossesMidnight,
  timeValueToHHmm,
  type TimePriorityTimeRule,
  type ZonedParts,
} from '@/utils/time-priority';

const props = defineProps<{
  rules: TimePriorityTimeRule[];
  /** targets 数量，target_order 必须是它的全排列 */
  targetCount: number;
  /** targets 的展示名（与索引对应） */
  targetLabels: string[];
  timezone: string;
}>();

const emit = defineEmits<{ 'update:rules': [rules: TimePriorityTimeRule[]] }>();

const { t } = useI18n();

// 关闭 24:00 后回落到的最近可选时刻（时间选择器无法表达 24:00）
const END_OF_DAY_PICKER_FALLBACK = '23:59';

function isEndOfDay(value: string): boolean {
  return isEndOfDayHHmm(value);
}

const weekdayShortLabels = computed(() => [
  t('wizard.weekdayShort0'),
  t('wizard.weekdayShort1'),
  t('wizard.weekdayShort2'),
  t('wizard.weekdayShort3'),
  t('wizard.weekdayShort4'),
  t('wizard.weekdayShort5'),
  t('wizard.weekdayShort6'),
]);

const effectiveTimezone = computed(() => (isIanaTimezone(props.timezone) ? props.timezone : 'UTC'));

const nowParts = ref<ZonedParts | null>(getZonedParts(new Date(), effectiveTimezone.value));
let nowTimer: ReturnType<typeof setInterval> | null = null;

// 当前生效规则（按配置时区），30s 刷新一次
const activeRuleIndex = computed(() => {
  const parts = nowParts.value;
  if (!parts) return -1;
  return findActiveRuleIndex(props.rules, parts.day, parts.minutes);
});

watch(effectiveTimezone, tz => {
  nowParts.value = getZonedParts(new Date(), tz);
});

onMounted(() => {
  nowTimer = setInterval(() => {
    nowParts.value = getZonedParts(new Date(), effectiveTimezone.value);
  }, 30_000);
});

onBeforeUnmount(() => {
  if (nowTimer) clearInterval(nowTimer);
});

// targets 增删后修复 target_order：保留有效相对顺序并补齐缺失索引
watch(
  () => props.targetCount,
  count => {
    if (props.rules.every(rule => isValidTargetOrder(rule.target_order, count))) return;
    emit('update:rules', props.rules.map(rule => ({
      ...rule,
      target_order: repairTargetOrder(rule.target_order, count),
    })));
  },
  { immediate: true },
);

function commit(rules: TimePriorityTimeRule[]) {
  emit('update:rules', rules);
}

function addRule() {
  commit([
    ...props.rules,
    {
      days: [1, 2, 3, 4, 5],
      start: '09:00',
      end: '18:00',
      target_order: defaultTargetOrder(props.targetCount),
    },
  ]);
}

function removeRule(index: number) {
  commit(props.rules.filter((_, i) => i !== index));
}

function updateRule(index: number, patch: Partial<TimePriorityTimeRule>) {
  commit(props.rules.map((rule, i) => (i === index ? { ...rule, ...patch } : rule)));
}

function toggleDay(ruleIndex: number, day: number) {
  const rule = props.rules[ruleIndex];
  if (!rule) return;
  const days = rule.days.includes(day)
    ? rule.days.filter(d => d !== day)
    : [...rule.days, day].sort((a, b) => a - b);
  updateRule(ruleIndex, { days });
}

function moveOrder(ruleIndex: number, position: number, direction: -1 | 1) {
  const rule = props.rules[ruleIndex];
  if (!rule) return;
  const order = [...rule.target_order];
  const target = position + direction;
  if (target < 0 || target >= order.length) return;
  [order[position], order[target]] = [order[target], order[position]];
  updateRule(ruleIndex, { target_order: order });
}
</script>

<style scoped>
.time-rules-editor {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.rules-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.rules-title {
  font-size: 12px;
  font-weight: 600;
  color: #999;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.rules-hint {
  font-size: 12px;
  color: #999;
  line-height: 1.6;
  background: #fafafa;
  border: 1px solid #f0f0f0;
  border-radius: 6px;
  padding: 8px 10px;
}

.rules-empty {
  font-size: 13px;
  color: #d03050;
  background: rgba(208, 48, 80, 0.04);
  border: 1px dashed rgba(208, 48, 80, 0.3);
  border-radius: 6px;
  padding: 10px 12px;
}

.rule-item {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px 14px;
  border: 1px solid #eee;
  border-radius: 8px;
  background: #fff;
  transition: border-color 0.2s, box-shadow 0.2s;
}

.rule-item:hover {
  border-color: #d9d9d9;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.04);
}

.rule-item.is-active {
  border-color: rgba(24, 160, 88, 0.45);
  box-shadow: 0 0 0 1px rgba(24, 160, 88, 0.15);
}

.rule-top {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.rule-index {
  width: 20px;
  height: 20px;
  border-radius: 50%;
  background: #f0f0f0;
  color: #999;
  font-size: 11px;
  font-weight: 600;
  display: inline-flex;
  justify-content: center;
  align-items: center;
}

.rule-days {
  display: flex;
  gap: 4px;
  flex-wrap: wrap;
}

.day-btn {
  min-width: 34px;
}

.overnight-tag,
.now-tag {
  font-size: 10px;
  height: 18px;
  padding: 0 6px;
}

.rule-remove {
  margin-left: auto;
  color: #999;
  opacity: 0.6;
}

.rule-item:hover .rule-remove {
  opacity: 1;
}

.rule-remove:hover {
  color: #d03050;
}

.rule-times {
  display: flex;
  align-items: flex-end;
  gap: 8px;
}

.time-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.time-picker {
  width: 110px;
}

.end-control {
  display: flex;
  align-items: center;
  gap: 4px;
}

.end-of-day-toggle {
  min-width: 44px;
}

.end-of-day-btn {
  justify-content: center;
  font-variant-numeric: tabular-nums;
}

.time-sep {
  padding-bottom: 6px;
  color: #999;
}

.field-label {
  font-size: 11px;
  color: #666;
}

.rule-order {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.order-list {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.order-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  background: #f9f9fa;
  border: 1px solid #eee;
  border-radius: 6px;
  padding: 3px 8px;
  font-size: 12px;
}

.order-rank {
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: var(--n-color-primary, #18a058);
  color: #fff;
  font-size: 10px;
  font-weight: 600;
  display: inline-flex;
  justify-content: center;
  align-items: center;
}

.order-name {
  max-width: 180px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  color: #333;
}

.order-actions {
  display: inline-flex;
  flex-direction: column;
  opacity: 0;
  transition: opacity 0.2s;
}

.order-chip:hover .order-actions {
  opacity: 1;
}
</style>
