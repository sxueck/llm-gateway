export * from './protocol-types';

export const sleep = (ms: number): Promise<void> =>
  new Promise(resolve => setTimeout(resolve, ms));

export const formatDate = (date: Date | string | number): string => {
  const d = new Date(date);
  return d.toISOString();
};