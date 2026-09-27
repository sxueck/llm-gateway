<template>
  <div class="expert-routing-view">
    <n-space vertical :size="12">
      <PageHeader
        eyebrow="ROUTING"
        :title="t('expertRouting.title')"
        :subtitle="t('expertRouting.subtitle')"
      >
        <template #actions>
          <n-button type="primary" size="small" :loading="creating" @click="handleCreate">
            <template #icon>
              <n-icon><AddOutline /></n-icon>
            </template>
            {{ t('expertRouting.create') }}
          </n-button>
          <n-button size="small" @click="loadConfigs">
            <template #icon>
              <n-icon><RefreshOutline /></n-icon>
            </template>
            {{ t('common.refresh') }}
          </n-button>
        </template>
      </PageHeader>

      <n-card size="small">
        <n-data-table
          :columns="columns"
          :data="configs"
          :loading="loading"
          :pagination="false"
          size="small"
        />
        <n-empty
          v-if="configs.length === 0 && !loading"
          :description="t('expertRouting.noConfigs')"
          :show-icon="false"
          style="padding: 48px 0"
        >
          <template #extra>
            <n-button type="primary" size="small" @click="handleCreate">
              {{ t('expertRouting.createFirstConfig') }}
            </n-button>
          </template>
        </n-empty>
      </n-card>
    </n-space>
  </div>
</template>

<script setup lang="ts">
import { h, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { useMessage, NButton, NCard, NDataTable, NIcon, NPopconfirm, NSpace, NSwitch, NTag, NText } from 'naive-ui';
import type { DataTableColumns } from 'naive-ui';
import { AddOutline, RefreshOutline } from '@vicons/ionicons5';
import { expertRoutingApi, type Band, type ExpertRouting } from '@/api/expert-routing';
import PageHeader from '@/components/PageHeader.vue';
import { createDefaultExpertRoutingConfig } from '@/utils/expert-routing';

const { t } = useI18n();
const message = useMessage();
const router = useRouter();

const configs = ref<ExpertRouting[]>([]);
const loading = ref(false);
const creating = ref(false);

const BAND_COLORS: Record<Band, string> = {
  low: '#18a058',
  medium: '#f0a020',
  high: '#d03050',
};

function tierCounts(config: ExpertRouting): Record<Band, number> {
  const counts: Record<Band, number> = { low: 0, medium: 0, high: 0 };
  for (const expert of config.config.experts || []) {
    if (expert.band && counts[expert.band] !== undefined) counts[expert.band] += 1;
  }
  return counts;
}

function renderTierRatio(config: ExpertRouting) {
  const counts = tierCounts(config);
  const total = counts.low + counts.medium + counts.high;
  const summary = `${counts.low}/${counts.medium}/${counts.high}`;
  if (total === 0) {
    return h(NText, { depth: 3 }, { default: () => `${summary} · ${t('expertRouting.noExperts')}` });
  }
  const segments = (['low', 'medium', 'high'] as Band[]).map((band) =>
    h('span', {
      class: 'tier-ratio-segment',
      style: {
        width: `${(counts[band] / total) * 100}%`,
        background: BAND_COLORS[band],
      },
      title: `${t(`expertRouting.band.${band}`)}: ${counts[band]}`,
    }),
  );
  return h('div', { class: 'tier-ratio-cell' }, [
    h('span', { class: 'tier-ratio-text' }, summary),
    h('div', { class: 'tier-ratio-bar' }, segments),
  ]);
}

const columns: DataTableColumns<ExpertRouting> = [
  {
    title: () => t('common.name'),
    key: 'name',
    render: (row) =>
      h(
        NButton,
        { text: true, type: 'primary', onClick: () => goDetail(row.id) },
        { default: () => row.name },
      ),
  },
  {
    title: () => t('expertRouting.exposedModel'),
    key: 'virtualModel',
    render: (row) =>
      row.virtualModel
        ? h(NTag, { size: 'small', bordered: false }, { default: () => row.virtualModel!.name })
        : h(NText, { depth: 3 }, { default: () => t('expertRouting.notExposed') }),
  },
  {
    title: () => t('expertRouting.tiers'),
    key: 'tiers',
    width: 170,
    render: (row) => renderTierRatio(row),
  },
  {
    title: () => t('expertRouting.failOpenRate'),
    key: 'failOpenRate',
    width: 110,
    render: () =>
      h(NText, { depth: 3 }, { default: () => '—' }),
  },
  {
    title: () => t('common.status'),
    key: 'enabled',
    width: 90,
    render: (row) =>
      h(NSwitch, {
        value: row.enabled,
        size: 'small',
        onUpdateValue: (value: boolean) => handleToggleEnabled(row.id, value),
      }),
  },
  {
    title: () => t('common.actions'),
    key: 'actions',
    width: 130,
    render: (row) =>
      h(NSpace, { size: 8, align: 'center' }, {
        default: () => [
          h(
            NButton,
            { text: true, size: 'small', type: 'primary', onClick: () => goDetail(row.id) },
            { default: () => t('common.details') },
          ),
          h(
            NPopconfirm,
            { onPositiveClick: () => handleDelete(row.id) },
            {
              trigger: () =>
                h(
                  NButton,
                  { text: true, size: 'small', type: 'error' },
                  { default: () => t('common.delete') },
                ),
              default: () => t('expertRouting.deleteConfigConfirm'),
            },
          ),
        ],
      }),
  },
];

function goDetail(id: string) {
  router.push(`/expert-routing/${id}`);
}

async function loadConfigs() {
  loading.value = true;
  try {
    const response = await expertRoutingApi.getAll();
    configs.value = response.configs;
  } catch (error: any) {
    message.error(error.message || t('messages.operationFailed'));
  } finally {
    loading.value = false;
  }
}

async function handleCreate() {
  creating.value = true;
  try {
    const name = `${t('expertRouting.untitledName')}-${Date.now().toString(36).slice(-5)}`;
    const created = await expertRoutingApi.create({
      ...createDefaultExpertRoutingConfig(),
      name,
    });
    message.success(t('expertRouting.createSuccess'));
    goDetail(created.id);
  } catch (error: any) {
    message.error(error.message || t('messages.operationFailed'));
  } finally {
    creating.value = false;
  }
}

async function handleToggleEnabled(id: string, enabled: boolean) {
  try {
    await expertRoutingApi.update(id, { enabled });
    message.success(t('messages.operationSuccess'));
    await loadConfigs();
  } catch (error: any) {
    message.error(error.message || t('messages.operationFailed'));
  }
}

async function handleDelete(id: string) {
  try {
    await expertRoutingApi.delete(id);
    message.success(t('expertRouting.deleteSuccess'));
    await loadConfigs();
  } catch (error: any) {
    message.error(error.message || t('messages.operationFailed'));
  }
}

onMounted(loadConfigs);
</script>

<style scoped>
.expert-routing-view {
  max-width: 1200px;
  margin: 0 auto;
}

:deep(.tier-ratio-cell) {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

:deep(.tier-ratio-text) {
  font-size: 12px;
  color: #595959;
}

:deep(.tier-ratio-bar) {
  display: flex;
  width: 120px;
  height: 6px;
  border-radius: 3px;
  overflow: hidden;
  background: #f0f0f0;
}

:deep(.tier-ratio-segment) {
  display: block;
  height: 100%;
}
</style>
