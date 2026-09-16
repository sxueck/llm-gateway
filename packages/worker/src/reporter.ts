/** worker → gateway 上报通道；service token 随每请求携带。 */
export class Reporter {
  constructor(
    private readonly baseUrl: string,
    private readonly runId: string,
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private headers(): Record<string, string> {
    return {
      'content-type': 'application/json',
      'x-agent-service-token': this.token,
    };
  }

  /** 进度事件 best-effort：失败不影响检索流程。 */
  async event(type: string, payload: Record<string, unknown>): Promise<void> {
    try {
      await this.fetchImpl(`${this.baseUrl}/api/internal/agent/runs/${this.runId}/events`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({ type, payload }),
        signal: AbortSignal.timeout(5000),
      });
    } catch {
      // best effort
    }
  }

  /** 终态上报必须成功送达，否则 scheduler 会按 worker_exited_without_result 判失败。 */
  async report(body: Record<string, unknown>): Promise<void> {
    const res = await this.fetchImpl(`${this.baseUrl}/api/internal/agent/runs/${this.runId}/report`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      throw new Error(`terminal report rejected: ${res.status}`);
    }
  }
}
