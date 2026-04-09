export function parsePositiveInt(rawValue: string | undefined, fallbackValue: number): number {
  const parsed = Number.parseInt(rawValue || '', 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallbackValue;
  }
  return parsed;
}
