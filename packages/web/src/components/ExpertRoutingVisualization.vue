<template>
  <div
    class="expert-routing-visualization"
    :class="{ 'preview-mode': !editable }"
  >
    <div v-if="editable" class="toolbar">
      <n-space>
        <n-button size="small" @click="handleAddExpert">
          <template #icon>
            <n-icon><AddOutline /></n-icon>
          </template>
          {{ t("expertRouting.addExpert") }}
        </n-button>
        <n-text depth="3" style="font-size: 12px">
          {{ t("expertRouting.clickToEdit") }}
        </n-text>
      </n-space>
    </div>

    <div v-if="editable" class="visualization-container">
      <div class="node entry-node">
        <div class="node-header">
          <n-icon size="20"><EnterOutline /></n-icon>
          <span>{{ t("expertRouting.entryNode") }}</span>
        </div>
        <div class="node-body">
          <n-text depth="3" style="font-size: 12px">
            {{ t("expertRouting.entryNodeDesc") }}
          </n-text>
        </div>
      </div>

      <div class="arrow">↓</div>

      <div class="node classifier-node non-editable">
        <div class="node-header">
          <n-icon size="20"><FilterOutline /></n-icon>
          <span>{{ t("expertRouting.classifier") }}</span>
        </div>
        <div class="node-body">
          <n-text depth="3" style="font-size: 12px"
            >外置 Intent Router API</n-text
          >
          <n-tag size="tiny" type="success">intent-router</n-tag>
        </div>
      </div>

      <div class="arrow">↓</div>

      <div class="experts-container">
        <div v-for="expert in localExperts" :key="expert.id">
          <div
            class="node expert-node"
            @click="editable ? handleEditExpert(expert) : undefined"
          >
            <div
              class="node-header"
              :style="{ backgroundColor: expert.color || '#f0f0f0' }"
            >
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
              <n-tag
                size="tiny"
                :type="expert.type === 'virtual' ? 'info' : 'success'"
              >
                {{
                  expert.type === "virtual"
                    ? t("expertRouting.virtualModel")
                    : t("expertRouting.realModel")
                }}
              </n-tag>
            </div>
          </div>
        </div>

        <n-empty
          v-if="localExperts.length === 0"
          :description="t('expertRouting.noExperts')"
          :show-icon="false"
          size="small"
          style="padding: 20px"
        >
          <template #extra>
            <n-button size="small" @click="handleAddExpert">
              {{ t("expertRouting.addFirstExpert") }}
            </n-button>
          </template>
        </n-empty>
      </div>
    </div>

    <div v-else class="preview-container">
      <div class="preview-flow">
        <span class="flow-pill flow-pill--entry">{{
          t("expertRouting.entryNode")
        }}</span>
        <span class="flow-arrow">→</span>
        <span class="flow-pill flow-pill--classifier">{{
          t("expertRouting.classifier")
        }}</span>
        <span class="flow-arrow">→</span>
        <span class="flow-pill flow-pill--experts">
          {{ t("expertRouting.expertCount") }} × {{ localExperts.length }}
        </span>
      </div>
      <div v-if="localExperts.length > 0" class="expert-chips">
        <n-tooltip
          v-for="expert in visibleExperts"
          :key="expert.id"
          trigger="hover"
        >
          <template #trigger>
            <div class="expert-chip">
              <span
                class="chip-dot"
                :style="{ backgroundColor: expert.color || '#1890ff' }"
              ></span>
              <span class="chip-category">{{ expert.category }}</span>
              <span v-if="getExpertLabel(expert)" class="chip-model">
                {{ getExpertLabel(expert) }}
              </span>
            </div>
          </template>
          {{ expert.category }} → {{ getExpertLabel(expert) || "-" }} ·
          {{
            expert.type === "virtual"
              ? t("expertRouting.virtualModel")
              : t("expertRouting.realModel")
          }}
        </n-tooltip>
        <button
          v-if="hiddenCount > 0 || expanded"
          type="button"
          class="chip-toggle"
          @click.stop="toggleExpanded"
        >
          {{ expanded ? t("common.collapse") : `+${hiddenCount}` }}
        </button>
      </div>
      <n-empty
        v-else
        :description="t('expertRouting.noExperts')"
        :show-icon="false"
        size="small"
        style="padding: 20px"
      />
    </div>

    <n-drawer v-model:show="showExpertDrawer" :width="expertDrawerWidth">
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
      :content-style="{ flex: 1, overflowY: 'auto', padding: '0' }"
      :bordered="false"
      size="huge"
    >
      <ExpertTemplateSelector
        v-if="showTemplateSelector"
        @select="handleTemplateSelect"
      />
    </n-modal>
  </div>
</template>

<script setup lang="ts">
import { ref, watch, computed } from "vue";
import { useI18n } from "vue-i18n";
import {
  NSpace,
  NButton,
  NIcon,
  NText,
  NTag,
  NEmpty,
  NDrawer,
  NDrawerContent,
  NModal,
  NTooltip,
  useDialog,
} from "naive-ui";
import {
  AddOutline,
  CloseOutline,
  EnterOutline,
  FilterOutline,
  CubeOutline,
} from "@vicons/ionicons5";
import type {
  ExpertTarget,
  LlmSecondPassConfig,
  ExpertTemplate,
} from "@/api/expert-routing";
import { useDebouncedWindowSize } from "@/composables/useDebouncedWindowSize";
import ExpertForm from "./ExpertForm.vue";
import ExpertTemplateSelector from "./ExpertTemplateSelector.vue";

function generateId(): string {
  return `expert_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}

const { t } = useI18n();
const dialog = useDialog();

interface Props {
  experts?: ExpertTarget[];
  routes?: { category: string; utterances: string[] }[];
  classifierConfig?: LlmSecondPassConfig;
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
  "update:experts": [experts: ExpertTarget[]];
  "update:routes": [routes: { category: string; utterances: string[] }[]];
}>();

const localExperts = ref<ExpertTarget[]>([...props.experts]);
const localRoutes = ref<{ category: string; utterances: string[] }[]>([
  ...(props.routes || []),
]);
const showExpertDrawer = ref(false);

// Preview chips collapse after this many experts to keep config cards a bounded height.
const COLLAPSED_CHIP_COUNT = 18;
const expanded = ref(false);
const visibleExperts = computed(() =>
  expanded.value
    ? localExperts.value
    : localExperts.value.slice(0, COLLAPSED_CHIP_COUNT),
);
const hiddenCount = computed(() =>
  Math.max(0, localExperts.value.length - COLLAPSED_CHIP_COUNT),
);

function toggleExpanded() {
  expanded.value = !expanded.value;
}

const { windowWidth: expertDrawerWindowWidth } = useDebouncedWindowSize(200);
const expertDrawerWidth = computed(() =>
  Math.min(640, Math.max(320, expertDrawerWindowWidth.value - 24)),
);
const showTemplateSelector = ref(false);
const editingExpert = ref<ExpertTarget>({
  id: "",
  category: "",
  type: "real",
});
const editingUtterances = ref<string[]>([]);

function getExpertLabel(expert: ExpertTarget): string {
  if (expert.type === "virtual") {
    const option = props.virtualModelOptions?.find(
      (o) => o.value === expert.model_id,
    );
    return option?.label || expert.model_id || "";
  } else {
    return expert.model || "";
  }
}

function handleAddExpert() {
  showTemplateSelector.value = true;
}

function handleTemplateSelect(template: ExpertTemplate | null) {
  showTemplateSelector.value = false;

  const colorMap: Record<string, string> = {
    code_authoring: "#18a058",
    code_modification: "#8a2be2",
    code_repair: "#d03050",
    code_review: "#f5222d",
    code_explanation: "#2080f0",
    test_generation: "#10b981",
    code_search: "#0ea5e9",
    architecture_consultation: "#f0a020",
    dependency_management: "#707070",
    context_specification: "#7c3aed",
    workflow_control: "#0891b2",
    general_inquiry: "#64748b",
  };

  const defaultColor =
    template && colorMap[template.value] ? colorMap[template.value] : "#1890ff";

  editingExpert.value = {
    id: generateId(),
    category: template ? template.value : "",
    type: "real",
    description: template ? template.description : "",
    color: defaultColor,
  };

  editingUtterances.value = template ? [...template.utterances] : [];
  showExpertDrawer.value = true;
}

function handleEditExpert(expert: ExpertTarget) {
  editingExpert.value = { ...expert };
  const route = localRoutes.value.find((r) => r.category === expert.category);
  editingUtterances.value = route ? [...route.utterances] : [];
  showExpertDrawer.value = true;
}

function handleDeleteExpert(expertId: string) {
  dialog.warning({
    title: t("common.warning"),
    content: t("expertRouting.deleteExpertConfirm"),
    positiveText: t("common.confirm"),
    negativeText: t("common.cancel"),
    onPositiveClick: () => {
      const expert = localExperts.value.find((e) => e.id === expertId);
      if (!expert) return;
      const category = expert.category;

      localExperts.value = localExperts.value.filter((e) => e.id !== expertId);
      emit("update:experts", localExperts.value);

      const isUsed = localExperts.value.some((e) => e.category === category);
      if (!isUsed) {
        const routes = localRoutes.value.filter((r) => r.category !== category);
        localRoutes.value = routes;
        emit("update:routes", routes);
      }
    },
  });
}

function handleSaveExpert(expert: ExpertTarget, utterances: string[]) {
  const index = localExperts.value.findIndex((e) => e.id === expert.id);
  const oldCategory = index >= 0 ? localExperts.value[index].category : null;

  if (index >= 0) {
    localExperts.value[index] = expert;
  } else {
    localExperts.value.push(expert);
  }
  emit("update:experts", localExperts.value);

  let routes = [...localRoutes.value];

  // Clean up old route if category changed and no other expert uses it
  if (oldCategory && oldCategory !== expert.category) {
    const isUsed = localExperts.value.some((e) => e.category === oldCategory);
    if (!isUsed) {
      routes = routes.filter((r) => r.category !== oldCategory);
    }
  }

  const routeIndex = routes.findIndex((r) => r.category === expert.category);

  if (routeIndex >= 0) {
    routes[routeIndex] = { ...routes[routeIndex], utterances };
  } else {
    routes.push({ category: expert.category, utterances });
  }

  localRoutes.value = routes;
  emit("update:routes", routes);

  showExpertDrawer.value = false;
}

// Deep watch forces Vue to traverse the whole experts/routes tree on each render,
// which can be very expensive when utterances/rules grow.
watch(
  () => props.experts,
  (newExperts) => {
    localExperts.value = [...newExperts];
  },
);

watch(
  () => props.routes,
  (newRoutes) => {
    localRoutes.value = [...(newRoutes || [])];
  },
);

watch(
  () => props.config,
  (newConfig) => {
    if (newConfig?.config?.experts) {
      localExperts.value = [...newConfig.config.experts];
    }
  },
  { immediate: true },
);
</script>

<style scoped>
.expert-routing-visualization {
  min-height: 400px;
  display: flex;
  flex-direction: column;
}

/* Compact preview should size to its chips, not the editable diagram min-height */
.preview-mode {
  min-height: auto;
}

.toolbar {
  padding: 12px;
  border-bottom: 1px solid #e0e0e0;
  background-color: #fff;
}

/* Editable flow: vertical entry → classifier → experts grid */
.visualization-container {
  flex: 1;
  padding: 24px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
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

.node-body {
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.entry-node {
  border-color: #52c41a;
  cursor: default;
}

.entry-node:hover {
  border-color: #52c41a;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
}

.classifier-node {
  border-color: #1890ff;
}

.classifier-node.non-editable {
  cursor: default;
}

.classifier-node.non-editable:hover {
  border-color: #1890ff;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
  transform: none;
}

.arrow {
  font-size: 22px;
  color: #999;
  line-height: 1;
}

.experts-container {
  width: 100%;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(210px, 1fr));
  gap: 12px;
}

.experts-container .node {
  width: auto;
  min-width: 0;
}

/* Preview: compact flow pills + wrapping expert chips, bounded height */
.preview-container {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.preview-flow {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}

.flow-pill {
  padding: 3px 10px;
  border-radius: 999px;
  font-size: 12px;
  font-weight: 500;
  white-space: nowrap;
}

.flow-pill--entry {
  background: rgba(82, 196, 26, 0.12);
  color: #389e0d;
}

.flow-pill--classifier {
  background: rgba(24, 144, 255, 0.1);
  color: #1677ff;
}

.flow-pill--experts {
  background: rgba(15, 107, 74, 0.1);
  color: var(--color-primary);
}

.flow-arrow {
  color: #999;
  font-size: 13px;
}

.expert-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.expert-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 3px 10px;
  background: #fff;
  border: 1px solid #e0e0e0;
  border-radius: 999px;
  font-size: 12px;
  max-width: 100%;
  overflow: hidden;
}

.chip-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}

.chip-category {
  font-weight: 500;
  white-space: nowrap;
}

.chip-model {
  color: #8c8c8c;
  max-width: 150px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.chip-toggle {
  border: 1px dashed #bbb;
  background: transparent;
  border-radius: 999px;
  padding: 3px 10px;
  font-size: 12px;
  color: #595959;
  cursor: pointer;
  font-family: inherit;
}

.chip-toggle:hover {
  color: var(--color-primary);
  border-color: var(--color-primary);
}
</style>
