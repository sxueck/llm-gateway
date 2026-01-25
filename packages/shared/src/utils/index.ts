// 共享工具函数

// 导出协议相关工具
export * from './protocol-types';

/**
 * 延迟函数
 */
export const sleep = (ms: number): Promise<void> =>
  new Promise(resolve => setTimeout(resolve, ms));

/**
 * 格式化日期
 */
export const formatDate = (date: Date | string | number): string => {
  const d = new Date(date);
  return d.toISOString();
};