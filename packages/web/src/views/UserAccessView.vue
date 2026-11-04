<template>
  <div class="user-access-view">
    <n-space vertical :size="12">
      <PageHeader eyebrow="ADMIN" :title="t('userAccess.title')" :subtitle="t('userAccess.subtitle')">
        <template #actions>
          <n-button size="small" :loading="loading" @click="refresh">
            <template #icon>
              <n-icon :component="RefreshOutlined" />
            </template>
            {{ t('userAccess.refresh') }}
          </n-button>
        </template>
      </PageHeader>

      <n-card class="table-card">
        <n-alert type="warning" :show-icon="true" style="margin-bottom: 12px">
          {{ t('userAccess.bindingRiskNotice') }}
        </n-alert>

        <n-data-table
          :columns="columns"
          :data="filteredUsers"
          :loading="loading"
          :row-key="(row: UserRow) => row.id"
          :bordered="false"
          size="small"
          :pagination="false"
        />
      </n-card>
    </n-space>

    <n-modal
      v-model:show="bindingsModalShow"
      preset="card"
      class="bindings-modal"
      :title="t('userAccess.bindingsModalTitle', { name: selectedUser?.username ?? '' })"
      style="width: 640px"
    >
      <n-spin :show="bindingsLoading">
        <n-space vertical :size="12">
          <n-alert type="warning" :show-icon="true">
            {{ t('userAccess.bindingRiskDetail') }}
          </n-alert>

          <div class="bindings-list">
            <div v-if="boundKeys.length === 0" class="bindings-empty">
              {{ t('userAccess.noBindings') }}
            </div>
            <div v-for="key in boundKeys" :key="key.id" class="binding-row">
              <span class="binding-name">{{ key.name }}</span>
              <n-button size="tiny" type="error" quaternary @click="unbind(key)">
                {{ t('userAccess.unbind') }}
              </n-button>
            </div>
          </div>

          <n-divider style="margin: 4px 0">{{ t('userAccess.bindNewSection') }}</n-divider>

          <n-select
            v-model:value="selectedNewKeyIds"
            multiple
            clearable
            filterable
            :options="unboundKeyOptions"
            :placeholder="t('userAccess.bindSelectPlaceholder')"
          />
          <n-space justify="end">
            <n-button
              type="primary"
              :disabled="selectedNewKeyIds.length === 0"
              :loading="bindSubmitting"
              @click="confirmBind"
            >
              {{ t('userAccess.bind') }}
            </n-button>
          </n-space>
        </n-space>
      </n-spin>
    </n-modal>
  </div>
</template>

<script setup lang="ts">
import { computed, h, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { useMessage } from 'naive-ui';
import type { DataTableColumns } from 'naive-ui';
import { NAlert, NButton, NCard, NDataTable, NDivider, NIcon, NModal, NSelect, NSpace, NSpin, NTag } from 'naive-ui';
import { RefreshOutlined } from '@vicons/material';
import PageHeader from '@/components/PageHeader.vue';
import { userAccessApi } from '@/api/user-access';
import { virtualKeyApi } from '@/api/virtual-key';
import { useAuthStore } from '@/stores/auth';
import type { User, UserRole, VirtualKey } from '@/types';

interface UserRow extends User {}

const { t } = useI18n();
const message = useMessage();
const authStore = useAuthStore();

const loading = ref(false);
const users = ref<UserRow[]>([]);
const allKeys = ref<VirtualKey[]>([]);

const bindingsModalShow = ref(false);
const bindingsLoading = ref(false);
const bindSubmitting = ref(false);
const selectedUser = ref<UserRow | null>(null);
const boundKeys = ref<VirtualKey[]>([]);
const selectedNewKeyIds = ref<string[]>([]);

const filteredUsers = computed(() => users.value);

/** 已绑定到当前用户的密钥之外的候选，避免重复绑定。 */
const unboundKeyOptions = computed(() =>
  allKeys.value
    .filter((key) => !boundKeys.value.some((bound) => bound.id === key.id))
    .map((key) => ({ label: key.name, value: key.id }))
);

async function refresh() {
  loading.value = true;
  try {
    const [userList, keyList] = await Promise.all([
      userAccessApi.getAllUsers(),
      virtualKeyApi.getAll(),
    ]);
    users.value = userList;
    allKeys.value = keyList.virtualKeys;
  } catch (error) {
    message.error(error instanceof Error ? error.message : t('userAccess.loadFailed'));
  } finally {
    loading.value = false;
  }
}

onMounted(refresh);

function changeRole(row: UserRow, nextRole: UserRole) {
  const isSelf = authStore.user?.id === row.id;
  const key = nextRole === 'admin' ? 'userAccess.confirmPromote' : 'userAccess.confirmDemote';
  const content = isSelf
    ? t('userAccess.confirmSelfChange')
    : t(key, { name: row.username });
  if (!window.confirm(content)) return;

  userAccessApi
    .updateUserRole(row.id, nextRole)
    .then(() => {
      row.role = nextRole;
      message.success(t('userAccess.roleUpdated', { name: row.username }));
    })
    .catch((error) => {
      message.error(error instanceof Error ? error.message : t('userAccess.roleUpdateFailed'));
    });
}

async function openBindings(row: UserRow) {
  selectedUser.value = row;
  boundKeys.value = [];
  selectedNewKeyIds.value = [];
  bindingsModalShow.value = true;
  bindingsLoading.value = true;
  try {
    const { virtualKeys } = await userAccessApi.getUserBindings(row.id);
    boundKeys.value = virtualKeys;
  } catch (error) {
    message.error(error instanceof Error ? error.message : t('userAccess.loadFailed'));
    bindingsModalShow.value = false;
  } finally {
    bindingsLoading.value = false;
  }
}

function unbind(key: VirtualKey) {
  const userId = selectedUser.value?.id;
  if (!userId) return;
  if (
    !window.confirm(
      t('userAccess.confirmUnbind', { key: key.name, name: selectedUser.value?.username ?? '' })
    )
  ) {
    return;
  }
  userAccessApi
    .removeBinding(userId, key.id)
    .then(() => {
      boundKeys.value = boundKeys.value.filter((item) => item.id !== key.id);
      selectedNewKeyIds.value = selectedNewKeyIds.value.filter((id) => id !== key.id);
      message.success(t('userAccess.unbindSuccess'));
    })
    .catch((error) => {
      message.error(error instanceof Error ? error.message : t('userAccess.unbindFailed'));
    });
}

function confirmBind() {
  const userId = selectedUser.value?.id;
  if (!userId || selectedNewKeyIds.value.length === 0) return;
  // 绑定即授权：再次确认安全后果，避免误操作把明文密钥可见性开放给该用户。
  if (!window.confirm(t('userAccess.confirmBindRisk', { name: selectedUser.value?.username ?? '' }))) {
    return;
  }
  bindSubmitting.value = true;
  const nextIds = [...selectedNewKeyIds.value];
  userAccessApi
    .bindUserKeys(userId, nextIds)
    .then(() => userAccessApi.getUserBindings(userId))
    .then(({ virtualKeys }) => {
      boundKeys.value = virtualKeys;
      selectedNewKeyIds.value = [];
      message.success(t('userAccess.bindSuccess'));
    })
    .catch((error) => {
      message.error(error instanceof Error ? error.message : t('userAccess.bindFailed'));
    })
    .finally(() => {
      bindSubmitting.value = false;
    });
}

const columns = computed<DataTableColumns<UserRow>>(() => [
  {
    title: t('userAccess.colUsername'),
    key: 'username',
  },
  {
    title: t('userAccess.colUserId'),
    key: 'id',
    render: (row) => h('span', { class: 'user-id-cell' }, row.id),
  },
  {
    title: t('userAccess.colRole'),
    key: 'role',
    width: 140,
    render: (row) =>
      h(
        NTag,
        { type: row.role === 'admin' ? 'warning' : 'default', size: 'small', bordered: false },
        { default: () => (row.role === 'admin' ? t('auth.role.admin') : t('auth.role.user')) }
      ),
  },
  {
    title: t('userAccess.colRoleActions'),
    key: 'roleActions',
    width: 200,
    render: (row) => {
      const isSelf = authStore.user?.id === row.id;
      const promote = h(
        NButton,
        {
          size: 'tiny',
          quaternary: true,
          type: 'warning',
          disabled: isSelf || row.role === 'admin',
          onClick: () => changeRole(row, 'admin'),
        },
        { default: () => t('userAccess.promote') }
      );
      const demote = h(
        NButton,
        {
          size: 'tiny',
          quaternary: true,
          type: 'error',
          disabled: isSelf || row.role !== 'admin',
          onClick: () => changeRole(row, 'user'),
        },
        { default: () => t('userAccess.demote') }
      );
      return h(NSpace, { size: 6 }, { default: () => [promote, demote] });
    },
  },
  {
    title: t('userAccess.colActions'),
    key: 'actions',
    width: 160,
    render: (row) =>
      h(
        NButton,
        { size: 'tiny', type: 'primary', secondary: true, onClick: () => openBindings(row) },
        { default: () => t('userAccess.manageBindings') }
      ),
  },
]);
</script>

<style scoped>
.table-card {
  border-radius: 12px;
}

.user-id-cell {
  font-family: var(--font-mono, monospace);
  font-size: 12px;
  opacity: 0.75;
}

.bindings-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.binding-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 10px;
  border: 1px solid var(--n-border-color, #e0e0e6);
  border-radius: 6px;
}

.binding-name {
  font-size: 13px;
}

.bindings-empty {
  font-size: 13px;
  opacity: 0.6;
  padding: 8px 2px;
}
</style>
