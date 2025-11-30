<template>
  <div>
    <n-space vertical :size="24">
      <!-- S3 Storage Configuration -->
      <n-card title="S3 存储配置">
        <n-alert type="info" style="margin-bottom: 16px;">
          支持所有 S3 兼容存储服务：AWS S3、MinIO、Cloudflare R2、阿里云 OSS 等
        </n-alert>

        <n-form :model="s3Config" label-placement="left" label-width="120" :label-align="'left'">
          <n-grid :cols="2" :x-gap="24">
            <n-gi>
              <n-form-item label="端点地址" required>
                <n-input
                  v-model:value="s3Config.endpoint"
                  placeholder="http://localhost:9000"
                >
                  <template #suffix>
                    <n-popover trigger="hover">
                      <template #trigger>
                        <n-icon size="18" style="cursor: help;">
                          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><path d="M256 512A256 256 0 1 0 256 0a256 256 0 1 0 0 512zM216 336h24V272H216c-13.3 0-24-10.7-24-24s10.7-24 24-24h48c13.3 0 24 10.7 24 24v88h8c13.3 0 24 10.7 24 24s-10.7 24-24 24H216c-13.3 0-24-10.7-24-24s10.7-24 24-24zm40-208a32 32 0 1 1 0 64 32 32 0 1 1 0-64z"/></svg>
                        </n-icon>
                      </template>
                      AWS S3 留空，其他服务填写完整 URL
                    </n-popover>
                  </template>
                </n-input>
              </n-form-item>
            </n-gi>
            <n-gi>
              <n-form-item label="存储桶" required>
                <n-input v-model:value="s3Config.bucketName" placeholder="llm-gateway-backups" />
              </n-form-item>
            </n-gi>
            <n-gi>
              <n-form-item label="区域" required>
                <n-input v-model:value="s3Config.region" placeholder="us-east-1" />
              </n-form-item>
            </n-gi>
            <n-gi>
              <n-form-item label="路径样式">
                <n-space vertical>
                  <n-switch v-model:value="s3Config.forcePathStyle">
                    <template #checked>启用</template>
                    <template #unchecked>禁用</template>
                  </n-switch>
                  <n-text depth="3" style="font-size: 12px;">
                    MinIO 需要启用，阿里云 OSS 需要禁用
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
                  placeholder="留空则保持不变"
                />
              </n-form-item>
            </n-gi>
          </n-grid>
        </n-form>

        <n-space style="margin-top: 16px;">
          <n-button type="primary" @click="saveS3Config" :loading="savingS3Config">
            保存配置
          </n-button>
          <n-button @click="testS3Connection" :loading="testingConnection">
            测试连接
          </n-button>
          <n-button @click="loadS3Config">刷新配置</n-button>
        </n-space>
      </n-card>

      <!-- Backup Schedule Configuration -->
      <n-card title="备份计划配置">
        <n-descriptions bordered :column="3">
          <n-descriptions-item label="调度状态">
            <n-tag :type="backupConfig.schedulerRunning ? 'success' : 'default'">
              {{ backupConfig.schedulerRunning ? '运行中' : '未运行' }}
            </n-tag>
          </n-descriptions-item>
          <n-descriptions-item label="备份计划">
            <n-input
              v-model:value="backupConfig.schedule"
              size="small"
              placeholder="0 2 * * *"
              style="width: 150px;"
            />
          </n-descriptions-item>
          <n-descriptions-item label="保留天数">
            <n-input-number
              v-model:value="backupConfig.retentionDays"
              :min="1"
              :max="365"
              size="small"
              style="width: 100px;"
            />
          </n-descriptions-item>
          <n-descriptions-item label="最大数量">
            <n-input-number
              v-model:value="backupConfig.maxBackupCount"
              :min="1"
              :max="100"
              size="small"
              style="width: 100px;"
            />
          </n-descriptions-item>
          <n-descriptions-item label="包含日志">
            <n-switch v-model:value="backupConfig.includeLogs" size="small" />
          </n-descriptions-item>
          <n-descriptions-item>
            <n-button type="primary" size="small" @click="updateBackupConfig" :loading="updatingConfig">
              更新配置
            </n-button>
          </n-descriptions-item>
        </n-descriptions>
      </n-card>

      <!-- Backup List -->
      <n-card title="备份列表">
        <template #header-extra>
          <n-space>
            <n-button type="primary" @click="showCreateBackupModal = true">
              创建备份
            </n-button>
            <n-button type="info" @click="syncBackupsFromS3" :loading="syncingBackups">
              <template #icon>
                <n-icon><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 512"><path d="M144 480C64.5 480 0 415.5 0 336c0-62.8 40.2-116.2 96.2-135.9c-.1-2.7-.2-5.4-.2-8.1c0-88.4 71.6-160 160-160c59.3 0 111 32.2 138.7 80.2C409.9 102 428.3 96 448 96c53 0 96 43 96 96c0 12.2-2.3 23.8-6.4 34.6C596 238.4 640 290.1 640 352c0 70.7-57.3 128-128 128H144zm79-167l80 80c9.4 9.4 24.6 9.4 33.9 0l80-80c9.4-9.4 9.4-24.6 0-33.9s-24.6-9.4-33.9 0l-39 39V184c0-13.3-10.7-24-24-24s-24 10.7-24 24V318.1l-39-39c-9.4-9.4-24.6-9.4-33.9 0s-9.4 24.6 0 33.9z"/></svg></n-icon>
              </template>
              从S3同步
            </n-button>
            <n-button @click="loadBackupList">
              <template #icon>
                <n-icon><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><path d="M105.1 202.6c7.7-21.8 20.2-42.3 37.8-59.8c62.5-62.5 163.8-62.5 226.3 0L386.3 160H336c-17.7 0-32 14.3-32 32s14.3 32 32 32H463.5c0 0 0 0 0 0h.4c17.7 0 32-14.3 32-32V64c0-17.7-14.3-32-32-32s-32 14.3-32 32v51.2L414.4 97.6c-87.5-87.5-229.3-87.5-316.8 0C73.2 122 55.6 150.7 44.8 181.4c-5.9 16.7 2.9 34.9 19.5 40.8s34.9-2.9 40.8-19.5zM39 289.3c-5 1.5-9.8 4.2-13.7 8.2c-4 4-6.7 8.8-8.1 14c-.3 1.2-.6 2.5-.8 3.8c-.3 1.7-.4 3.4-.4 5.1V448c0 17.7 14.3 32 32 32s32-14.3 32-32V396.9l17.6 17.5 0 0c87.5 87.4 229.3 87.4 316.7 0c24.4-24.4 42.1-53.1 52.9-83.7c5.9-16.7-2.9-34.9-19.5-40.8s-34.9 2.9-40.8 19.5c-7.7 21.8-20.2 42.3-37.8 59.8c-62.5 62.5-163.8 62.5-226.3 0l-.1-.1L125.6 352H176c17.7 0 32-14.3 32-32s-14.3-32-32-32H48.4c-1.6 0-3.2 .1-4.8 .3s-3.1 .5-4.6 1z"/></svg></n-icon>
              </template>
              刷新
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

      <!-- Restore History -->
      <n-card title="恢复记录">
        <template #header-extra>
          <n-button @click="loadRestoreList">
            <template #icon>
              <n-icon><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><path d="M105.1 202.6c7.7-21.8 20.2-42.3 37.8-59.8c62.5-62.5 163.8-62.5 226.3 0L386.3 160H336c-17.7 0-32 14.3-32 32s14.3 32 32 32H463.5c0 0 0 0 0 0h.4c17.7 0 32-14.3 32-32V64c0-17.7-14.3-32-32-32s-32 14.3-32 32v51.2L414.4 97.6c-87.5-87.5-229.3-87.5-316.8 0C73.2 122 55.6 150.7 44.8 181.4c-5.9 16.7 2.9 34.9 19.5 40.8s34.9-2.9 40.8-19.5zM39 289.3c-5 1.5-9.8 4.2-13.7 8.2c-4 4-6.7 8.8-8.1 14c-.3 1.2-.6 2.5-.8 3.8c-.3 1.7-.4 3.4-.4 5.1V448c0 17.7 14.3 32 32 32s32-14.3 32-32V396.9l17.6 17.5 0 0c87.5 87.4 229.3 87.4 316.7 0c24.4-24.4 42.1-53.1 52.9-83.7c5.9-16.7-2.9-34.9-19.5-40.8s-34.9 2.9-40.8 19.5c-7.7 21.8-20.2 42.3-37.8 59.8c-62.5 62.5-163.8 62.5-226.3 0l-.1-.1L125.6 352H176c17.7 0 32-14.3 32-32s-14.3-32-32-32H48.4c-1.6 0-3.2 .1-4.8 .3s-3.1 .5-4.6 1z"/></svg></n-icon>
            </template>
            刷新
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

    <!-- Create Backup Modal -->
    <n-modal v-model:show="showCreateBackupModal" preset="dialog" title="创建备份">
      <n-form :model="createBackupForm" label-placement="left" label-width="100">
        <n-form-item label="包含日志">
          <n-switch v-model:value="createBackupForm.includeLogs" />
        </n-form-item>
      </n-form>

      <n-alert type="info" style="margin-top: 16px;">
        完整备份将包含所有配置数据(提供商、模型、虚拟密钥等),并上传到 S3 存储。
      </n-alert>

      <template #action>
        <n-space>
          <n-button @click="showCreateBackupModal = false">取消</n-button>
          <n-button type="primary" @click="confirmCreateBackup" :loading="creatingBackup">
            确认创建
          </n-button>
        </n-space>
      </template>
    </n-modal>

    <!-- Restore Modal -->
    <n-modal v-model:show="showRestoreModal" preset="dialog" title="恢复备份" style="width: 600px;">
      <n-descriptions bordered :column="1" size="small">
        <n-descriptions-item label="备份文件">
          {{ selectedBackup?.backup_key }}
        </n-descriptions-item>
        <n-descriptions-item label="备份类型">
          <n-tag type="success" size="small">
            完整备份
          </n-tag>
        </n-descriptions-item>
        <n-descriptions-item label="创建时间">
          {{ formatTimestamp(selectedBackup?.created_at) }}
        </n-descriptions-item>
        <n-descriptions-item label="文件大小">
          {{ formatFileSize(selectedBackup?.file_size) }}
        </n-descriptions-item>
        <n-descriptions-item label="数据记录">
          {{ selectedBackup?.record_count }} 条
        </n-descriptions-item>
      </n-descriptions>

      <n-divider />

      <n-form :model="restoreForm" label-placement="left" label-width="140">
        <n-form-item label="恢复类型">
          <n-radio-group v-model:value="restoreForm.restoreType">
            <n-space vertical>
              <n-radio value="full">完整恢复</n-radio>
              <n-radio value="partial">部分恢复</n-radio>
            </n-space>
          </n-radio-group>
        </n-form-item>

        <n-form-item v-if="restoreForm.restoreType === 'partial'" label="选择恢复的表">
          <n-checkbox-group v-model:value="restoreForm.tablesToRestore">
            <n-space vertical>
              <n-checkbox value="providers" label="提供商配置" />
              <n-checkbox value="models" label="模型配置" />
              <n-checkbox value="virtual_keys" label="虚拟密钥" />
              <n-checkbox value="routing_configs" label="路由配置" />
              <n-checkbox value="expert_routing_configs" label="专家路由配置" />
              <n-checkbox value="system_config" label="系统配置" />
            </n-space>
          </n-checkbox-group>
        </n-form-item>

        <n-form-item label="恢复前备份当前数据">
          <n-switch v-model:value="restoreForm.createBackupBeforeRestore" />
          <n-text depth="3" style="font-size: 12px; margin-left: 12px;">
            强烈建议启用
          </n-text>
        </n-form-item>
      </n-form>

      <n-alert type="warning" style="margin-top: 16px;">
        <template #header>⚠️ 警告</template>
        <template v-if="restoreForm.restoreType === 'full'">
          此操作将覆盖当前所有配置数据！请确认您了解此操作的后果。
        </template>
        <template v-else>
          此操作将覆盖选中表的数据！请确认您了解此操作的后果。
        </template>
      </n-alert>

      <template #action>
        <n-space>
          <n-button @click="showRestoreModal = false">取消</n-button>
          <n-button type="error" @click="confirmRestoreBackup" :loading="restoringBackup">
            确认恢复
          </n-button>
        </n-space>
      </template>
    </n-modal>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, h } from 'vue';
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
  NText,
} from 'naive-ui';
import axios from 'axios';

const message = useMessage();

// S3 Configuration
const s3Config = ref({
  endpoint: 'http://localhost:9000',
  bucketName: 'llm-gateway-backups',
  region: 'us-east-1',
  accessKeyId: '',
  secretAccessKey: '',
  forcePathStyle: true
});

// Backup Configuration
const backupConfig = ref({
  schedule: '0 2 * * *',
  retentionDays: 30,
  maxBackupCount: 50,
  includeLogs: false,
  schedulerRunning: false
});

// State
const testingConnection = ref(false);
const savingS3Config = ref(false);
const updatingConfig = ref(false);
const loadingBackups = ref(false);
const loadingRestores = ref(false);
const creatingBackup = ref(false);
const restoringBackup = ref(false);
const syncingBackups = ref(false);

// Modals
const showCreateBackupModal = ref(false);
const showRestoreModal = ref(false);

// Forms
const createBackupForm = ref({
  includeLogs: false
});

const restoreForm = ref({
  restoreType: 'full',
  createBackupBeforeRestore: true,
  tablesToRestore: [] as string[]
});

// Data
const backupList = ref<any[]>([]);
const restoreList = ref<any[]>([]);
const selectedBackup = ref<any>(null);

// Pagination
const backupPagination = ref({
  page: 1,
  pageSize: 10,
  showSizePicker: true,
  pageSizes: [10, 20, 50],
  itemCount: 0,
  onChange: (page: number) => {
    backupPagination.value.page = page;
    loadBackupList();
  },
  onUpdatePageSize: (pageSize: number) => {
    backupPagination.value.pageSize = pageSize;
    backupPagination.value.page = 1;
    loadBackupList();
  }
});

const restorePagination = ref({
  page: 1,
  pageSize: 10,
  showSizePicker: true,
  pageSizes: [10, 20, 50],
  itemCount: 0,
  onChange: (page: number) => {
    restorePagination.value.page = page;
    loadRestoreList();
  },
  onUpdatePageSize: (pageSize: number) => {
    restorePagination.value.pageSize = pageSize;
    restorePagination.value.page = 1;
    loadRestoreList();
  }
});

// Columns
const backupColumns = [
  {
    title: '备份 ID',
    key: 'id',
    width: 200,
    ellipsis: { tooltip: true }
  },
  {
    title: '状态',
    key: 'status',
    width: 100,
    render(row: any) {
      const statusMap: any = {
        pending: { type: 'default', text: '等待中' },
        running: { type: 'info', text: '运行中' },
        completed: { type: 'success', text: '已完成' },
        failed: { type: 'error', text: '失败' }
      };
      const status = statusMap[row.status] || { type: 'default', text: row.status };
      return h(NTag, { type: status.type, size: 'small' }, () => status.text);
    }
  },
  {
    title: '大小',
    key: 'file_size',
    width: 120,
    render(row: any) {
      return formatFileSize(row.file_size);
    }
  },
  {
    title: '记录数',
    key: 'record_count',
    width: 100
  },
  {
    title: '创建时间',
    key: 'created_at',
    width: 180,
    render(row: any) {
      return formatTimestamp(row.created_at);
    }
  },
  {
    title: '操作',
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
          () => '恢复'
        ),
        h(
          NPopconfirm,
          {
            onPositiveClick: () => deleteBackup(row.id)
          },
          {
            trigger: () => h(NButton, { size: 'small', type: 'error' }, () => '删除'),
            default: () => '确定删除此备份吗？'
          }
        )
      ]);
    }
  }
];

const restoreColumns = [
  {
    title: '恢复 ID',
    key: 'id',
    width: 200,
    ellipsis: { tooltip: true }
  },
  {
    title: '状态',
    key: 'status',
    width: 100,
    render(row: any) {
      const statusMap: any = {
        pending: { type: 'default', text: '等待中' },
        running: { type: 'info', text: '运行中' },
        completed: { type: 'success', text: '已完成' },
        failed: { type: 'error', text: '失败' },
        rollback: { type: 'warning', text: '已回滚' }
      };
      const status = statusMap[row.status] || { type: 'default', text: row.status };
      return h(NTag, { type: status.type, size: 'small' }, () => status.text);
    }
  },
  {
    title: '备份源',
    key: 'backup_record_id',
    width: 200,
    ellipsis: { tooltip: true }
  },
  {
    title: '创建时间',
    key: 'created_at',
    width: 180,
    render(row: any) {
      return formatTimestamp(row.created_at);
    }
  },
  {
    title: '耗时',
    key: 'duration',
    width: 100,
    render(row: any) {
      if (!row.started_at || !row.completed_at) return '-';
      const duration = row.completed_at - row.started_at;
      return `${Math.round(duration / 1000)}秒`;
    }
  }
];

// Methods
async function loadS3Config() {
  try {
    const token = localStorage.getItem('token');
    const response = await axios.get('/api/admin/backup/s3-config', {
      headers: { Authorization: `Bearer ${token}` }
    });

    s3Config.value = {
      endpoint: response.data.endpoint,
      bucketName: response.data.bucketName,
      region: response.data.region,
      accessKeyId: response.data.accessKeyId,
      secretAccessKey: response.data.secretAccessKey, // Already '******' from backend
      forcePathStyle: response.data.forcePathStyle
    };
  } catch (error: any) {
    message.error(`加载S3配置失败: ${error.response?.data?.error?.message || error.message}`);
  }
}

async function saveS3Config() {
  savingS3Config.value = true;
  try {
    const token = localStorage.getItem('token');
    await axios.put(
      '/api/admin/backup/s3-config',
      s3Config.value,
      {
        headers: { Authorization: `Bearer ${token}` }
      }
    );

    message.success('S3配置保存成功');
  } catch (error: any) {
    message.error(`保存S3配置失败: ${error.response?.data?.error?.message || error.message}`);
  } finally {
    savingS3Config.value = false;
  }
}

async function testS3Connection() {
  testingConnection.value = true;
  try {
    const token = localStorage.getItem('token');
    const response = await axios.post(
      '/api/admin/backup/test-s3',
      s3Config.value,
      {
        headers: { Authorization: `Bearer ${token}` }
      }
    );

    if (response.data.connected) {
      message.success('S3 连接测试成功');
    } else {
      // Show detailed error message from backend
      const errorMsg = response.data.error || '未知错误';
      message.error(`S3 连接测试失败: ${errorMsg}`);
    }
  } catch (error: any) {
    message.error(`S3 连接测试失败: ${error.response?.data?.error?.message || error.message}`);
  } finally {
    testingConnection.value = false;
  }
}

async function loadBackupConfig() {
  try {
    const token = localStorage.getItem('token');
    const response = await axios.get('/api/admin/backup/config', {
      headers: { Authorization: `Bearer ${token}` }
    });

    backupConfig.value = {
      schedule: response.data.schedule,
      retentionDays: response.data.retention_days,
      maxBackupCount: response.data.max_backup_count,
      includeLogs: response.data.include_logs,
      schedulerRunning: response.data.scheduler_running
    };
  } catch (error: any) {
    message.error(`加载配置失败: ${error.response?.data?.error?.message || error.message}`);
  }
}

async function updateBackupConfig() {
  updatingConfig.value = true;
  try {
    const token = localStorage.getItem('token');
    await axios.put(
      '/api/admin/backup/config',
      {
        schedule: backupConfig.value.schedule,
        retention_days: backupConfig.value.retentionDays,
        max_backup_count: backupConfig.value.maxBackupCount,
        include_logs: backupConfig.value.includeLogs
      },
      {
        headers: { Authorization: `Bearer ${token}` }
      }
    );

    message.success('配置更新成功');
    await loadBackupConfig();
  } catch (error: any) {
    message.error(`配置更新失败: ${error.response?.data?.error?.message || error.message}`);
  } finally {
    updatingConfig.value = false;
  }
}

async function loadBackupList() {
  loadingBackups.value = true;
  try {
    const token = localStorage.getItem('token');
    const response = await axios.get('/api/admin/backup/list', {
      params: {
        page: backupPagination.value.page,
        limit: backupPagination.value.pageSize,
        status: 'all'
      },
      headers: { Authorization: `Bearer ${token}` }
    });

    backupList.value = response.data.backups;
    backupPagination.value.itemCount = response.data.total;
  } catch (error: any) {
    message.error(`加载备份列表失败: ${error.response?.data?.error?.message || error.message}`);
  } finally {
    loadingBackups.value = false;
  }
}

async function loadRestoreList() {
  loadingRestores.value = true;
  try {
    const token = localStorage.getItem('token');
    const response = await axios.get('/api/admin/restore/list', {
      params: {
        page: restorePagination.value.page,
        limit: restorePagination.value.pageSize,
        status: 'all'
      },
      headers: { Authorization: `Bearer ${token}` }
    });

    restoreList.value = response.data.restores;
    restorePagination.value.itemCount = response.data.total;
  } catch (error: any) {
    message.error(`加载恢复列表失败: ${error.response?.data?.error?.message || error.message}`);
  } finally {
    loadingRestores.value = false;
  }
}

async function confirmCreateBackup() {
  await createBackup();
}

async function createBackup() {
  creatingBackup.value = true;
  try {
    const token = localStorage.getItem('token');
    await axios.post(
      '/api/admin/backup/create',
      {
        includes_logs: createBackupForm.value.includeLogs
      },
      {
        headers: { Authorization: `Bearer ${token}` }
      }
    );

    message.success('备份任务已启动，请稍后刷新列表查看进度');
    showCreateBackupModal.value = false;

    setTimeout(() => {
      loadBackupList();
    }, 2000);
  } catch (error: any) {
    message.error(`创建备份失败: ${error.response?.data?.error?.message || error.message}`);
  } finally {
    creatingBackup.value = false;
  }
}

async function syncBackupsFromS3() {
  syncingBackups.value = true;
  try {
    const token = localStorage.getItem('token');
    const response = await axios.post(
      '/api/admin/backup/sync',
      {},
      {
        headers: { Authorization: `Bearer ${token}` }
      }
    );

    message.success(response.data.message);
    await loadBackupList();
  } catch (error: any) {
    message.error(`同步备份失败: ${error.response?.data?.error?.message || error.message}`);
  } finally {
    syncingBackups.value = false;
  }
}

function openRestoreModal(backup: any) {
  selectedBackup.value = backup;
  restoreForm.value = {
    restoreType: 'full',
    createBackupBeforeRestore: true,
    tablesToRestore: []
  };
  showRestoreModal.value = true;
}

async function confirmRestoreBackup() {
  if (!selectedBackup.value) return;

  // Validate partial restore
  if (restoreForm.value.restoreType === 'partial' && restoreForm.value.tablesToRestore.length === 0) {
    message.error('请至少选择一个要恢复的表');
    return;
  }

  await restoreBackup();
}

async function restoreBackup() {
  if (!selectedBackup.value) return;

  restoringBackup.value = true;
  try {
    const token = localStorage.getItem('token');
    const payload: any = {
      backup_id: selectedBackup.value.id,
      restore_type: restoreForm.value.restoreType,
      create_backup_before_restore: restoreForm.value.createBackupBeforeRestore
    };

    if (restoreForm.value.restoreType === 'partial') {
      payload.tables_to_restore = restoreForm.value.tablesToRestore;
    }

    await axios.post(
      '/api/admin/restore',
      payload,
      {
        headers: { Authorization: `Bearer ${token}` }
      }
    );

    message.success('恢复任务已启动，请稍后刷新列表查看进度');
    showRestoreModal.value = false;

    setTimeout(() => {
      loadRestoreList();
    }, 2000);
  } catch (error: any) {
    message.error(`恢复失败: ${error.response?.data?.error?.message || error.message}`);
  } finally {
    restoringBackup.value = false;
  }
}

async function deleteBackup(id: string) {
  try {
    const token = localStorage.getItem('token');
    await axios.delete(`/api/admin/backup/${id}`, {
      headers: { Authorization: `Bearer ${token}` }
    });

    message.success('备份已删除');
    await loadBackupList();
  } catch (error: any) {
    message.error(`删除备份失败: ${error.response?.data?.error?.message || error.message}`);
  }
}

function formatTimestamp(timestamp?: number): string {
  if (!timestamp) return '-';
  return new Date(timestamp).toLocaleString('zh-CN');
}

function formatFileSize(bytes?: number): string {
  if (!bytes) return '-';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

// Lifecycle
onMounted(() => {
  loadS3Config();
  loadBackupConfig();
  loadBackupList();
  loadRestoreList();
});
</script>
