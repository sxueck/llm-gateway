<template>
  <div class="expert-routing-visualization" :class="{ 'preview-mode': !editable }">
    <div v-if="editable" class="toolbar">
      <n-space>
        <n-button size="small" @click="handleAddExpert">
          <template #icon>
            <n-icon><AddOutline /></n-icon>
          </template>
          {{ t('expertRouting.addExpert') }}
        </n-button>
        <n-text depth="3" style="font-size: 12px">
          {{ t('expertRouting.clickToEdit') }}
        </n-text>
      </n-space>
    </div>

    <div class="visualization-container">
      <div class="node entry-node">
        <div class="node-header">
          <n-icon size="20"><EnterOutline /></n-icon>
          <span>{{ t('expertRouting.entryNode') }}</span>
        </div>
        <div class="node-body">
          <n-text depth="3" style="font-size: 12px">
            {{ t('expertRouting.entryNodeDesc') }}
          </n-text>
        </div>
      </div>

      <div class="arrow">→</div>

      <div class="node classifier-node" @click="editable ? handleEditClassifier() : undefined">
        <div class="node-header">
          <n-icon size="20"><FilterOutline /></n-icon>
          <span>{{ t('expertRouting.classifier') }}</span>
        </div>
        <div class="node-body">
          <n-text depth="3" style="font-size: 12px">
            {{ classifierLabel }}
          </n-text>
          <n-tag size="tiny" :type="classifierConfig.type === 'virtual' ? 'info' : 'success'">
            {{ classifierConfig.type === 'virtual' ? t('expertRouting.virtualModel') : t('expertRouting.realModel') }}
          </n-tag>
        </div>
      </div>

      <div class="arrow">→</div>

      <div class="experts-container">
        <div
          v-for="(expert, index) in localExperts"
          :key="expert.id"
          class="expert-item"
        >
          <div class="node expert-node" @click="editable ? handleEditExpert(expert) : undefined">
            <div class="node-header" :style="{ backgroundColor: expert.color || '#f0f0f0' }">
              <n-icon size="18"><CubeOutline /></n-icon>
              <span>{{ expert.category }}</span>
              <n-button
                v-if="editable"
                text
                size="tiny"
                @click.stop="handleDeleteExpert(expert.id)"
              >
                <template #icon>
                  <n-icon><CloseOutline /></n-icon>
                </template>
              </n-button>
            </div>
            <div class="node-body">
              <n-text depth="3" style="font-size: 12px">
                {{ getExpertLabel(expert) }}
              </n-text>
              <n-tag size="tiny" :type="expert.type === 'virtual' ? 'info' : 'success'">
                {{ expert.type === 'virtual' ? t('expertRouting.virtualModel') : t('expertRouting.realModel') }}
              </n-tag>
            </div>
          </div>
          <div v-if="index < localExperts.length - 1" class="expert-divider">
            <n-divider style="margin: 8px 0" />
          </div>
        </div>

        <n-empty
          v-if="localExperts.length === 0"
          :description="t('expertRouting.noExperts')"
          :show-icon="false"
          size="small"
          style="padding: 20px"
        >
          <template v-if="editable" #extra>
            <n-button size="small" @click="handleAddExpert">
              {{ t('expertRouting.addFirstExpert') }}
            </n-button>
          </template>
        </n-empty>
      </div>
    </div>

    <n-drawer v-model:show="showExpertDrawer" :width="400">
      <n-drawer-content :title="t('expertRouting.editExpert')">
        <ExpertForm
          v-if="showExpertDrawer"
          v-model:expert="editingExpert"
          :provider-options="providerOptions"
          :virtual-model-options="virtualModelOptions"
          @save="handleSaveExpert"
          @cancel="showExpertDrawer = false"
        />
      </n-drawer-content>
    </n-drawer>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import {
  NSpace,
  NButton,
  NIcon,
  NText,
  NTag,
  NEmpty,
  NDivider,
  NDrawer,
  NDrawerContent,
  useDialog,
} from 'naive-ui';
import {
  AddOutline,
  CloseOutline,
  EnterOutline,
  FilterOutline,
  CubeOutline,
} from '@vicons/ionicons5';
import type { ExpertTarget, ClassifierConfig } from '@/api/expert-routing';
import ExpertForm from './ExpertForm.vue';

function generateId(): string {
  return `expert_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}

const { t } = useI18n();
const dialog = useDialog();

interface Props {
  experts?: ExpertTarget[];
  classifierConfig: ClassifierConfig;
  providerOptions?: Array<{ label: string; value: string }>;
  virtualModelOptions?: Array<{ label: string; value: string }>;
  config?: any;
  editable?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
  experts: () => [],
  editable: false,
});

const emit = defineEmits<{
  'update:experts': [experts: ExpertTarget[]];
}>();

const localExperts = ref<ExpertTarget[]>([...props.experts]);
const showExpertDrawer = ref(false);
const editingExpert = ref<ExpertTarget>({
  id: '',
  category: '',
  type: 'real',
});

const classifierLabel = computed(() => {
  if (props.classifierConfig.type === 'virtual') {
    const option = props.virtualModelOptions?.find(o => o.value === props.classifierConfig.model_id);
    return option?.label || props.classifierConfig.model_id || '';
  } else {
    return props.classifierConfig.model || '';
  }
});

function getExpertLabel(expert: ExpertTarget): string {
  if (expert.type === 'virtual') {
    const option = props.virtualModelOptions?.find(o => o.value === expert.model_id);
    return option?.label || expert.model_id || '';
  } else {
    return expert.model || '';
  }
}

function handleAddExpert() {
  editingExpert.value = {
    id: generateId(),
    category: '',
    type: 'real',
    description: '',
    color: '#1890ff',
  };
  showExpertDrawer.value = true;
}

function handleEditExpert(expert: ExpertTarget) {
  editingExpert.value = { ...expert };
  showExpertDrawer.value = true;
}

function handleEditClassifier() {
  // TODO: 实现分类器编辑功能
}

function handleDeleteExpert(expertId: string) {
  dialog.warning({
    title: t('common.warning'),
    content: t('expertRouting.deleteExpertConfirm'),
    positiveText: t('common.confirm'),
    negativeText: t('common.cancel'),
    onPositiveClick: () => {
      localExperts.value = localExperts.value.filter(e => e.id !== expertId);
      emit('update:experts', localExperts.value);
    },
  });
}

function handleSaveExpert(expert: ExpertTarget) {
  const index = localExperts.value.findIndex(e => e.id === expert.id);
  if (index >= 0) {
    localExperts.value[index] = expert;
  } else {
    localExperts.value.push(expert);
  }
  emit('update:experts', localExperts.value);
  showExpertDrawer.value = false;
}

watch(() => props.experts, (newExperts) => {
  localExperts.value = [...newExperts];
}, { deep: true });

watch(() => props.config, (newConfig) => {
  if (newConfig?.config?.experts) {
    localExperts.value = [...newConfig.config.experts];
  }
}, { deep: true, immediate: true });
</script>

<style scoped>
.expert-routing-visualization {
  min-height: 400px;
  display: flex;
  flex-direction: column;
}

.toolbar {
  padding: 12px;
  border-bottom: 1px solid #e0e0e0;
  background-color: #fff;
}

.visualization-container {
  flex: 1;
  padding: 24px;
  display: flex;
  align-items: center;
  gap: 16px;
  overflow-x: auto;
}

.preview-mode .visualization-container {
  padding: 16px;
  min-height: auto;
}

.preview-mode {
  min-height: auto;
}

.node {
  width: 180px;
  background-color: #fff;
  border: 2px solid #d9d9d9;
  border-radius: 8px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
  cursor: pointer;
  transition: all 0.3s;
  flex-shrink: 0;
}

.node:hover {
  border-color: #40a9ff;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
}

.preview-mode .node {
  width: 160px;
  border-width: 1.5px;
}

.preview-mode .node:hover {
  border-color: #d9d9d9;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
  transform: none;
}

.node-header {
  padding: 8px 12px;
  background-color: #f0f0f0;
  border-bottom: 1px solid #d9d9d9;
  border-radius: 6px 6px 0 0;
  display: flex;
  align-items: center;
  gap: 8px;
  font-weight: 500;
}

.preview-mode .node-header {
  padding: 6px 10px;
  font-size: 13px;
}

.node-body {
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.preview-mode .node-body {
  padding: 8px 10px;
}

.entry-node {
  border-color: #52c41a;
  cursor: default;
}

.entry-node:hover {
  border-color: #52c41a;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
}

.preview-mode .entry-node:hover {
  border-color: #52c41a;
}

.classifier-node {
  border-color: #1890ff;
}

.preview-mode .classifier-node:hover {
  border-color: #1890ff;
}

.arrow {
  font-size: 24px;
  color: #999;
  display: flex;
  align-items: center;
  padding-top: 40px;
  flex-shrink: 0;
}

.preview-mode .arrow {
  font-size: 20px;
  padding-top: 30px;
}

.experts-container {
  display: flex;
  flex-direction: column;
  gap: 0;
  flex-shrink: 0;
}

.expert-item {
  display: flex;
  flex-direction: column;
}

.expert-divider {
  width: 100%;
}
</style>

