import { useMessage } from 'naive-ui';
import i18n from '@/i18n';

export function formatJson(data: any): string {
  try {
    if (typeof data === 'string') {
      return JSON.stringify(JSON.parse(data), null, 2);
    }
    return JSON.stringify(data, null, 2);
  } catch {
    return String(data);
  }
}

export function copyToClipboard(text: string): Promise<void> {
  const message = useMessage();
  
  const t = i18n.global.t;
  return navigator.clipboard.writeText(text)
    .then(() => {
      message.success(t('messages.copied'));
    })
    .catch(() => {
      message.error(t('messages.copyFailed'));
    });
}

export function formatTimestamp(timestamp: number): string {
  const date = new Date(timestamp);
  return date.toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

