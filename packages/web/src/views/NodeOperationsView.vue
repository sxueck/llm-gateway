<template>
  <div>
    <n-space vertical :size="24">
      <PageHeader
        eyebrow="TOOLS"
        :title="t('nodeOperations.title')"
        :subtitle="t('nodeOperations.subtitle')"
      >
        <template #actions>
          <n-button :loading="loading" :disabled="checkingNode !== null" @click="refresh">
            {{ t('common.refresh') }}
          </n-button>
        </template>
      </PageHeader>

      <n-skeleton v-if="loading && !overview" height="180px" :sharp="false" />

      <n-alert v-if="loadError" type="error" :show-icon="true">
        {{ t('nodeOperations.loadFailed') }}
      </n-alert>

      <n-alert v-if="checkError" type="error" :show-icon="true">
        {{ t('nodeOperations.checkFailed', { node: checkError }) }}
      </n-alert>

      <n-card v-if="overview && !overview.enabled" :title="t('nodeOperations.title')">
        <n-empty :description="t('nodeOperations.disabledHint')" style="padding: 32px 0;">
          <template #extra>
            <n-text depth="3" style="font-size: 12px;">
              {{ t('nodeOperations.disabledCannotProbe') }}
            </n-text>
          </template>
        </n-empty>
      </n-card>

      <template v-if="overview?.enabled">
        <n-card :title="t('nodeOperations.overviewTitle')">
          <n-descriptions label-placement="left" :column="1" size="small" bordered>
            <n-descriptions-item :label="t('nodeOperations.overviewMode')">
              <n-tag size="small" type="info">{{ t('nodeOperations.modeMultiNode') }}</n-tag>
            </n-descriptions-item>
            <n-descriptions-item :label="t('nodeOperations.overviewLocalNode')">
              {{ overview.nodeId }}
            </n-descriptions-item>
            <n-descriptions-item :label="t('nodeOperations.overviewControlNode')">
              {{ overview.controlId }}
            </n-descriptions-item>
          </n-descriptions>
        </n-card>

        <n-card :title="t('nodeOperations.nodesTitle')">
          <n-data-table
            :columns="nodeColumns"
            :data="nodeRows"
            :loading="loading"
            size="small"
            :row-key="(row: NodeRow) => row.id"
            :scroll-x="1200"
          />
          <n-alert type="info" :show-icon="true" style="margin-top: 12px;">
            {{ t('nodeOperations.probeNote') }}
          </n-alert>
        </n-card>

        <n-card :title="t('nodeOperations.providersTitle')">
          <n-alert
            v-if="unconfiguredProviders.length > 0"
            type="warning"
            :show-icon="true"
            style="margin-bottom: 12px;"
          >
            {{ t('nodeOperations.providerUnconfiguredWarning', { names: unconfiguredProviders.join(', ') }) }}
          </n-alert>
          <n-data-table
            :columns="providerColumns"
            :data="overview.providers"
            size="small"
            :row-key="(row: NodeProviderInfo) => row.id"
            :scroll-x="700"
          />
          <n-alert type="default" :show-icon="false" style="margin-top: 12px;">
            {{ t('nodeOperations.ownershipNote') }}
          </n-alert>
        </n-card>

        <n-card :title="t('nodeOperations.traceTitle')">
          <n-text depth="3" style="font-size: 13px; display: block; white-space: pre-line;">
            {{ t('nodeOperations.traceHint') }}
          </n-text>
        </n-card>
      </template>
    </n-space>
  </div>
</template>

<script setup lang="ts">
import { computed, h, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import {
  NAlert,
  NButton,
  NCard,
  NDataTable,
  NDescriptions,
  NDescriptionsItem,
  NEmpty,
  NSpace,
  NSkeleton,
  NTag,
  NText,
} from 'naive-ui';
import type { DataTableColumn } from 'naive-ui';
import dayjs from 'dayjs';
import PageHeader from '@/components/PageHeader.vue';
import {
  nodesApi,
  type NodeCheckResult,
  type NodeInfo,
  type NodeProviderInfo,
  type NodesOverview,
} from '@/api/nodes';

const { t } = useI18n();

const loading = ref(false);
const loadError = ref(false);
const overview = ref<NodesOverview | null>(null);
const checkResults = ref<Record<string, NodeCheckResult>>({});
const checkingNode = ref<string | null>(null);
const checkError = ref<string | null>(null);

interface NodeRow extends NodeInfo {
  check?: NodeCheckResult;
  checking: boolean;
}

const nodeRows = computed<NodeRow[]>(() =>
  (overview.value?.nodes ?? []).map((node) => ({
    ...node,
    check: checkResults.value[node.id],
    checking: checkingNode.value === node.id,
  }))
);

const unconfiguredProviders = computed(() =>
  (overview.value?.providers ?? [])
    .filter((provider) => !provider.configured)
    .map((provider) => provider.name)
);

function formatTimestamp(value?: number) {
  return value ? dayjs(value).format('YYYY-MM-DD HH:mm:ss') : '—';
}

function nodeStatusType(row: NodeRow): 'default' | 'info' | 'success' | 'warning' | 'error' {
  if (row.checking) return 'info';
  if (row.local) return 'default';
  const check = row.check;
  if (!check) return 'default';
  if (check.reachable === null) return 'warning';
  if (check.reachable && check.authenticated === true) return 'success';
  if (check.reachable && check.authenticated === false) return 'error';
  return 'warning';
}

function nodeStatusLabel(row: NodeRow): string {
  if (row.checking) return t('nodeOperations.statusLoading');
  if (row.local) return t('nodeOperations.statusLocal');
  const check = row.check;
  if (!check) return t('nodeOperations.statusUnchecked');
  if (check.reachable === null) return t('nodeOperations.statusUnknown');
  if (check.authenticated === true) return t('nodeOperations.statusAuthenticated');
  if (check.authenticated === false) return t('nodeOperations.statusAuthFailed');
  return t('nodeOperations.statusReachableOnly');
}

const failureReasons = computed<Record<string, string>>(() => ({
  peer_node_auth_failed: t('nodeOperations.failureAuth'),
  node_operation_forbidden: t('nodeOperations.failureForbidden'),
  node_dispatch_saturated: t('nodeOperations.failureSaturated'),
  owner_node_unavailable: t('nodeOperations.failureUnavailable'),
  node_dispatch_unavailable: t('nodeOperations.failureDispatch'),
  node_health_mismatch: t('nodeOperations.failureMismatch'),
  node_check_timeout: t('nodeOperations.failureTimeout'),
}));

const nodeColumns = computed<DataTableColumn<NodeRow>[]>(() => [
  { title: t('nodeOperations.colNodeId'), key: 'id', width: 140 },
  {
    title: t('nodeOperations.colOrigin'),
    key: 'origin',
    render: (row) => row.origin ?? '—',
  },
  {
    title: t('nodeOperations.colRole'),
    key: 'role',
    width: 140,
    render: (row) => {
      const tags = [h(NTag, { size: 'small', bordered: false }, { default: () => t('nodeOperations.roleNode') })];
      if (row.local) {
        tags.push(h(NTag, { size: 'small', type: 'success', bordered: false }, { default: () => t('nodeOperations.roleLocal') }));
      }
      if (row.control) {
        tags.push(h(NTag, { size: 'small', type: 'info', bordered: false }, { default: () => t('nodeOperations.roleControl') }));
      }
      return h(NSpace, { size: 4 }, { default: () => tags });
    },
  },
  {
    title: t('nodeOperations.colStatus'),
    key: 'status',
    width: 140,
    render: (row) =>
      h(NTag, { size: 'small', type: nodeStatusType(row), bordered: false }, { default: () => nodeStatusLabel(row) }),
  },
  {
    title: t('nodeOperations.colLatency'),
    key: 'latencyMs',
    width: 110,
    render: (row) => (row.check ? `${row.check.latencyMs} ms` : '—'),
  },
  {
    title: t('nodeOperations.colCheckedAt'),
    key: 'checkedAt',
    width: 170,
    render: (row) => formatTimestamp(row.check?.checkedAt),
  },
  {
    title: t('nodeOperations.colReason'),
    key: 'reason',
    render: (row) => {
      const code = row.check?.errorCode;
      return code ? failureReasons.value[code] ?? code : '—';
    },
  },
  {
    title: t('common.actions'),
    key: 'actions',
    width: 110,
    render: (row) =>
      h(
        NButton,
        {
          size: 'small',
          loading: row.checking,
          disabled: row.local || loading.value || checkingNode.value !== null,
          onClick: () => checkNode(row.id),
        },
        { default: () => t('nodeOperations.checkAction') }
      ),
  },
]);

const providerColumns = computed<DataTableColumn<NodeProviderInfo>[]>(() => [
  { title: t('common.name'), key: 'name' },
  { title: t('nodeOperations.colProviderId'), key: 'id', width: 140 },
  { title: t('nodeOperations.colOwnerNode'), key: 'ownerNode', width: 140 },
  {
    title: t('common.status'),
    key: 'status',
    width: 140,
    render: (row) =>
      h(
        NTag,
        {
          size: 'small',
          type: row.enabled ? (row.configured ? 'success' : 'warning') : 'default',
          bordered: false,
        },
        {
          default: () =>
            !row.enabled
              ? t('common.disabled')
              : row.configured
                ? t('nodeOperations.providerReady')
                : t('nodeOperations.providerUnconfigured'),
        }
      ),
  },
]);

async function refresh() {
  if (checkingNode.value !== null || loading.value) return;
  loading.value = true;
  loadError.value = false;
  checkError.value = null;
  try {
    overview.value = await nodesApi.getOverview();
    checkResults.value = {};
  } catch {
    overview.value = null;
    checkResults.value = {};
    loadError.value = true;
  } finally {
    loading.value = false;
  }
}

async function checkNode(nodeId: string) {
  if (!overview.value?.enabled || loading.value || checkingNode.value !== null ||
      !overview.value.nodes.some((node) => node.id === nodeId && !node.local)) return;
  checkingNode.value = nodeId;
  checkError.value = null;
  const results = { ...checkResults.value };
  delete results[nodeId];
  checkResults.value = results;
  try {
    checkResults.value = {
      ...checkResults.value,
      [nodeId]: await nodesApi.checkNode(nodeId),
    };
  } catch {
    // Do not leave a stale successful check visible after the latest attempt fails.
    checkError.value = nodeId;
  } finally {
    checkingNode.value = null;
  }
}

onMounted(refresh);
</script>
