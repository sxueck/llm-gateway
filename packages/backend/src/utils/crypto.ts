import { createHash, randomBytes, createCipheriv, createDecipheriv } from 'crypto';
import { appConfig } from '../config/index.js';

const ALGORITHM = 'aes-256-cbc';
const ENCRYPTION_KEY = Buffer.from(appConfig.jwtSecret.slice(0, 32).padEnd(32, '0'));

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('hex');
  const hash = createHash('sha256').update(password + salt).digest('hex');
  return `${salt}:${hash}`;
}

export function verifyPassword(password: string, storedHash: string): boolean {
  const [salt, hash] = storedHash.split(':');
  const testHash = createHash('sha256').update(password + salt).digest('hex');
  return hash === testHash;
}

export function hashKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

export function encryptApiKey(apiKey: string): string {
  const iv = randomBytes(16);
  const cipher = createCipheriv(ALGORITHM, ENCRYPTION_KEY, iv);
  let encrypted = cipher.update(apiKey, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  return `${iv.toString('hex')}:${encrypted}`;
}

export function decryptApiKey(encryptedKey: string): string {
  try {
    const [ivHex, encrypted] = encryptedKey.split(':');
    if (!ivHex || !encrypted) {
      throw new Error('加密数据格式无效');
    }
    const iv = Buffer.from(ivHex, 'hex');
    const decipher = createDecipheriv(ALGORITHM, ENCRYPTION_KEY, iv);
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch (error: any) {
    if (error.message?.includes('bad decrypt') || error.code === 'ERR_OSSL_BAD_DECRYPT') {
      throw new Error('API 密钥解密失败,可能是因为 JWT_SECRET 已更改。请重新设置 Provider 的 API 密钥');
    }
    throw error;
  }
}

