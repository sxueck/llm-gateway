import { beforeEach, describe, expect, it, vi } from 'vitest';

// config 需要 env 才会在 collect 阶段通过 zod 校验
vi.hoisted(() => {
  process.env.JWT_SECRET ??= 'vitest-placeholder-secret-32-chars!!';
  process.env.MYSQL_PASSWORD ??= 'vitest-placeholder';
});

const listImages = vi.hoisted(() => vi.fn());
const getRunTotals = vi.hoisted(() => vi.fn());
const getModelStats = vi.hoisted(() => vi.fn());
const modelGetAll = vi.hoisted(() => vi.fn());
const resolveModelCost = vi.hoisted(() => vi.fn());
const presetStats = vi.hoisted(() => vi.fn());
const allCircuitStats = vi.hoisted(() => vi.fn());
const getLastCompletedBackup = vi.hoisted(() => vi.fn());
const bufferSize = vi.hoisted(() => vi.fn());
const queueDepth = vi.hoisted(() => vi.fn());

vi.mock('dockerode', () => ({
  default: vi.fn(() => ({ listImages })),
}));
vi.mock('../db/index.js', () => ({
  modelDb: { getAll: modelGetAll },
  apiRequestDb: { getModelStats },
}));
vi.mock('../db/backup.js', () => ({ backupDb: { getLastCompletedBackup } }));
vi.mock('../db/utils/buffer.js', () => ({
  getBufferSize: bufferSize,
  getMaxBufferSize: () => 200,
}));
vi.mock('../db/repositories/agent-metrics.repository.js', () => ({
  agentMetricsRepository: { getRunTotals },
}));
vi.mock('./circuit-breaker.js', () => ({
  CircuitState: { OPEN: 'OPEN', CLOSED: 'CLOSED', HALF_OPEN: 'HALF_OPEN' },
  circuitBreaker: { getAllStats: allCircuitStats },
}));
vi.mock('./cost-mapping.js', () => ({
  costMappingService: { resolveModelCost },
}));
vi.mock('./model-presets.js', () => ({
  modelPresetsService: { getStats: presetStats, resolvePreset: () => null },
}));
vi.mock('../agent/run/scheduler.js', () => ({
  searchRunScheduler: { queueDepth },
}));

const { collectAlerts, imagePresentInList } = await import('./alerts.js');

const IMAGE = 'ghcr.io/sxueck/llm-gateway/craft-worker:latest';

function quietEnvironment() {
  presetStats.mockReturnValue({ totalModels: 3800, cacheAge: 60_000, lastUpdate: Date.now(), providers: [] });
  getModelStats.mockResolvedValue([]);
  modelGetAll.mockResolvedValue([]);
  getRunTotals.mockResolvedValue({ runs: 0, completed: 0, failed: 0, queued: 0 });
  allCircuitStats.mockReturnValue(new Map());
  getLastCompletedBackup.mockResolvedValue({ completed_at: Date.now() });
  bufferSize.mockReturnValue(0);
  queueDepth.mockReturnValue(0);
  resolveModelCost.mockResolvedValue({ source: 'direct', model: 'm', info: {} });
}

beforeEach(() => {
  listImages.mockClear();
  quietEnvironment();
  process.env.AGENT_WORKER_IMAGE = IMAGE;
  delete process.env.AGENT_WORKER_LOCAL;
  process.env.AGENT_SEARCH_CONCURRENCY = '2';
});

describe('worker 运行时体检', () => {
  it('启用了 worker 但主机没有镜像 -> worker_image_missing', async () => {
    listImages.mockResolvedValue([{ RepoTags: ['mysql:8'] }]);
    const alerts = await collectAlerts({ fresh: true });
    const hit = alerts.find(a => a.code === 'worker_image_missing');
    expect(hit?.level).toBe('warning');
    expect(hit?.message).toContain('自动拉取');
    expect(hit?.params?.image).toBe(IMAGE);
  });

  it('镜像在位时不再告警', async () => {
    listImages.mockResolvedValue([{ RepoTags: [IMAGE] }]);
    const alerts = await collectAlerts({ fresh: true });
    expect(alerts.map(a => a.code)).not.toContain('worker_image_missing');
  });

  it('配置里不带 tag 时按仓库匹配任意本地 tag', async () => {
    process.env.AGENT_WORKER_IMAGE = 'ghcr.io/sxueck/llm-gateway/craft-worker';
    listImages.mockResolvedValue([{ RepoTags: [IMAGE] }]);
    const alerts = await collectAlerts({ fresh: true });
    expect(alerts.map(a => a.code)).not.toContain('worker_image_missing');
  });

  it('连不上 Docker 守护进程 -> worker_docker_unavailable', async () => {
    listImages.mockRejectedValue(new Error('ENOENT /var/run/docker.sock'));
    const alerts = await collectAlerts({ fresh: true });
    const hit = alerts.find(a => a.code === 'worker_docker_unavailable');
    expect(hit?.level).toBe('error');
    // 连不上 Docker 时不该再报“镜像缺失”，两条告警会互相掩盖真因
    expect(alerts.map(a => a.code)).not.toContain('worker_image_missing');
  });

  it('未配置执行器但确实有 run -> worker_executor_missing', async () => {
    delete process.env.AGENT_WORKER_IMAGE;
    getRunTotals.mockResolvedValue({ runs: 3, completed: 0, failed: 3, queued: 0 });
    const alerts = await collectAlerts({ fresh: true });
    expect(alerts.map(a => a.code)).toContain('worker_executor_missing');
  });

  it('没启用 worker 也不跑东西时保持安静', async () => {
    delete process.env.AGENT_WORKER_IMAGE;
    const alerts = await collectAlerts({ fresh: true });
    expect(alerts.map(a => a.code)).toEqual([]);
  });

  it('本地执行器模式不去探测 Docker', async () => {
    delete process.env.AGENT_WORKER_IMAGE;
    process.env.AGENT_WORKER_LOCAL = '1';
    const alerts = await collectAlerts({ fresh: true });
    expect(listImages).not.toHaveBeenCalled();
    expect(alerts.map(a => a.code)).toEqual([]);
    delete process.env.AGENT_WORKER_LOCAL;
  });

  it('并发打满且有排队 -> worker_queue_saturated', async () => {
    listImages.mockResolvedValue([{ RepoTags: [IMAGE] }]);
    queueDepth.mockReturnValue(2);
    getRunTotals.mockResolvedValue({ runs: 5, completed: 3, failed: 0, queued: 2 });
    const alerts = await collectAlerts({ fresh: true });
    expect(alerts.map(a => a.code)).toContain('worker_queue_saturated');
  });

  it('run 失败 -> worker_run_failed 并带上数量', async () => {
    listImages.mockResolvedValue([{ RepoTags: [IMAGE] }]);
    getRunTotals.mockResolvedValue({ runs: 6, completed: 2, failed: 4, queued: 0 });
    const alerts = await collectAlerts({ fresh: true });
    expect(alerts.find(a => a.code === 'worker_run_failed')?.count).toBe(4);
  });
});

describe('imagePresentInList', () => {
  it('匹配 RepoTags 与无 tag 的配置', () => {
    expect(imagePresentInList(IMAGE, [[IMAGE]])).toBe(true);
    expect(imagePresentInList(IMAGE, [['other:latest']])).toBe(false);
    expect(
      imagePresentInList('ghcr.io/sxueck/llm-gateway/craft-worker', [[IMAGE]]),
    ).toBe(true);
    expect(imagePresentInList(IMAGE, [['ghcr.io/sxueck/llm-gateway/craft-worker:other']])).toBe(
      false,
    );
  });
});

describe('成本与容量告警', () => {
  it('有流量但取不到牌价 -> model_price_missing', async () => {
    listImages.mockResolvedValue([{ RepoTags: [IMAGE] }]);
    getModelStats.mockResolvedValue([{ model: 'mystery-model', totalTokens: 1000 }]);
    resolveModelCost.mockResolvedValue(null);
    const alerts = await collectAlerts({ fresh: true });
    const hit = alerts.find(a => a.code === 'model_price_missing');
    expect(getModelStats).toHaveBeenCalledWith(
      expect.objectContaining({ uniqueModels: true, limit: null }),
    );
    expect(hit?.params?.models).toContain('mystery-model');
  });

  it('已启用的手工成本映射不触发未映射告警', async () => {
    listImages.mockResolvedValue([{ RepoTags: [IMAGE] }]);
    modelGetAll.mockResolvedValue([
      { model_identifier: 'custom-model', name: 'custom-model', model_attributes: null, is_virtual: 0, enabled: 1 },
    ]);
    resolveModelCost.mockResolvedValue({
      source: 'mapping',
      model: 'gpt-5.5',
      info: { input_cost_per_token: 5e-6 },
    });

    const alerts = await collectAlerts({ fresh: true });
    expect(alerts.map(a => a.code)).not.toContain('model_pricing_unmapped');
  });

  it('所有已启用模型都无价时仍发出 model_pricing_unmapped', async () => {
    listImages.mockResolvedValue([{ RepoTags: [IMAGE] }]);
    modelGetAll.mockResolvedValue([
      { model_identifier: 'custom-model', name: 'custom-model', model_attributes: null, is_virtual: 0, enabled: 1 },
    ]);
    resolveModelCost.mockResolvedValue(null);

    const alerts = await collectAlerts({ fresh: true });
    expect(alerts.map(a => a.code)).toContain('model_pricing_unmapped');
  });

  it('预设缓存过期 -> model_preset_stale', async () => {
    listImages.mockResolvedValue([{ RepoTags: [IMAGE] }]);
    presetStats.mockReturnValue({
      totalModels: 3800,
      cacheAge: 3 * 24 * 3600 * 1000,
      lastUpdate: 0,
      providers: [],
    });
    const alerts = await collectAlerts({ fresh: true });
    expect(alerts.map(a => a.code)).toContain('model_preset_stale');
  });

  it('写入缓冲积压 -> api_request_buffer_backlog', async () => {
    listImages.mockResolvedValue([{ RepoTags: [IMAGE] }]);
    bufferSize.mockReturnValue(190);
    const alerts = await collectAlerts({ fresh: true });
    expect(alerts.map(a => a.code)).toContain('api_request_buffer_backlog');
  });

  it('供应商熔断 -> provider_circuit_open', async () => {
    listImages.mockResolvedValue([{ RepoTags: [IMAGE] }]);
    allCircuitStats.mockReturnValue(
      new Map([['p1', { state: 'OPEN', failures: 9, successes: 0, lastFailureTime: 0, halfOpenAttempts: 0, triggerCount: 1 }]]),
    );
    const alerts = await collectAlerts({ fresh: true });
    expect(alerts.map(a => a.code)).toContain('provider_circuit_open');
  });

  it('备份过旧 -> backup_stale；从未备份 -> backup_missing', async () => {
    listImages.mockResolvedValue([{ RepoTags: [IMAGE] }]);
    getLastCompletedBackup.mockResolvedValue({ completed_at: Date.now() - 30 * 24 * 3600 * 1000 });
    expect((await collectAlerts({ fresh: true })).map(a => a.code)).toContain('backup_stale');

    getLastCompletedBackup.mockResolvedValue(null);
    expect((await collectAlerts({ fresh: true })).map(a => a.code)).toContain('backup_missing');
  });
});

describe('采集健壮性', () => {
  it('单个检查抛错不影响其它告警', async () => {
    listImages.mockResolvedValue([{ RepoTags: [IMAGE] }]);
    presetStats.mockImplementation(() => {
      throw new Error('db down');
    });
    getRunTotals.mockResolvedValue({ runs: 2, completed: 0, failed: 2, queued: 0 });
    const alerts = await collectAlerts({ fresh: true });
    expect(alerts.map(a => a.code)).toContain('worker_run_failed');
  });

  it('error 排在 warning 之前', async () => {
    listImages.mockRejectedValue(new Error('Docker daemon unavailable'));
    getLastCompletedBackup.mockResolvedValue(null);
    const alerts = await collectAlerts({ fresh: true });
    expect(alerts[0].level).toBe('error');
    expect(alerts[alerts.length - 1].level).toBe('warning');
  });
});
