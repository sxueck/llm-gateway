import { getDatabase } from '../connection.js';

/**
 * 普通用户（/api/me）专用的请求日志视图。
 *
 * 刻意不与 admin 仓储（api-request.repository.ts）共用实现：授权 WHERE
 * （virtual_key_id IN 绑定集合 + disable_logging 口径）必须与列裁剪写在同
 * 一处 SQL 里审阅，两处各自漂移就是一次越权。
 *
 * 列裁剪与不暴露的端点（决策记录）：
 * - 不返回 ip / user_agent：绑定是多对多，同一密钥可绑定多个用户，密钥粒度
 *   日志里的网络元数据可能属于共享该密钥的其他主体；
 * - 不提供会话回放（getSession）：启发式会话按 (virtual_key_id, ip) 切段、
 *   显式会话按 (session_id, virtual_key_id) 聚合，都是密钥粒度而非用户粒度，
 *   api_requests 没有 user_id 列无法归因到人；在多用户共享密钥的场景会把
 *   其他主体的完整对话序列串给同一个用户，不安全，故不暴露。列表/详情只
 *   返回单条请求自身的字段，序列上下文不会跨条泄漏。
 */

export interface UserApiRequestListOptions {
  /** 调用方保证非空且均为当前用户绑定的 virtual_key_id。 */
  virtualKeyIds: string[];
  limit: number;
  offset: number;
  startTime?: number;
  endTime?: number;
  status?: string;
  model?: string;
}

export interface UserApiRequestPage {
  data: Array<Record<string, unknown>>;
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export type UserApiRequestDetail = Record<string, unknown> & {
  id: string;
  virtual_key_id: string;
};

// 与 admin getAll 的 disable_logging 口径一致：密钥关闭日志后其历史对普通
// 用户同样不可见（vk.id IS NULL 仅作 LEFT JOIN 防御，FK 下实际不会发生）。
function disableLoggingCondition(): string {
  return '(vk.id IS NULL OR vk.disable_logging IS NULL OR vk.disable_logging = 0)';
}

function inPlaceholders(ids: string[]): string {
  return ids.map(() => '?').join(', ');
}

function emptyPage(limit: number, offset: number): UserApiRequestPage {
  return {
    data: [],
    total: 0,
    page: Math.floor(offset / limit) + 1,
    pageSize: limit,
    totalPages: 0,
  };
}

// 用户可见列：管理端明细列减去 ip / user_agent / route_log_id。
const USER_LIST_COLUMNS = `
  ar.id,
  ar.virtual_key_id,
  vk.name AS virtual_key_name,
  ar.provider_id,
  p.name AS provider_name,
  ar.model,
  ar.prompt_tokens,
  ar.completion_tokens,
  ar.total_tokens,
  ar.cached_tokens,
  ar.status,
  ar.response_time,
  ar.tfft_ms,
  ar.tffb_ms,
  ar.error_message,
  ar.request_params_json,
  ar.response_meta_json,
  ar.cache_hit,
  ar.request_type,
  ar.compression_original_tokens,
  ar.compression_saved_tokens,
  ar.run_id,
  ar.session_id,
  ar.route_tier,
  ar.created_at,
  COALESCE(ap.request_body, ar.request_body) AS payload_request_body`;

export const userApiRequestRepository = {
  async listForVirtualKeys(
    options: UserApiRequestListOptions,
  ): Promise<UserApiRequestPage> {
    // 空绑定（以及路由层裁剪后的空交集）不触库，直接返回空页。
    if (options.virtualKeyIds.length === 0) {
      return emptyPage(options.limit, options.offset);
    }

    const pool = getDatabase();
    const conn = await pool.getConnection();
    try {
      const scopeParams = [...options.virtualKeyIds];
      const scope = `ar.virtual_key_id IN (${inPlaceholders(scopeParams)})`;

      let countQuery = `
        SELECT COUNT(*) AS total
        FROM api_requests ar
        LEFT JOIN virtual_keys vk ON ar.virtual_key_id = vk.id
        WHERE ${scope} AND ${disableLoggingCondition()}`;

      let dataQuery = `
        SELECT ${USER_LIST_COLUMNS}
        FROM api_requests ar
        LEFT JOIN virtual_keys vk ON ar.virtual_key_id = vk.id
        LEFT JOIN providers p ON ar.provider_id = p.id
        LEFT JOIN api_request_payloads ap ON ap.request_id = ar.id
        WHERE ${scope} AND ${disableLoggingCondition()}`;

      const params: unknown[] = [...scopeParams];

      if (options.startTime !== undefined) {
        countQuery += ' AND ar.created_at >= ?';
        dataQuery += ' AND ar.created_at >= ?';
        params.push(options.startTime);
      }
      if (options.endTime !== undefined) {
        countQuery += ' AND ar.created_at < ?';
        dataQuery += ' AND ar.created_at < ?';
        params.push(options.endTime);
      }
      if (options.status) {
        countQuery += ' AND ar.status = ?';
        dataQuery += ' AND ar.status = ?';
        params.push(options.status);
      }
      if (options.model) {
        countQuery += ' AND ar.model = ?';
        dataQuery += ' AND ar.model = ?';
        params.push(options.model);
      }

      const [countRows] = await conn.query(countQuery, params);
      const total = Number((countRows as Array<{ total: number }>)[0]?.total) || 0;

      const [rows] = await conn.query(
        `${dataQuery} ORDER BY ar.created_at DESC LIMIT ? OFFSET ?`,
        [...params, options.limit, options.offset],
      );

      const data = (rows as Array<Record<string, unknown>>).map((row) => {
        const { payload_request_body, ...rest } = row;
        return { ...rest, request_body: payload_request_body ?? null };
      });

      return {
        data,
        total,
        page: Math.floor(options.offset / options.limit) + 1,
        pageSize: options.limit,
        totalPages: Math.ceil(total / options.limit),
      };
    } finally {
      conn.release();
    }
  },

  /**
   * 用户可见的详情。授权失败与记录不存在返回同一个 undefined——路由层统一
   * 转 404，不给“记录存在但不属于你”和“记录不存在”留下可区分的信号。
   */
  async getByIdForVirtualKeys(
    id: string,
    virtualKeyIds: string[],
  ): Promise<UserApiRequestDetail | undefined> {
    if (virtualKeyIds.length === 0) return undefined;

    const pool = getDatabase();
    const conn = await pool.getConnection();
    try {
      const [rows] = await conn.query(
        `SELECT ${USER_LIST_COLUMNS},
                COALESCE(ap.response_body, ar.response_body) AS payload_response_body
         FROM api_requests ar
         LEFT JOIN virtual_keys vk ON ar.virtual_key_id = vk.id
         LEFT JOIN providers p ON ar.provider_id = p.id
         LEFT JOIN api_request_payloads ap ON ap.request_id = ar.id
         WHERE ar.id = ?
           AND ar.virtual_key_id IN (${inPlaceholders(virtualKeyIds)})
           AND ${disableLoggingCondition()}`,
        [id, ...virtualKeyIds],
      );
      const row = (rows as Array<Record<string, unknown>>)[0];
      if (!row) return undefined;

      const {
        payload_request_body,
        payload_response_body,
        request_body,
        response_body,
        ...rest
      } = row;
      // payloads 表优先，回退到 api_requests 上的同名列（与管理端 getById 一致）。
      return {
        ...rest,
        request_body: payload_request_body ?? request_body ?? null,
        response_body: payload_response_body ?? response_body ?? null,
      } as unknown as UserApiRequestDetail;
    } finally {
      conn.release();
    }
  },
};
