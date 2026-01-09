import { MessageApiInjection } from 'naive-ui/es/message/src/MessageProvider';

export async function handleAsyncOperation<T>(
  operation: () => Promise<T>,
  message: MessageApiInjection,
  successMessage: string,
  errorMessage: string
): Promise<T | undefined> {
  try {
    const result = await operation();
    message.success(successMessage);
    return result;
  } catch (e: any) {
    message.error(`${errorMessage}: ${e.message || e}`);
    return undefined;
  }
}

