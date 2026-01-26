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

    <n-drawer v-model:show="showExpertDrawer" :width="640">
      <n-drawer-content :title="t('expertRouting.editExpert')">
        <ExpertForm
          v-if="showExpertDrawer"
          v-model:expert="editingExpert"
          :utterances="editingUtterances"
          :show-utterances="showUtterances"
          :provider-options="providerOptions"
          :virtual-model-options="virtualModelOptions"
          @save="handleSaveExpert"
          @cancel="showExpertDrawer = false"
        />
      </n-drawer-content>
    </n-drawer>

    <n-modal
      v-model:show="showTemplateSelector"
      preset="card"
      :title="t('expertRouting.selectExpertTemplate')"
      class="template-selector-modal"
      :style="{ width: '1200px', maxWidth: '95vw', height: '85vh' }"
      :bordered="false"
      size="huge"
    >
      <ExpertTemplateSelector v-if="showTemplateSelector" @select="handleTemplateSelect" />
    </n-modal>
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
  NModal,
  useDialog,
} from 'naive-ui';
import {
  AddOutline,
  CloseOutline,
  EnterOutline,
  FilterOutline,
  CubeOutline,
} from '@vicons/ionicons5';
import type { ExpertTarget, ClassifierConfig, ExpertTemplate } from '@/api/expert-routing';
import ExpertForm from './ExpertForm.vue';
import ExpertTemplateSelector from './ExpertTemplateSelector.vue';

function generateId(): string {
  return `expert_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}

const { t } = useI18n();
const dialog = useDialog();

interface Props {
  experts?: ExpertTarget[];
  routes?: { category: string; utterances: string[] }[];
  classifierConfig: ClassifierConfig;
  providerOptions?: Array<{ label: string; value: string }>;
  virtualModelOptions?: Array<{ label: string; value: string }>;
  config?: any;
  editable?: boolean;
  showUtterances?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
  experts: () => [],
  routes: () => [],
  editable: false,
  showUtterances: false,
});

const emit = defineEmits<{
  'update:experts': [experts: ExpertTarget[]];
  'update:routes': [routes: { category: string; utterances: string[] }[]];
}>();

const localExperts = ref<ExpertTarget[]>([...props.experts]);
const localRoutes = ref<{ category: string; utterances: string[] }[]>([...(props.routes || [])]);
const showExpertDrawer = ref(false);
const showTemplateSelector = ref(false);
const editingExpert = ref<ExpertTarget>({
  id: '',
  category: '',
  type: 'real',
});
const editingUtterances = ref<string[]>([]);

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
  showTemplateSelector.value = true;
}

function handleTemplateSelect(template: ExpertTemplate | null) {
  showTemplateSelector.value = false;
  
  // Use color from template or default blue
  const colorMap: Record<string, string> = {
    'debug': '#d03050',
    'explain': '#2080f0',
    'feature': '#18a058',
    'plan': '#f0a020',
    'refactor': '#8a2be2',
    'review': '#f5222d',
    'setup': '#707070',
    'test': '#10b981',
    'utility': '#0ea5e9'
  };

  const defaultColor = template && colorMap[template.value] ? colorMap[template.value] : '#1890ff';

  editingExpert.value = {
    id: generateId(),
    category: template ? template.value : '',
    type: 'real',
    description: template ? template.description : '',
    color: defaultColor,
    system_prompt: template?.system_prompt,
  };
  
  editingUtterances.value = template ? [...template.utterances] : [];
  showExpertDrawer.value = true;
}

function handleEditExpert(expert: ExpertTarget) {
  editingExpert.value = { ...expert };
  const route = localRoutes.value.find(r => r.category === expert.category);
  editingUtterances.value = route ? [...route.utterances] : [];
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
      const expert = localExperts.value.find(e => e.id === expertId);
      if (!expert) return;
      const category = expert.category;

      localExperts.value = localExperts.value.filter(e => e.id !== expertId);
      emit('update:experts', localExperts.value);

      // Cleanup route if orphan
      const isUsed = localExperts.value.some(e => e.category === category);
      if (!isUsed) {
        const routes = localRoutes.value.filter(r => r.category !== category);
        localRoutes.value = routes;
        emit('update:routes', routes);
      }
    },
  });
}

function handleSaveExpert(expert: ExpertTarget, utterances: string[]) {
  const index = localExperts.value.findIndex(e => e.id === expert.id);
  const oldCategory = index >= 0 ? localExperts.value[index].category : null;
  
  if (index >= 0) {
    localExperts.value[index] = expert;
  } else {
    localExperts.value.push(expert);
  }
  emit('update:experts', localExperts.value);

  // Update Routes
  let routes = [...localRoutes.value];
  
  // Clean up old route if category changed and no other expert uses it
  if (oldCategory && oldCategory !== expert.category) {
    const isUsed = localExperts.value.some(e => e.category === oldCategory);
    if (!isUsed) {
      routes = routes.filter(r => r.category !== oldCategory);
    }
  }

  const routeIndex = routes.findIndex(r => r.category === expert.category);
  
  if (routeIndex >= 0) {
    routes[routeIndex] = { ...routes[routeIndex], utterances };
  } else {
    routes.push({ category: expert.category, utterances });
  }
  
  localRoutes.value = routes;
  emit('update:routes', routes);

  showExpertDrawer.value = false;
}

// Deep watch forces Vue to traverse the whole experts/routes tree on each render,
// which can be very expensive when utterances/rules grow.
watch(() => props.experts, (newExperts) => {
  localExperts.value = [...newExperts];
});

watch(() => props.routes, (newRoutes) => {
  localRoutes.value = [...(newRoutes || [])];
});

watch(
  () => props.config,
  (newConfig) => {
    if (newConfig?.config?.experts) {
      localExperts.value = [...newConfig.config.experts];
    }
  },
  { immediate: true }
);
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

<style>
.template-selector-modal {
  display: flex !important;
  flex-direction: column;
}

.template-selector-modal .n-card__content {
  flex: 1;
  overflow-y: auto;
  padding: 0 !important;
}
</style>
