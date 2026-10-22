import request from '@/utils/request'

export interface TableSizeInfo {
  table: string
  engine: string | null
  rows: number
  dataMb: number
  indexMb: number
  freeMb: number
  totalMb: number
}

export interface PurgePlan {
  table: string
  mode: 'age' | 'expired'
  cutoffAt: number | null
  estimatedRows: number
}

export interface PurgeResult {
  table: string
  deleted: number
  batches: number
}

export interface OptimizeResult {
  table: string
  ok: boolean
  messages: string[]
}

export interface MaintenanceSettings {
  retentionDays: Record<string, number>
}

export interface LastRunRecord {
  type: 'purge' | 'optimize'
  at: number
  summary: string
}

export interface MaintenanceOverview {
  tables: TableSizeInfo[]
  purgeTargets: PurgePlan[]
  settings: MaintenanceSettings
  lastRun: LastRunRecord | null
}

const BASE_PATH = '/admin/db-maintenance'

export const dbMaintenanceApi = {
  getOverview(): Promise<MaintenanceOverview> {
    return request.get<MaintenanceOverview>(`${BASE_PATH}/overview`)
  },
  async saveSettings(settings: MaintenanceSettings): Promise<MaintenanceSettings> {
    const envelope = await request.put<{ settings: MaintenanceSettings }>(
      `${BASE_PATH}/settings`,
      settings
    )
    return envelope.settings
  },
  async dryRunPurge(targets: string[]): Promise<PurgePlan[]> {
    const envelope = await request.post<{ plans: PurgePlan[] }>(`${BASE_PATH}/purge`, {
      targets,
      dryRun: true,
    })
    return envelope.plans
  },
  async purge(targets: string[]): Promise<PurgeResult[]> {
    const envelope = await request.post<{ results: PurgeResult[] }>(`${BASE_PATH}/purge`, {
      targets,
      dryRun: false,
    })
    return envelope.results
  },
  async optimize(tables: string[]): Promise<OptimizeResult[]> {
    const envelope = await request.post<{ results: OptimizeResult[] }>(
      `${BASE_PATH}/optimize`,
      { tables }
    )
    return envelope.results
  },
}
