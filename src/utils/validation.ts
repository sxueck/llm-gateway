export function validateCustomKey(key: string): { valid: boolean; message?: string } {
  if (key.length < 8 || key.length > 64) {
    return { valid: false, message: '密钥长度必须在 8-64 个字符之间' };
  }

  if (!/^[a-zA-Z0-9_-]+$/.test(key)) {
    return { valid: false, message: '密钥只能包含字母、数字、下划线和连字符' };
  }

  return { valid: true };
}

export function validateUsername(username: string): { valid: boolean; message?: string } {
  if (username.length < 3 || username.length > 32) {
    return { valid: false, message: '用户名长度必须在 3-32 个字符之间' };
  }

  if (!/^[a-zA-Z0-9_-]+$/.test(username)) {
    return { valid: false, message: '用户名只能包含字母、数字、下划线和连字符' };
  }

  return { valid: true };
}

export function validatePassword(password: string): { valid: boolean; message?: string } {
  if (password.length < 6) {
    return { valid: false, message: '密码长度至少为 6 个字符' };
  }

  return { valid: true };
}

export function validateUUID(id: string): { valid: boolean; message?: string } {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuidRegex.test(id)) {
    return { valid: false, message: '无效的 UUID 格式' };
  }
  return { valid: true };
}

export function validateCompressionConfig(config: any): { valid: boolean; message?: string } {
  if (typeof config !== 'object' || config === null) {
    return { valid: false, message: '压缩配置必须是对象' };
  }

  if (config.maxTokens !== undefined) {
    if (typeof config.maxTokens !== 'number' || config.maxTokens <= 0 || config.maxTokens > 1000000) {
      return { valid: false, message: 'maxTokens 必须是 1-1000000 之间的数字' };
    }
  }

  if (config.minMessages !== undefined) {
    if (typeof config.minMessages !== 'number' || config.minMessages < 1 || config.minMessages > 1000) {
      return { valid: false, message: 'minMessages 必须是 1-1000 之间的数字' };
    }
  }

  if (config.keepRecentTokens !== undefined) {
    if (typeof config.keepRecentTokens !== 'number' || config.keepRecentTokens <= 0 || config.keepRecentTokens > 1000000) {
      return { valid: false, message: 'keepRecentTokens 必须是 1-1000000 之间的数字' };
    }
  }

  if (config.compressionRatio !== undefined) {
    if (typeof config.compressionRatio !== 'number' || config.compressionRatio <= 0 || config.compressionRatio > 1) {
      return { valid: false, message: 'compressionRatio 必须是 0-1 之间的数字' };
    }
  }

  return { valid: true };
}

