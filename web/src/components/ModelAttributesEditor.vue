<template>
  <div class="model-attributes-editor">
    <n-collapse :default-expanded-names="['performance', 'cost', 'features']">
      <n-collapse-item name="performance" title="性能参数">
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
                v-model:value="localAttributes[attr.key]"
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

      <n-collapse-item name="cost" title="成本参数">
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
                v-model:value="localAttributes[attr.key]"
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

      <n-collapse-item name="features" title="功能支持">
        <div class="features-grid">
          <div
            v-for="attr in featureAttrs"
            :key="attr.key"
            class="feature-item"
          >
            <n-space :size="6" align="center">
              <n-switch v-model:value="localAttributes[attr.key]" size="small" @click.stop />
              <span class="feature-label" @click="toggleFeature(attr.key)">{{ attr.label }}</span>
              <n-tooltip>
                <template #trigger>
                  <n-icon :size="14" style="cursor: help; color: #999;" @click.stop>
                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">
                      <path fill="currentColor" d="M11 17h2v-6h-2v6zm1-8q.425 0 .713-.288T13 8q0-.425-.288-.713T12 7q-.425 0-.713.288T11 8q0 .425.288.713T12 9zm0 13q-2.075 0-3.9-.788t-3.175-2.137q-1.35-1.35-2.137-3.175T2 12q0-2.075.788-3.9t2.137-3.175q1.35-1.35 3.175-2.137T12 2q2.075 0 3.9.788t3.175 2.137q1.35 1.35 2.138 3.175T22 12q0 2.075-.788 3.9t-2.137 3.175q-1.35 1.35-3.175 2.138T12 22z"/>
                    </svg>
                  </n-icon>
                </template>
                {{ attr.description }}
              </n-tooltip>
            </n-space>
          </div>
        </div>
      </n-collapse-item>
    </n-collapse>
  </div>
</template>

<script setup lang="ts">
import { ref, watch, computed, nextTick } from 'vue';
import { NCollapse, NCollapseItem, NSpace, NFormItem, NInputNumber, NSwitch, NTooltip, NIcon } from 'naive-ui';
import { getAttributesByCategory } from '@/constants/modelAttributes';
import type { ModelAttributes } from '@/types';

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

function toggleFeature(key: keyof ModelAttributes) {
  localAttributes.value[key] = !localAttributes.value[key];
}

watch(() => props.modelValue, async (newValue) => {
  isUpdatingFromProps.value = true;
  if (newValue) {
    localAttributes.value = { ...newValue };
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
      cleanedValue[key as keyof ModelAttributes] = value as any;
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

.features-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 6px 12px;
  padding: 4px 0;
}

.feature-item {
  display: flex;
  align-items: center;
  min-height: 32px;
  padding: 6px 10px;
  border-radius: 6px;
  border: 1px solid transparent;
}

.feature-label {
  font-size: 13px;
  user-select: none;
  cursor: pointer;
  flex: 1;
}
</style>

