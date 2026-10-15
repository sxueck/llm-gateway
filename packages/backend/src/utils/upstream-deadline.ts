/** Bounds a whole upstream exchange; `touch()` restarts it so streams only fail when idle. */
export function createUpstreamDeadline(clientSignal: AbortSignal | undefined, ms: number): {
  signal: AbortSignal;
  touch(): void;
  readonly timedOut: boolean;
  dispose(): void;
} {
  const controller = new AbortController();
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout>;
  const touch = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, ms);
  };
  const onClientAbort = () => controller.abort();
  if (clientSignal?.aborted) controller.abort();
  else clientSignal?.addEventListener('abort', onClientAbort, { once: true });
  touch();
  return {
    signal: controller.signal,
    touch,
    get timedOut() {
      return timedOut;
    },
    dispose() {
      clearTimeout(timer);
      clientSignal?.removeEventListener('abort', onClientAbort);
    },
  };
}
