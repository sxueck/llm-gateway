/**
 * time_priority（时段优先）路由模式的纯逻辑：
 * - HH:mm 解析（左闭右开区间，支持跨午夜，end 额外允许 '24:00' 当天收尾，与后端契约一致）
 * - 同一生效日的时段重叠检测
 * - target_order（targets 的零基索引全排列）校验与修复，以及 targets 删除/换位后的索引重映射
 * - 存取契约的归一化/序列化，以及 IANA 时区解析
 *
 * UI 组件只做展示与交互，规则语义统一收敛在这里。
 */

export interface TimePriorityTimeRule {
  /** 0=周日 … 6=周六 */
  days: number[];
  /** "HH:mm"，区间为 [start, end)，start > end 表示跨午夜 */
  start: string;
  end: string;
  /** targets 的零基索引全排列，命中时段时按此顺序软优先 */
  target_order: number[];
}

export const MINUTES_PER_DAY = 24 * 60;

const HHMM_PATTERN = /^(\d{2}):(\d{2})$/;

/** 与后端契约一致：end 允许 '24:00' 表示当天收尾（1440 分钟），start 不允许。 */
export const END_OF_DAY_HHMM = '24:00';

/** 是否为当天收尾时刻 '24:00'。 */
export function isEndOfDayHHmm(value: unknown): boolean {
  return value === END_OF_DAY_HHMM;
}

/** "HH:mm" → 当日分钟数；非法输入返回 null（严格两位小时/分钟，00:00–23:59，额外接受 '24:00' → 1440）。 */
export function parseHHmm(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  if (value.trim() === END_OF_DAY_HHMM) return MINUTES_PER_DAY;
  const match = HHMM_PATTERN.exec(value.trim());
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) return null;
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return hour * 60 + minute;
}

/** 当日分钟数 → "HH:mm"（1440 → '24:00'）。 */
export function formatHHmm(minutes: number): string {
  const safe = Math.max(0, Math.min(MINUTES_PER_DAY, Math.round(minutes)));
  if (safe === MINUTES_PER_DAY) return END_OF_DAY_HHMM;
  const hour = Math.floor(safe / 60);
  const minute = safe % 60;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

export function isValidDayOfWeek(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 6;
}

export function defaultTargetOrder(targetCount: number): number[] {
  return Array.from({ length: Math.max(0, targetCount) }, (_, index) => index);
}

/** target_order 必须恰好是 0..targetCount-1 的一个排列。 */
export function isValidTargetOrder(order: unknown, targetCount: number): boolean {
  if (!Array.isArray(order) || order.length !== targetCount) return false;
  const seen = new Set<number>();
  for (const index of order) {
    if (typeof index !== 'number' || !Number.isInteger(index)) return false;
    if (index < 0 || index >= targetCount) return false;
    if (seen.has(index)) return false;
    seen.add(index);
  }
  return true;
}

/**
 * 把可能失真的 target_order 修复为合法排列：保留范围内未重复的相对顺序，补齐缺失索引。
 * targets 增删后调用，避免规则引用悬空索引。
 */
export function repairTargetOrder(order: unknown, targetCount: number): number[] {
  if (isValidTargetOrder(order, targetCount) && Array.isArray(order)) {
    return [...order];
  }
  const source = Array.isArray(order)
    ? order.filter((index): index is number =>
        typeof index === 'number' && Number.isInteger(index) && index >= 0 && index < targetCount)
    : [];
  const repaired: number[] = [];
  for (const index of source) {
    if (!repaired.includes(index)) repaired.push(index);
  }
  for (let index = 0; index < targetCount; index++) {
    if (!repaired.includes(index)) repaired.push(index);
  }
  return repaired.slice(0, targetCount);
}

/**
 * targets 删除下标 removedIndex 后重映射单条 target_order：
 * 删除该下标的引用，并把更大的索引整体减一（保持其余目标的身份与相对顺序）。
 */
export function removeTargetFromOrder(order: unknown, removedIndex: number): number[] {
  const source = Array.isArray(order) ? order : [];
  if (!Number.isInteger(removedIndex) || removedIndex < 0) return [...(source as number[])];
  return (source as number[])
    .filter(index => index !== removedIndex)
    .map(index => (typeof index === 'number' && index > removedIndex ? index - 1 : index));
}

/**
 * 默认目标列表中下标 a/b 互换后重映射单条 target_order：a→b、b→a，其余不变
 * （目标身份与其在规则内的位置都保持不变）。a/b 非法或相同时原样拷贝。
 */
export function swapTargetsInOrder(order: unknown, a: number, b: number): number[] {
  const source = Array.isArray(order) ? order : [];
  if (!Number.isInteger(a) || !Number.isInteger(b) || a < 0 || b < 0 || a === b) {
    return [...(source as number[])];
  }
  return (source as number[]).map(index => (index === a ? b : index === b ? a : index));
}

/** 删除默认目标后重映射所有规则的 target_order（返回新数组，不改入参）。 */
export function removeTargetFromRules(
  rules: TimePriorityTimeRule[],
  removedIndex: number,
): TimePriorityTimeRule[] {
  return rules.map(rule => ({ ...rule, target_order: removeTargetFromOrder(rule.target_order, removedIndex) }));
}

/** 默认目标 a/b 换位后重映射所有规则的 target_order（返回新数组，不改入参）。 */
export function swapTargetsInRules(
  rules: TimePriorityTimeRule[],
  a: number,
  b: number,
): TimePriorityTimeRule[] {
  return rules.map(rule => ({ ...rule, target_order: swapTargetsInOrder(rule.target_order, a, b) }));
}

/** 区间是否跨午夜（start > end）。时间非法或 start === end 时无意义，返回 false。 */
export function ruleCrossesMidnight(rule: Pick<TimePriorityTimeRule, 'start' | 'end'>): boolean {
  const start = parseHHmm(rule.start);
  const end = parseHHmm(rule.end);
  if (start === null || end === null) return false;
  return start > end;
}

/**
 * 规则在指定星期几（0=周日）上实际占用的 [start, end) 分钟区间：
 * - start < end：当日 [start, end)
 * - start > end（跨午夜）：当日 [start, 24:00) + 次日 [00:00, end)
 * 时间非法（或空区间）返回 []。
 */
export function ruleIntervalsOnDay(
  rule: Pick<TimePriorityTimeRule, 'days' | 'start' | 'end'>,
  day: number,
): Array<[number, number]> {
  if (!isValidDayOfWeek(day)) return [];
  const start = parseHHmm(rule.start);
  const end = parseHHmm(rule.end);
  if (start === null || end === null || start === end) return [];
  const days = Array.isArray(rule.days) ? rule.days : [];
  const intervals: Array<[number, number]> = [];
  if (days.includes(day)) {
    intervals.push(start < end ? [start, end] : [start, MINUTES_PER_DAY]);
  }
  if (start > end && days.includes((day + 6) % 7)) {
    // 前一天跨午夜延续到当日清晨
    intervals.push([0, end]);
  }
  return intervals;
}

export function intervalsOverlap(a: [number, number], b: [number, number]): boolean {
  return a[0] < b[1] && b[0] < a[1];
}

/** 指定时刻（day + 当日分钟数）是否命中规则（左闭右开，含跨午夜）。 */
export function ruleMatches(
  rule: Pick<TimePriorityTimeRule, 'days' | 'start' | 'end'>,
  day: number,
  minutes: number,
): boolean {
  return ruleIntervalsOnDay(rule, day).some(([start, end]) => minutes >= start && minutes < end);
}

/** 第一条命中 day+minutes 的规则下标；未命中返回 -1。 */
export function findActiveRuleIndex(
  rules: TimePriorityTimeRule[],
  day: number,
  minutes: number,
): number {
  for (let index = 0; index < rules.length; index++) {
    if (ruleMatches(rules[index], day, minutes)) return index;
  }
  return -1;
}

/**
 * 找出第一对在同一生效日上区间重叠的规则（返回规则下标），无重叠返回 null。
 * 逐日展开为半开区间后排序扫描；相邻（如 09:00–12:00 与 12:00–18:00）不算重叠。
 */
export function findRuleOverlap(rules: TimePriorityTimeRule[]): { a: number; b: number } | null {
  for (let day = 0; day < 7; day++) {
    const segments: Array<{ ruleIndex: number; interval: [number, number] }> = [];
    rules.forEach((rule, ruleIndex) => {
      for (const interval of ruleIntervalsOnDay(rule, day)) {
        segments.push({ ruleIndex, interval });
      }
    });
    segments.sort((x, y) => x.interval[0] - y.interval[0] || x.interval[1] - y.interval[1]);
    for (let i = 1; i < segments.length; i++) {
      if (intervalsOverlap(segments[i - 1].interval, segments[i].interval)) {
        return { a: segments[i - 1].ruleIndex, b: segments[i].ruleIndex };
      }
    }
  }
  return null;
}

export type TimeRuleIssueType =
  | 'no-rules'
  | 'days-empty'
  | 'time-invalid'
  | 'empty-range'
  | 'order-invalid'
  | 'overlap';

export interface TimeRuleIssue {
  type: TimeRuleIssueType;
  /** 1-based 展示由调用方处理；这里保持 0-based 规则下标 */
  ruleIndex?: number;
  otherRuleIndex?: number;
}

/** 校验一组规则；返回全部问题（UI 负责翻译成文案）。 */
export function validateTimeRules(
  rules: TimePriorityTimeRule[],
  targetCount: number,
): TimeRuleIssue[] {
  const issues: TimeRuleIssue[] = [];
  if (rules.length === 0) {
    issues.push({ type: 'no-rules' });
    return issues;
  }
  rules.forEach((rule, ruleIndex) => {
    if (!Array.isArray(rule.days) || rule.days.length === 0) {
      issues.push({ type: 'days-empty', ruleIndex });
      return;
    }
    const start = parseHHmm(rule.start);
    const end = parseHHmm(rule.end);
    // start 不允许 '24:00'（后端契约），end 允许
    if (start === null || end === null || start >= MINUTES_PER_DAY) {
      issues.push({ type: 'time-invalid', ruleIndex });
      return;
    }
    if (start === end) {
      issues.push({ type: 'empty-range', ruleIndex });
    }
    if (targetCount > 0 && !isValidTargetOrder(rule.target_order, targetCount)) {
      issues.push({ type: 'order-invalid', ruleIndex });
    }
  });
  const overlap = findRuleOverlap(rules);
  if (overlap) {
    issues.push({ type: 'overlap', ruleIndex: overlap.a, otherRuleIndex: overlap.b });
  }
  return issues;
}

/**
 * 从存储的 config.strategy.time_rules 宽容解析为可编辑规则：
 * days 去重升序、时间回退默认值、target_order 按当前 targets 数量修复。
 */
export function normalizeTimeRules(raw: unknown, targetCount: number): TimePriorityTimeRule[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((item): item is Record<string, unknown> => !!item && typeof item === 'object')
    .map(item => {
      const days = Array.isArray(item.days)
        ? [...new Set(item.days.filter(isValidDayOfWeek))].sort((a, b) => a - b)
        : [];
      const start = parseHHmm(item.start) !== null ? String(item.start).trim() : '09:00';
      const end = parseHHmm(item.end) !== null ? String(item.end).trim() : '18:00';
      const targetOrder = Array.isArray(item.target_order)
        ? repairTargetOrder(item.target_order, targetCount)
        : defaultTargetOrder(targetCount);
      return { days, start, end, target_order: targetOrder };
    });
}

/** 保存契约前的深拷贝序列化（UI 状态 → time_rules 数组）。 */
export function serializeTimeRules(rules: TimePriorityTimeRule[]): TimePriorityTimeRule[] {
  return rules.map(rule => ({
    days: [...rule.days],
    start: rule.start,
    end: rule.end,
    target_order: [...rule.target_order],
  }));
}

/** 校验 IANA 时区名（Intl 可识别）。 */
export function isIanaTimezone(timezone: unknown): timezone is string {
  if (typeof timezone !== 'string' || timezone.trim() === '') return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
    return true;
  } catch (error) {
    if (error instanceof RangeError) return false;
    throw error;
  }
}

/** 存储值 → 合法 IANA 时区；非法回退 UTC。 */
export function resolveTimezone(timezone: unknown): string {
  return isIanaTimezone(timezone) ? timezone : 'UTC';
}

/** 浏览器/系统时区；取不到或非法时回退 UTC。 */
export function resolveDefaultTimezone(): string {
  return resolveTimezone(Intl.DateTimeFormat().resolvedOptions().timeZone);
}

export interface ZonedParts {
  /** 0=周日 … 6=周六 */
  day: number;
  /** 当日分钟数 */
  minutes: number;
}

const WEEKDAY_SHORT_INDEX: Record<string, number> = {
  Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
};

/** 指定时区下的星期与当日分钟数（用于“当前生效”标记）；时区非法返回 null。 */
export function getZonedParts(date: Date, timeZone: string): ZonedParts | null {
  if (!isIanaTimezone(timeZone)) return null;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const byType: Record<string, string> = {};
  for (const part of parts) {
    if (part.type !== 'literal') byType[part.type] = part.value;
  }
  const day = WEEKDAY_SHORT_INDEX[byType.weekday];
  const hour = Number(byType.hour);
  const minute = Number(byType.minute);
  if (day === undefined || !Number.isInteger(hour) || !Number.isInteger(minute)) return null;
  return { day, minutes: hour * 60 + minute };
}

/** "HH:mm" → naive-ui n-time-picker 的时间戳值（本地时区的固定日期）。 */
export function hhmmToTimeValue(hhmm: string): number {
  const minutes = parseHHmm(hhmm) ?? 0;
  return new Date(2000, 0, 1, Math.floor(minutes / 60), minutes % 60).getTime();
}

/** naive-ui n-time-picker 的时间戳值 → "HH:mm"。 */
export function timeValueToHHmm(value: number | null): string {
  if (typeof value !== 'number' || Number.isNaN(value)) return '00:00';
  const date = new Date(value);
  return formatHHmm(date.getHours() * 60 + date.getMinutes());
}
