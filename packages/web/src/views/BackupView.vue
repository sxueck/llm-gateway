<template>
  <div>
    <n-space vertical :size="24">
      <PageHeader eyebrow="SETTINGS" :title="t('backup.title')" />
      <n-card :title="t('backup.s3Title')">
        <n-alert type="info" style="margin-bottom: 16px">
          {{ t('backup.s3Hint') }}
        </n-alert>

        <n-form :model="s3Config" label-placement="left" label-width="120" :label-align="'left'">
          <n-grid :cols="2" :x-gap="24">
            <n-gi>
              <n-form-item :label="t('backup.endpoint')" required>
                <n-input v-model:value="s3Config.endpoint" placeholder="http://localhost:9000">
                  <template #suffix>
                    <n-popover trigger="hover">
                      <template #trigger>
                        <n-icon size="18" style="cursor: help">
                          <SvgIcon :path="HELP_CIRCLE_PATH" viewBox="0 0 512 512" :size="18" />
                        </n-icon>
                      </template>
                      {{ t('backup.endpointHint') }}
                    </n-popover>
                  </template>
                </n-input>
              </n-form-item>
            </n-gi>
            <n-gi>
              <n-form-item :label="t('backup.bucket')" required>
                <n-input v-model:value="s3Config.bucketName" placeholder="llm-gateway-backups" />
              </n-form-item>
            </n-gi>
            <n-gi>
              <n-form-item :label="t('backup.region')" required>
                <n-input v-model:value="s3Config.region" placeholder="us-east-1" />
              </n-form-item>
            </n-gi>
            <n-gi>
              <n-form-item :label="t('backup.pathStyle')">
                <n-space vertical>
                  <n-switch v-model:value="s3Config.forcePathStyle">
                    <template #checked>{{ t('common.enabled') }}</template>
                    <template #unchecked>{{ t('common.disabled') }}</template>
                  </n-switch>
                  <n-text depth="3" style="font-size: 12px">
                    {{ t('backup.pathStyleHint') }}
                  </n-text>
                </n-space>
              </n-form-item>
            </n-gi>
            <n-gi>
              <n-form-item label="Access Key" required>
                <n-input v-model:value="s3Config.accessKeyId" placeholder="your_access_key" />
              </n-form-item>
            </n-gi>
            <n-gi>
              <n-form-item label="Secret Key" required>
                <n-input
                  v-model:value="s3Config.secretAccessKey"
                  type="password"
                  show-password-on="click"
                  :placeholder="t('backup.secretKeep')"
                />
              </n-form-item>
            </n-gi>
          </n-grid>
        </n-form>

        <n-space style="margin-top: 16px">
          <n-button type="primary" @click="saveS3Config" :loading="savingS3Config">
            {{ t('backup.saveConfig') }}
          </n-button>
          <n-button @click="testS3Connection" :loading="testingConnection">{{ t('providers.testConnection') }}</n-button>
          <n-button @click="loadS3Config">{{ t('backup.refreshConfig') }}</n-button>
        </n-space>
      </n-card>

      <n-card :title="t('backup.scheduleTitle')">
        <n-descriptions bordered :column="3">
          <n-descriptions-item :label="t('backup.schedulerStatus')">
            <n-tag :type="backupConfig.schedulerRunning ? 'success' : 'default'">
              {{ backupConfig.schedulerRunning ? t('backup.running') : t('backup.stopped') }}
            </n-tag>
          </n-descriptions-item>
          <n-descriptions-item :label="t('backup.schedule')">
            <n-input
              v-model:value="backupConfig.schedule"
              size="small"
              placeholder="0 2 * * *"
              style="width: 150px"
            />
          </n-descriptions-item>
          <n-descriptions-item :label="t('backup.retentionDays')">
            <n-input-number
              v-model:value="backupConfig.retentionDays"
              :min="1"
              :max="365"
              size="small"
              style="width: 100px"
            />
          </n-descriptions-item>
          <n-descriptions-item :label="t('backup.maxCount')">
            <n-input-number
              v-model:value="backupConfig.maxBackupCount"
              :min="1"
              :max="100"
              size="small"
              style="width: 100px"
            />
          </n-descriptions-item>
          <n-descriptions-item :label="t('backup.includeLogs')">
            <n-switch v-model:value="backupConfig.includeLogs" size="small" />
          </n-descriptions-item>
          <n-descriptions-item>
            <n-button
              type="primary"
              size="small"
              @click="updateBackupConfig"
              :loading="updatingConfig"
            >
              {{ t('backup.updateConfig') }}
            </n-button>
          </n-descriptions-item>
        </n-descriptions>
      </n-card>

      <n-card :title="t('backup.listTitle')">
        <template #header-extra>
          <n-space>
            <n-button type="primary" @click="showCreateBackupModal = true">{{ t('backup.create') }}</n-button>
            <n-button type="info" @click="syncBackupsFromS3" :loading="syncingBackups">
              <template #icon>
                <n-icon>
                  <SvgIcon :path="CLOUD_DOWNLOAD_PATH" viewBox="0 0 640 512" :size="18" />
                </n-icon>
              </template>
              {{ t('backup.syncS3') }}
            </n-button>
            <n-button @click="loadBackupList">
              <template #icon>
                <n-icon>
                  <SvgIcon :path="REFRESH_PATH" viewBox="0 0 512 512" :size="18" />
                </n-icon>
              </template>
              {{ t('common.refresh') }}
            </n-button>
          </n-space>
        </template>

        <n-data-table
          :columns="backupColumns"
          :data="backupList"
          :loading="loadingBackups"
          :pagination="backupPagination"
          :bordered="false"
          :single-line="false"
        />
      </n-card>

      <n-card :title="t('backup.restoresTitle')">
        <template #header-extra>
          <n-button @click="loadRestoreList">
            <template #icon>
              <n-icon>
                <SvgIcon :path="REFRESH_PATH" viewBox="0 0 512 512" :size="18" />
              </n-icon>
            </template>
            {{ t('common.refresh') }}
          </n-button>
        </template>

        <n-data-table
          :columns="restoreColumns"
          :data="restoreList"
          :loading="loadingRestores"
          :pagination="restorePagination"
          :bordered="false"
          :single-line="false"
        />
      </n-card>
    </n-space>

    <n-modal
      v-model:show="showCreateBackupModal"
      preset="dialog"
      :title="t('backup.create')"
      :trap-focus="true"
    >
      <n-form :model="createBackupForm" label-placement="left" label-width="100">
        <n-form-item :label="t('backup.includeLogs')">
          <n-switch v-model:value="createBackupForm.includeLogs" />
        </n-form-item>
      </n-form>

      <n-alert type="info" style="margin-top: 16px">
        {{ t('backup.fullHint') }}
      </n-alert>

      <template #action>
        <n-space>
          <n-button @click="showCreateBackupModal = false">{{ t('common.cancel') }}</n-button>
          <n-button type="primary" @click="confirmCreateBackup" :loading="creatingBackup">
            {{ t('backup.confirmCreate') }}
          </n-button>
        </n-space>
      </template>
    </n-modal>

    <n-modal
      v-model:show="showRestoreModal"
      preset="dialog"
      :title="t('backup.restoreTitle')"
      style="width: 600px; max-width: 92vw"
      :trap-focus="true"
    >
      <n-descriptions bordered :column="1" size="small">
        <n-descriptions-item :label="t('backup.backupFile')">
          {{ selectedBackup?.backup_key }}
        </n-descriptions-item>
        <n-descriptions-item :label="t('backup.backupType')">
          <n-tag type="success" size="small">{{ t('backup.fullBackup') }}</n-tag>
        </n-descriptions-item>
        <n-descriptions-item :label="t('common.time')">
          {{ formatTimestamp(selectedBackup?.created_at) }}
        </n-descriptions-item>
        <n-descriptions-item :label="t('backup.fileSize')">
          {{ formatFileSize(selectedBackup?.file_size) }}
        </n-descriptions-item>
        <n-descriptions-item :label="t('backup.recordCount')">
          {{ t('backup.recordCountValue', { count: selectedBackup?.record_count }) }}
        </n-descriptions-item>
      </n-descriptions>

      <n-divider />

      <n-form :model="restoreForm" label-placement="left" label-width="140">
        <n-form-item :label="t('backup.restoreType')">
          <n-radio-group v-model:value="restoreForm.restoreType">
            <n-space vertical>
              <n-radio value="full">{{ t('backup.fullRestore') }}</n-radio>
              <n-radio value="partial">{{ t('backup.partialRestore') }}</n-radio>
            </n-space>
          </n-radio-group>
        </n-form-item>

        <n-form-item v-if="restoreForm.restoreType === 'partial'" :label="t('backup.tables')">
          <n-checkbox-group v-model:value="restoreForm.tablesToRestore">
            <n-space vertical>
              <n-checkbox value="providers" :label="t('backup.tableProviders')" />
              <n-checkbox value="models" :label="t('backup.tableModels')" />
              <n-checkbox value="virtual_keys" :label="t('backup.tableVirtualKeys')" />
              <n-checkbox value="routing_configs" :label="t('backup.tableRouting')" />
              <n-checkbox value="expert_routing_configs" :label="t('backup.tableExpertRouting')" />
              <n-checkbox value="system_config" :label="t('backup.tableSystem')" />
            </n-space>
          </n-checkbox-group>
        </n-form-item>

        <n-form-item :label="t('backup.backupBeforeRestore')">
          <n-switch v-model:value="restoreForm.createBackupBeforeRestore" />
          <n-text depth="3" style="font-size: 12px; margin-left: 12px">{{ t('backup.backupBeforeRestoreHint') }}</n-text>
        </n-form-item>
      </n-form>

      <n-alert type="warning" style="margin-top: 16px">
        <template #header>{{ t('backup.warning') }}</template>
        <template v-if="restoreForm.restoreType === 'full'">
          {{ t('backup.fullOverwrite') }}
        </template>
        <template v-else>{{ t('backup.partialOverwrite') }}</template>
      </n-alert>

      <template #action>
        <n-space>
          <n-button @click="showRestoreModal = false">{{ t('common.cancel') }}</n-button>
          <n-button type="error" @click="confirmRestoreBackup" :loading="restoringBackup">
            {{ t('backup.confirmRestore') }}
          </n-button>
        </n-space>
      </template>
    </n-modal>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, h } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  useMessage,
  NButton,
  NTag,
  NSpace,
  NPopconfirm,
  NCard,
  NAlert,
  NForm,
  NGrid,
  NGi,
  NFormItem,
  NInput,
  NPopover,
  NIcon,
  NSwitch,
  NDescriptions,
  NDescriptionsItem,
  NDataTable,
  NModal,
  NRadioGroup,
  NRadio,
  NInputNumber,
  NDivider,
  NCheckboxGroup,
  NCheckbox,
  NText
} from 'naive-ui'
import request from '@/utils/request'
import SvgIcon from '@/components/SvgIcon.vue'
import PageHeader from '@/components/PageHeader.vue'

const HELP_CIRCLE_PATH =
  'M256 512A256 256 0 1 0 256 0a256 256 0 1 0 0 512zM216 336h24V272H216c-13.3 0-24-10.7-24-24s10.7-24 24-24h48c13.3 0 24 10.7 24 24v88h8c13.3 0 24 10.7 24 24s-10.7 24-24 24H216c-13.3 0-24-10.7-24-24s10.7-24 24-24zm40-208a32 32 0 1 1 0 64 32 32 0 1 1 0-64z'
const CLOUD_DOWNLOAD_PATH =
  'M144 480C64.5 480 0 415.5 0 336c0-62.8 40.2-116.2 96.2-135.9c-.1-2.7-.2-5.4-.2-8.1c0-88.4 71.6-160 160-160c59.3 0 111 32.2 138.7 80.2C409.9 102 428.3 96 448 96c53 0 96 43 96 96c0 12.2-2.3 23.8-6.4 34.6C596 238.4 640 290.1 640 352c0 70.7-57.3 128-128 128H144zm79-167l80 80c9.4 9.4 24.6 9.4 33.9 0l80-80c9.4-9.4 9.4-24.6 0-33.9s-24.6-9.4-33.9 0l-39 39V184c0-13.3-10.7-24-24-24s-24 10.7-24 24V318.1l-39-39c-9.4-9.4-24.6-9.4-33.9 0s-9.4 24.6 0 33.9z'
const REFRESH_PATH =
  'M105.1 202.6c7.7-21.8 20.2-42.3 37.8-59.8c62.5-62.5 163.8-62.5 226.3 0L386.3 160H336c-17.7 0-32 14.3-32 32s14.3 32 32 32H463.5c0 0 0 0 0 0h.4c17.7 0 32-14.3 32-32V64c0-17.7-14.3-32-32-32s-32 14.3-32 32v51.2L414.4 97.6c-87.5-87.5-229.3-87.5-316.8 0C73.2 122 55.6 150.7 44.8 181.4c-5.9 16.7 2.9 34.9 19.5 40.8s34.9-2.9 40.8-19.5zM39 289.3c-5 1.5-9.8 4.2-13.7 8.2c-4 4-6.7 8.8-8.1 14c-.3 1.2-.6 2.5-.8 3.8c-.3 1.7-.4 3.4-.4 5.1V448c0 17.7 14.3 32 32 32s32-14.3 32-32V396.9l17.6 17.5 0 0c87.5 87.4 229.3 87.4 316.7 0c24.4-24.4 42.1-53.1 52.9-83.7c5.9-16.7-2.9-34.9-19.5-40.8s-34.9 2.9-40.8 19.5c-7.7 21.8-20.2 42.3-37.8 59.8c-62.5 62.5-163.8 62.5-226.3 0l-.1-.1L125.6 352H176c17.7 0 32-14.3 32-32s-14.3-32-32-32H48.4c-1.6 0-3.2 .1-4.8 .3s-3.1 .5-4.6 1z'

const message = useMessage()
const { t, locale } = useI18n()

const s3Config = ref({
  endpoint: 'http://localhost:9000',
  bucketName: 'llm-gateway-backups',
  region: 'us-east-1',
  accessKeyId: '',
  secretAccessKey: '',
  forcePathStyle: true
})

const backupConfig = ref({
  schedule: '0 2 * * *',
  retentionDays: 30,
  maxBackupCount: 50,
  includeLogs: false,
  schedulerRunning: false
})

const testingConnection = ref(false)
const savingS3Config = ref(false)
const updatingConfig = ref(false)
const loadingBackups = ref(false)
const loadingRestores = ref(false)
const creatingBackup = ref(false)
const restoringBackup = ref(false)
const syncingBackups = ref(false)

const showCreateBackupModal = ref(false)
const showRestoreModal = ref(false)

const createBackupForm = ref({
  includeLogs: false
})

const restoreForm = ref({
  restoreType: 'full',
  createBackupBeforeRestore: true,
  tablesToRestore: [] as string[]
})

const backupList = ref<any[]>([])
const restoreList = ref<any[]>([])
const selectedBackup = ref<any>(null)

const backupPagination = ref({
  page: 1,
  pageSize: 10,
  showSizePicker: true,
  pageSizes: [10, 20, 50],
  itemCount: 0,
  onChange: (page: number) => {
    backupPagination.value.page = page
    loadBackupList()
  },
  onUpdatePageSize: (pageSize: number) => {
    backupPagination.value.pageSize = pageSize
    backupPagination.value.page = 1
    loadBackupList()
  }
})

const restorePagination = ref({
  page: 1,
  pageSize: 10,
  showSizePicker: true,
  pageSizes: [10, 20, 50],
  itemCount: 0,
  onChange: (page: number) => {
    restorePagination.value.page = page
    loadRestoreList()
  },
  onUpdatePageSize: (pageSize: number) => {
    restorePagination.value.pageSize = pageSize
    restorePagination.value.page = 1
    loadRestoreList()
  }
})

const backupColumns = computed(() => [
  {
    title: t('backup.backupId'),
    key: 'id',
    width: 200,
    ellipsis: { tooltip: true }
  },
  {
    title: t('common.status'),
    key: 'status',
    width: 100,
    render(row: any) {
      const statusMap: any = {
        pending: { type: 'default', text: t('backup.pending') },
        running: { type: 'info', text: t('backup.running') },
        completed: { type: 'success', text: t('backup.completed') },
        failed: { type: 'error', text: t('common.failed') }
      }
      const status = statusMap[row.status] || { type: 'default', text: row.status }
      return h(NTag, { type: status.type, size: 'small' }, () => status.text)
    }
  },
  {
    title: t('backup.size'),
    key: 'file_size',
    width: 120,
    render(row: any) {
      return formatFileSize(row.file_size)
    }
  },
  {
    title: t('backup.records'),
    key: 'record_count',
    width: 100
  },
  {
    title: t('common.time'),
    key: 'created_at',
    width: 180,
    render(row: any) {
      return formatTimestamp(row.created_at)
    }
  },
  {
    title: t('common.actions'),
    key: 'actions',
    width: 180,
    render(row: any) {
      return h(NSpace, { size: 'small' }, () => [
        h(
          NButton,
          {
            size: 'small',
            type: 'primary',
            disabled: row.status !== 'completed',
            onClick: () => openRestoreModal(row)
          },
          () => t('backup.restore')
        ),
        h(
          NPopconfirm,
          {
            onPositiveClick: () => deleteBackup(row.id)
          },
          {
            trigger: () => h(NButton, { size: 'small', type: 'error' }, () => t('common.delete')),
            default: () => t('backup.deleteConfirm')
          }
        )
      ])
    }
  }
])

const restoreColumns = computed(() => [
  {
    title: t('backup.restoreId'),
    key: 'id',
    width: 200,
    ellipsis: { tooltip: true }
  },
  {
    title: t('common.status'),
    key: 'status',
    width: 100,
    render(row: any) {
      const statusMap: any = {
        pending: { type: 'default', text: t('backup.pending') },
        running: { type: 'info', text: t('backup.running') },
        completed: { type: 'success', text: t('backup.completed') },
        failed: { type: 'error', text: t('common.failed') },
        rollback: { type: 'warning', text: t('backup.rolledBack') }
      }
      const status = statusMap[row.status] || { type: 'default', text: row.status }
      return h(NTag, { type: status.type, size: 'small' }, () => status.text)
    }
  },
  {
    title: t('backup.backupSource'),
    key: 'backup_record_id',
    width: 200,
    ellipsis: { tooltip: true }
  },
  {
    title: t('common.time'),
    key: 'created_at',
    width: 180,
    render(row: any) {
      return formatTimestamp(row.created_at)
    }
  },
  {
    title: t('backup.duration'),
    key: 'duration',
    width: 100,
    render(row: any) {
      if (!row.started_at || !row.completed_at) return '-'
      const duration = row.completed_at - row.started_at
      return t('backup.durationSeconds', { count: Math.round(duration / 1000) })
    }
  }
])

async function loadS3Config() {
  try {
    const data = await request.get('/admin/backup/s3-config')

    s3Config.value = {
      endpoint: data.endpoint,
      bucketName: data.bucketName,
      region: data.region,
      accessKeyId: data.accessKeyId,
      secretAccessKey: data.secretAccessKey, // Already '******' from backend
      forcePathStyle: data.forcePathStyle
    }
  } catch (error: any) {
    message.error(t('backup.s3LoadFailed', { message: error.message }))
  }
}

async function saveS3Config() {
  savingS3Config.value = true
  try {
    await request.put('/admin/backup/s3-config', s3Config.value)

    message.success(t('backup.s3Saved'))
  } catch (error: any) {
    message.error(t('backup.s3SaveFailed', { message: error.message }))
  } finally {
    savingS3Config.value = false
  }
}

async function testS3Connection() {
  testingConnection.value = true
  try {
    const data = await request.post('/admin/backup/test-s3', s3Config.value)

    if (data.connected) {
      message.success(t('backup.s3TestOk'))
    } else {
      const errorMsg = data.error || t('messages.unknownError')
      message.error(t('backup.s3TestFailed', { message: errorMsg }))
    }
  } catch (error: any) {
    message.error(t('backup.s3TestFailed', { message: error.message }))
  } finally {
    testingConnection.value = false
  }
}

async function loadBackupConfig() {
  try {
    const data = await request.get('/admin/backup/config')

    backupConfig.value = {
      schedule: data.schedule,
      retentionDays: data.retention_days,
      maxBackupCount: data.max_backup_count,
      includeLogs: data.include_logs,
      schedulerRunning: data.scheduler_running
    }
  } catch (error: any) {
    message.error(t('backup.configLoadFailed', { message: error.message }))
  }
}

async function updateBackupConfig() {
  updatingConfig.value = true
  try {
    await request.put('/admin/backup/config', {
      schedule: backupConfig.value.schedule,
      retention_days: backupConfig.value.retentionDays,
      max_backup_count: backupConfig.value.maxBackupCount,
      include_logs: backupConfig.value.includeLogs
    })

    message.success(t('backup.configUpdated'))
    await loadBackupConfig()
  } catch (error: any) {
    message.error(t('backup.configUpdateFailed', { message: error.message }))
  } finally {
    updatingConfig.value = false
  }
}

async function loadBackupList() {
  loadingBackups.value = true
  try {
    const data = await request.get('/admin/backup/list', {
      params: {
        page: backupPagination.value.page,
        limit: backupPagination.value.pageSize,
        status: 'all'
      }
    })

    backupList.value = data.backups
    backupPagination.value.itemCount = data.total
  } catch (error: any) {
    message.error(t('backup.listLoadFailed', { message: error.message }))
  } finally {
    loadingBackups.value = false
  }
}

async function loadRestoreList() {
  loadingRestores.value = true
  try {
    const data = await request.get('/admin/restore/list', {
      params: {
        page: restorePagination.value.page,
        limit: restorePagination.value.pageSize,
        status: 'all'
      }
    })

    restoreList.value = data.restores
    restorePagination.value.itemCount = data.total
  } catch (error: any) {
    message.error(t('backup.restoreListLoadFailed', { message: error.message }))
  } finally {
    loadingRestores.value = false
  }
}

async function confirmCreateBackup() {
  await createBackup()
}

async function createBackup() {
  creatingBackup.value = true
  try {
    await request.post('/admin/backup/create', {
      includes_logs: createBackupForm.value.includeLogs
    })

    message.success(t('backup.createStarted'))
    showCreateBackupModal.value = false

    setTimeout(() => {
      loadBackupList()
    }, 2000)
  } catch (error: any) {
    message.error(t('backup.createFailed', { message: error.message }))
  } finally {
    creatingBackup.value = false
  }
}

async function syncBackupsFromS3() {
  syncingBackups.value = true
  try {
    const data = await request.post('/admin/backup/sync', {})

    message.success(data.message)
    await loadBackupList()
  } catch (error: any) {
    message.error(t('backup.syncFailed', { message: error.message }))
  } finally {
    syncingBackups.value = false
  }
}

function openRestoreModal(backup: any) {
  selectedBackup.value = backup
  restoreForm.value = {
    restoreType: 'full',
    createBackupBeforeRestore: true,
    tablesToRestore: []
  }
  showRestoreModal.value = true
}

async function confirmRestoreBackup() {
  if (!selectedBackup.value) return

  if (
    restoreForm.value.restoreType === 'partial' &&
    restoreForm.value.tablesToRestore.length === 0
  ) {
    message.error(t('backup.selectTable'))
    return
  }

  await restoreBackup()
}

async function restoreBackup() {
  if (!selectedBackup.value) return

  restoringBackup.value = true
  try {
    const payload: any = {
      backup_id: selectedBackup.value.id,
      restore_type: restoreForm.value.restoreType,
      create_backup_before_restore: restoreForm.value.createBackupBeforeRestore
    }

    if (restoreForm.value.restoreType === 'partial') {
      payload.tables_to_restore = restoreForm.value.tablesToRestore
    }

    await request.post('/admin/restore', payload)

    message.success(t('backup.restoreStarted'))
    showRestoreModal.value = false

    setTimeout(() => {
      loadRestoreList()
    }, 2000)
  } catch (error: any) {
    message.error(t('backup.restoreFailed', { message: error.message }))
  } finally {
    restoringBackup.value = false
  }
}

async function deleteBackup(id: string) {
  try {
    await request.delete(`/admin/backup/${id}`)

    message.success(t('backup.deleted'))
    await loadBackupList()
  } catch (error: any) {
    message.error(t('backup.deleteFailed', { message: error.message }))
  }
}

function formatTimestamp(timestamp?: number): string {
  if (!timestamp) return '-'
  return new Date(timestamp).toLocaleString(locale.value)
}

function formatFileSize(bytes?: number): string {
  if (!bytes) return '-'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)} KB`
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`
}

onMounted(() => {
  loadS3Config()
  loadBackupConfig()
  loadBackupList()
  loadRestoreList()
})
</script>

<style scoped>
:deep(.n-card-header__main) {
  color: var(--color-title);
}
</style>
