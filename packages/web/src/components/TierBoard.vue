<template>
  <div class="tier-board">
    <div class="board-toolbar">
      <n-text depth="3" class="board-hint">
        {{ t('expertRouting.tierBoardHint') }}
      </n-text>
      <n-space :size="8">
        <n-button size="small" @click="openAddModal">
          <template #icon>
            <n-icon><AddOutline /></n-icon>
          </template>
          {{ t('expertRouting.addFromLibrary') }}
        </n-button>
        <n-button
          size="small"
          :loading="autoAssigning"
          :disabled="experts.length === 0"
          @click="handleAutoAssign"
        >
          <template #icon>
            <n-icon><SwapHorizontalOutline /></n-icon>
          </template>
          {{ t('expertRouting.autoAssignBands') }}
        </n-button>
      </n-space>
    </div>

    <n-alert
      v-for="warning in warnings"
      :key="warning"
      type="warning"
      :show-icon="true"
    >
      {{ warning }}
    </n-alert>

    <n-empty
      v-if="experts.length === 0"
      :description="t('expertRouting.noExperts')"
      :show-icon="false"
      style="padding: 40px 0"
    />

    <div v-else class="tier-columns">
      <div
        v-for="band in BANDS"
        :key="band"
        class="tier-column"
        :class="`band-${band}`"
      >
        <div class="tier-column-header">
          <span>{{ t(`expertRouting.band.${band}`) }}</span>
          <n-tag size="small" round>{{ columns[band].length }}</n-tag>
        </div>
        <div class="tier-column-desc">{{ t(`expertRouting.band.${band}Desc`) }}</div>
        <div class="tier-column-body">
          <TierModelCard
            v-for="(expert, index) in columns[band]"
            :key="expert.id"
            :expert="expert"
            :label="labelOf(expert)"
            :first="index === 0"
            :last="index === columns[band].length - 1"
            @move-up="moveExpert(band, index, -1)"
            @move-down="moveExpert(band, index, 1)"
            @remove="removeExpert(expert.id)"
          />
          <n-text
            v-if="columns[band].length === 0"
            depth="3"
            class="tier-column-empty"
          >
            {{ t('expertRouting.noExperts') }}
          </n-text>
        </div>
      </div>
    </div>

    <n-modal
      v-model:show="showAddModal"
      preset="card"
      :title="t('expertRouting.addCandidateTitle')"
      :style="{ width: '560px', maxWidth: '92vw' }"
      :segmented="{ footer: 'soft' }"
    >
      <n-form label-placement="left" label-width="110" size="small">
        <n-form-item :label="t('expertRouting.targetBand')">
          <n-radio-group v-model:value="addBand">
            <n-space>
              <n-radio v-for="band in BANDS" :key="band" :value="band">
                {{ t(`expertRouting.band.${band}`) }}
              </n-radio>
            </n-space>
          </n-radio-group>
        </n-form-item>
        <ModelSelector
          v-model:type="addType"
          v-model:model-id="addModelId"
          v-model:provider-id="addProviderId"
          v-model:model="addModel"
          :provider-options="providerOptions"
          :virtual-model-options="virtualModelOptions"
        />
      </n-form>
      <template #footer>
        <n-space justify="end" :size="8">
          <n-button size="small" @click="showAddModal = false">
            {{ t('common.cancel') }}
          </n-button>
          <n-button size="small" type="primary" :disabled="!canAdd" @click="handleAdd">
            {{ t('expertRouting.add') }}
          </n-button>
        </n-space>
      </template>
    </n-modal>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch, onBeforeUnmount, onMounted } from 'vue';
import { useI18n } from 'vue-i18n';
import { useMessage } from 'naive-ui';
import {
  NAlert,
  NButton,
  NEmpty,
  NForm,
  NFormItem,
  NIcon,
  NModal,
  NRadio,
  NRadioGroup,
  NSpace,
  NTag,
  NText,
} from 'naive-ui';
import { AddOutline, SwapHorizontalOutline } from '@vicons/ionicons5';
import {
  expertRoutingApi,
  type Band,
  type BandPreviewResponse,
  type ExpertTarget,
} from '@/api/expert-routing';
import ModelSelector from '@/components/ModelSelector.vue';
import TierModelCard from '@/components/TierModelCard.vue';
import { useProviderStore } from '@/stores/provider';
import { useModelStore } from '@/stores/model';

const BANDS: Band[] = ['low', 'medium', 'high'];

interface Props {
  experts: ExpertTarget[];
  routingId?: string;
  resolveModelLabel?: (expert: ExpertTarget) => string;
}

const props = defineProps<Props>();
const emit = defineEmits<{
  'update:experts': [value: ExpertTarget[]];
}>();

const { t } = useI18n();
const message = useMessage();
const providerStore = useProviderStore();
const modelStore = useModelStore();

const showAddModal = ref(false);
const autoAssigning = ref(false);
const addBand = ref<Band>('low');
const addType = ref<'virtual' | 'real'>('virtual');
const addModelId = ref('');
const addProviderId = ref('');
const addModel = ref('');

// 价格信息（用于倒挂提醒），experts 变化后防抖拉取。
const bandPreview = ref<BandPreviewResponse | null>(null);
let previewTimer: number | undefined;

const providerOptions = computed(() =>
  providerStore.providers
    .filter((p) => p.enabled)
    .map((p) => ({ label: p.name, value: p.id })),
);

// 排除引用了当前配置的虚拟模型，避免后端拒绝的循环依赖。
const virtualModelOptions = computed(() =>
  modelStore.models
    .filter(
      (m) => m.isVirtual && (!props.routingId || m.expertRoutingId !== props.routingId),
    )
    .map((m) => ({ label: m.name, value: m.id })),
);

const columns = computed(() => {
  const byBand: Record<Band, ExpertTarget[]> = { low: [], medium: [], high: [] };
  for (const expert of props.experts) {
    if (expert.band && byBand[expert.band]) byBand[expert.band].push(expert);
  }
  return byBand;
});

const tierPrices = computed(() => {
  const preview = bandPreview.value;
  if (!preview) return null;
  const result: Record<Band, number | null> = { low: null, medium: null, high: null };
  for (const band of BANDS) {
    const prices = (preview.bands[band] || [])
      .map((entry) => entry.blendedPrice)
      .filter((price): price is number => price != null && Number.isFinite(price));
    result[band] =
      prices.length > 0
        ? prices.reduce((sum, price) => sum + price, 0) / prices.length
        : null;
  }
  return result;
});

const warnings = computed(() => {
  const list: string[] = [];
  if (props.experts.length === 0) return list;
  const hasEmpty = BANDS.some((band) => columns.value[band].length === 0);
  if (hasEmpty) list.push(t('expertRouting.emptyTierWarning'));
  const prices = tierPrices.value;
  if (
    prices &&
    prices.low != null &&
    prices.high != null &&
    prices.low > prices.high
  ) {
    list.push(t('expertRouting.priceInversionWarning'));
  }
  return list;
});

const canAdd = computed(() => {
  if (addType.value === 'virtual') return !!addModelId.value;
  return !!addProviderId.value && !!addModel.value;
});

function labelOf(expert: ExpertTarget): string {
  if (props.resolveModelLabel) return props.resolveModelLabel(expert);
  return expert.model || expert.model_id || expert.id;
}

function generateExpertId(): string {
  return `expert-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function openAddModal() {
  addBand.value = 'low';
  addType.value = 'virtual';
  addModelId.value = '';
  addProviderId.value = '';
  addModel.value = '';
  showAddModal.value = true;
}

function handleAdd() {
  const expert: ExpertTarget =
    addType.value === 'virtual'
      ? {
          id: generateExpertId(),
          band: addBand.value,
          type: 'virtual',
          model_id: addModelId.value,
        }
      : {
          id: generateExpertId(),
          band: addBand.value,
          type: 'real',
          provider_id: addProviderId.value,
          model: addModel.value,
        };
  emit('update:experts', [...props.experts, expert]);
  showAddModal.value = false;
}

async function handleAutoAssign() {
  autoAssigning.value = true;
  try {
    const payload = props.experts.map((expert) => {
      const { band: _band, ...rest } = expert;
      return rest;
    });
    const response = await expertRoutingApi.previewBands(
      props.routingId ?? null,
      payload,
    );
    emit(
      'update:experts',
      props.experts.map((expert) => ({
        ...expert,
        band: response.assignment[expert.id] ?? expert.band,
      })),
    );
    message.success(t('expertRouting.autoAssignSuccess'));
  } catch (error: any) {
    message.error(error.message || t('messages.operationFailed'));
  } finally {
    autoAssigning.value = false;
  }
}

// 档内顺序即优先级：重排后按 低/中/高 归并输出（跨档顺序无业务含义）。
function moveExpert(band: Band, index: number, direction: -1 | 1) {
  const column = [...columns.value[band]];
  const target = index + direction;
  if (target < 0 || target >= column.length) return;
  [column[index], column[target]] = [column[target], column[index]];
  const merged: ExpertTarget[] = [
    ...columns.value.low,
    ...columns.value.medium,
    ...columns.value.high,
  ];
  const start = merged.findIndex((expert) => expert.band === band);
  merged.splice(start, column.length, ...column);
  emit('update:experts', merged);
}

function removeExpert(expertId: string) {
  emit(
    'update:experts',
    props.experts.filter((expert) => expert.id !== expertId),
  );
}

async function loadPreview() {
  if (props.experts.length === 0) {
    bandPreview.value = null;
    return;
  }
  try {
    bandPreview.value = await expertRoutingApi.previewBands(
      props.routingId ?? null,
      props.experts,
    );
  } catch {
    bandPreview.value = null;
  }
}

watch(
  () => props.experts,
  () => {
    if (previewTimer !== undefined) window.clearTimeout(previewTimer);
    previewTimer = window.setTimeout(loadPreview, 600);
  },
  { deep: true },
);

onMounted(loadPreview);

onBeforeUnmount(() => {
  if (previewTimer !== undefined) window.clearTimeout(previewTimer);
});
</script>

<style scoped>
.board-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
  margin-bottom: 12px;
}

.board-hint {
  font-size: 12px;
}

.tier-columns {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(260px, 100%), 1fr));
  gap: 12px;
}

.tier-column {
  border: 1px solid #e8e8e8;
  border-radius: 10px;
  background: #fafafa;
  overflow: hidden;
}

.tier-column-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px;
  font-size: 13px;
  font-weight: 600;
  border-bottom: 1px solid #e8e8e8;
  background: #ffffff;
}

.tier-column-desc {
  padding: 4px 12px 8px;
  font-size: 12px;
  color: #8c8c8c;
  border-bottom: 1px solid #e8e8e8;
  background: #ffffff;
}

.tier-column-body {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px;
  min-height: 64px;
}

.tier-column-empty {
  font-size: 12px;
  text-align: center;
  padding: 12px 0;
}
</style>
