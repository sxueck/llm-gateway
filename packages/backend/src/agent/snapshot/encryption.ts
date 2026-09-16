import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';
import { systemConfigDb } from '../../db/index.js';

const MASTER_KEY_CONFIG = 'agent.snapshot.master_key';
const IV_BYTES = 12;
const TAG_BYTES = 16;

let cachedMasterKey: Buffer | null = null;

/**
 * 主密钥来源：env AGENT_SNAPSHOT_MASTER_KEY（64 位 hex）优先；
 * 未配置时自动生成并持久化到 system_config，密钥不落代码或日志。
 */
export async function getMasterKey(): Promise<Buffer> {
  if (cachedMasterKey) return cachedMasterKey;
  const fromEnv = process.env.AGENT_SNAPSHOT_MASTER_KEY;
  if (fromEnv && /^[0-9a-f]{64}$/i.test(fromEnv)) {
    cachedMasterKey = Buffer.from(fromEnv, 'hex');
    return cachedMasterKey;
  }
  const stored = await systemConfigDb.get(MASTER_KEY_CONFIG);
  if (stored && /^[0-9a-f]{64}$/i.test(stored.value)) {
    cachedMasterKey = Buffer.from(stored.value, 'hex');
    return cachedMasterKey;
  }
  const generated = randomBytes(32).toString('hex');
  await systemConfigDb.set(MASTER_KEY_CONFIG, generated, 'agent snapshot envelope encryption master key');
  cachedMasterKey = Buffer.from(generated, 'hex');
  return cachedMasterKey;
}

/** 生成 per-snapshot DEK。 */
export function generateDek(): Buffer {
  return randomBytes(32);
}

/** 用主密钥包裹 DEK，返回 base64(iv|tag|ct)。 */
export function wrapDek(masterKey: Buffer, dek: Buffer): string {
  return encryptBlob(masterKey, dek).toString('base64');
}

export function unwrapDek(masterKey: Buffer, wrapped: string): Buffer {
  return decryptBlob(masterKey, Buffer.from(wrapped, 'base64'));
}

/** AES-256-GCM 加密二进制，输出 iv|tag|ciphertext。 */
export function encryptBlob(dek: Buffer, plaintext: Buffer): Buffer {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', dek, iv);
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]);
}

export function decryptBlob(dek: Buffer, envelope: Buffer): Buffer {
  const iv = envelope.subarray(0, IV_BYTES);
  const tag = envelope.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const ct = envelope.subarray(IV_BYTES + TAG_BYTES);
  const decipher = createDecipheriv('aes-256-gcm', dek, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]);
}

/** 文本便捷封装：base64(iv|tag|ct)。 */
export function encryptText(dek: Buffer, text: string): string {
  return encryptBlob(dek, Buffer.from(text, 'utf8')).toString('base64');
}

export function decryptText(dek: Buffer, container: string): string {
  return decryptBlob(dek, Buffer.from(container, 'base64')).toString('utf8');
}
