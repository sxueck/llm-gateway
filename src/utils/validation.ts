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

