import { createHash, randomBytes } from 'crypto';

export interface GeneratedServiceToken {
  token: string;
  hash: string;
}

/** run-scoped 短期 service token：明文只在创建响应中交给 worker env，DB 只存 hash。 */
export function generateServiceToken(): GeneratedServiceToken {
  const token = randomBytes(32).toString('hex');
  return { token, hash: hashServiceToken(token) };
}

export function hashServiceToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
