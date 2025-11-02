<template>
  <div class="model-attributes-editor">
    <n-collapse :default-expanded-names="['features']">
      <n-collapse-item name="features" :title="t('models.featureSupport')">
        <n-table :bordered="false" :single-line="false" size="small">
          <tbody>
            <tr v-for="attr in featureAttrs" :key="attr.key">
              <td style="width: 180px;">{{ attr.labelKey ? t(attr.labelKey) : attr.label }}</td>
              <td style="width: 80px; text-align: center;">
                <n-switch v-model:value="localAttributes[attr.key]" size="small" />
              </td>
              <td style="color: #999; font-size: 12px;">{{ attr.descriptionKey ? t(attr.descriptionKey) : attr.description }}</td>
            </tr>
          </tbody>
        </n-table>
      </n-collapse-item>

      <n-collapse-item name="performance" :title="t('models.performanceParams')">
        <n-space vertical :size="4">
          <div v-for="attr in performanceAttrs" :key="attr.key" class="attr-item">
            <n-form-item :label="attr.label" :label-width="140" size="small">
              <template #label>
                <n-space :size="4" align="center">
                  <span>{{ attr.label }}</span>
                  <n-tooltip>
                    <template #trigger>
                      <n-icon :size="14" style="cursor: help; color: #999;">
                        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">
                          <path fill="currentColor" d="M11 17h2v-6h-2v6zm1-8q.425 0 .713-.288T13 8q0-.425-.288-.713T12 7q-.425 0-.713.288T11 8q0 .425.288.713T12 9zm0 13q-2.075 0-3.9-.788t-3.175-2.137q-1.35-1.35-2.137-3.175T2 12q0-2.075.788-3.9t2.137-3.175q1.35-1.35 3.175-2.137T12 2q2.075 0 3.9.788t3.175 2.137q1.35 1.35 2.138 3.175T22 12q0 2.075-.788 3.9t-2.137 3.175q-1.35 1.35-3.175 2.138T12 22z"/>
                        </svg>
                      </n-icon>
                    </template>
                    {{ attr.description }}
                  </n-tooltip>
                </n-space>
              </template>
              <n-input-number
                v-model:value="localAttributes[attr.key] as number | null"
                :min="attr.min"
                :max="attr.max"
                :step="attr.step"
                :placeholder="`请输入${attr.label}`"
                size="small"
                clearable
                style="width: 100%"
              >
                <template #suffix v-if="attr.unit">
                  <span style="color: #999; font-size: 12px;">{{ attr.unit }}</span>
                </template>
              </n-input-number>
            </n-form-item>
          </div>
        </n-space>
      </n-collapse-item>

      <n-collapse-item name="cost" :title="t('models.costParams')">
        <n-space vertical :size="4">
          <div v-for="attr in costAttrs" :key="attr.key" class="attr-item">
            <n-form-item :label="attr.label" :label-width="140" size="small">
              <template #label>
                <n-space :size="4" align="center">
                  <span>{{ attr.label }}</span>
                  <n-tooltip>
                    <template #trigger>
                      <n-icon :size="14" style="cursor: help; color: #999;">
                        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">
                          <path fill="currentColor" d="M11 17h2v-6h-2v6zm1-8q.425 0 .713-.288T13 8q0-.425-.288-.713T12 7q-.425 0-.713.288T11 8q0 .425.288.713T12 9zm0 13q-2.075 0-3.9-.788t-3.175-2.137q-1.35-1.35-2.137-3.175T2 12q0-2.075.788-3.9t2.137-3.175q1.35-1.35 3.175-2.137T12 2q2.075 0 3.9.788t3.175 2.137q1.35 1.35 2.138 3.175T22 12q0 2.075-.788 3.9t-2.137 3.175q-1.35 1.35-3.175 2.138T12 22z"/>
                        </svg>
                      </n-icon>
                    </template>
                    {{ attr.description }}
                  </n-tooltip>
                </n-space>
              </template>
              <n-input-number
                v-model:value="localAttributes[attr.key] as number | null"
                :min="attr.min"
                :step="attr.step"
                :placeholder="`请输入${attr.label}`"
                size="small"
                clearable
                style="width: 100%"
              >
                <template #suffix v-if="attr.unit">
                  <span style="color: #999; font-size: 12px;">{{ attr.unit }}</span>
                </template>
              </n-input-number>
            </n-form-item>
          </div>
        </n-space>
      </n-collapse-item>
    </n-collapse>
  </div>
</template>

<script setup lang="ts">
import { ref, watch, computed, nextTick } from 'vue';
import { useI18n } from 'vue-i18n';
import { NCollapse, NCollapseItem, NSpace, NFormItem, NInputNumber, NSwitch, NTooltip, NIcon, NTable } from 'naive-ui';
import { getAttributesByCategory } from '@/constants/modelAttributes';
import { MILLION, COST_PRECISION } from '@/constants/numbers';
import type { ModelAttributes } from '@/types';

const { t } = useI18n();

const props = defineProps<{
  modelValue?: ModelAttributes | null;
}>();

const emit = defineEmits<{
  'update:modelValue': [value: ModelAttributes];
}>();

const localAttributes = ref<ModelAttributes>({});

const performanceAttrs = computed(() => getAttributesByCategory('性能参数'));
const costAttrs = computed(() => getAttributesByCategory('成本参数'));
const featureAttrs = computed(() => getAttributesByCategory('功能支持'));

const isUpdatingFromProps = ref(false);

// 成本相关的属性键
const COST_KEYS: Array<keyof ModelAttributes> = [
  'input_cost_per_token',
  'output_cost_per_token',
  'input_cost_per_token_cache_hit'
];

/**
 * 验证数值是否为有效的非负数
 */
function isValidNumber(value: unknown): value is number {
  return typeof value === 'number' && !isNaN(value) && value >= 0;
}

/**
 * 将 token 成本转换为每百万 token 成本 (Mtoken)
 */
function convertToMtoken(value: unknown): number | null {
  if (!isValidNumber(value)) return null;
  return Number((value * MILLION).toFixed(COST_PRECISION));
}

/**
 * 将每百万 token 成本转换回 token 成本
 */
function convertToToken(value: unknown): number | null {
  if (!isValidNumber(value)) return null;
  return value / MILLION;
}

watch(() => props.modelValue, async (newValue) => {
  isUpdatingFromProps.value = true;
  if (newValue) {
    const converted = { ...newValue };
    COST_KEYS.forEach(key => {
      const value = converted[key];
      if (value !== undefined && value !== null) {
        const mtokenValue = convertToMtoken(value);
        if (mtokenValue !== null) {
          converted[key] = mtokenValue as any;
        }
      }
    });
    localAttributes.value = converted;
  } else {
    localAttributes.value = {};
  }
  await nextTick();
  isUpdatingFromProps.value = false;
}, { immediate: true, deep: true });

watch(localAttributes, (newValue) => {
  if (isUpdatingFromProps.value) return;

  const cleanedValue: ModelAttributes = {};
  Object.entries(newValue).forEach(([key, value]) => {
    if (value !== null && value !== undefined && value !== '') {
      const typedKey = key as keyof ModelAttributes;
      let finalValue: number | boolean | string | undefined = value as any;
      
      if (COST_KEYS.includes(typedKey)) {
        const converted = convertToToken(value);
        if (converted !== null) {
          finalValue = converted;
        } else {
          return;
        }
      }
      cleanedValue[typedKey] = finalValue as any;
    }
  });
  emit('update:modelValue', cleanedValue);
}, { deep: true });
</script>

<style scoped>
.model-attributes-editor {
  max-height: 400px;
  overflow-y: auto;
}

.attr-item {
  padding: 0;
  margin: 0;
}

.attr-item :deep(.n-form-item) {
  margin-bottom: 0;
}

.attr-item :deep(.n-form-item-blank) {
  min-height: 28px;
}

.model-attributes-editor :deep(.n-table td) {
  border-bottom: none;
}
</style>

