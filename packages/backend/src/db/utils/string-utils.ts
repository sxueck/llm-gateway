/**
 * 计算字符串的 UTF-8 字节长度
 */
export function getByteLength(str: string): number {
  return Buffer.byteLength(str, 'utf8');
}

/**
 * 按字节长度截断字符串，确保不会超过指定的字节数
 * 同时确保不会在 UTF-8 多字节字符中间截断
 */
export function truncateToByteLength(str: string, maxBytes: number): string {
  if (getByteLength(str) <= maxBytes) {
    return str;
  }

  // 预留一些空间给截断标记
  const suffix = '...[truncated]';
  const suffixBytes = getByteLength(suffix);
  const targetBytes = maxBytes - suffixBytes;

  // 使用二分查找找到合适的截断点
  let low = 0;
  let high = str.length;
  let result = '';

  while (low < high) {
    const mid = Math.floor((low + high + 1) / 2);
    const substr = str.substring(0, mid);
    if (getByteLength(substr) <= targetBytes) {
      result = substr;
      low = mid;
    } else {
      high = mid - 1;
    }
  }

  return result + suffix;
}
