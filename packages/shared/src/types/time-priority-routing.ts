import { z } from "zod";

/**
 * 智能路由「时段优先」模式契约（routing_configs.config 的 strategy 部分）：
 *
 * - strategy.mode = 'time_priority'
 * - targets：默认有序目标，target_order 引用其零基索引
 * - strategy.timezone：IANA 时区（如 'Asia/Shanghai'）
 * - strategy.time_rules：时段规则数组，每条
 *   { days: number[] (0=周日..6=周六), start: 'HH:mm', end: 'HH:mm', target_order: number[] }
 *   时间区间左闭右开 [start, end)；start > end 表示跨午夜（占用次日 [00:00, end)）；
 *   end 允许 '24:00' 表示当天收尾；规则之间的占用区间禁止重叠（含跨午夜溢出部分）；
 *   target_order 必须是 targets 索引 0..n-1 的全排列（软优先：按序取第一个可用目标）。
 */
export const TIME_PRIORITY_ROUTING_MODE = "time_priority";

const HHMM_START_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;
// end 额外允许 '24:00'（当天收尾），便于表达覆盖到当天结束的区间。
const HHMM_END_PATTERN = /^(([01]\d|2[0-3]):([0-5]\d)|24:00)$/;

export const MINUTES_PER_DAY = 24 * 60;

export interface TimePriorityRule {
  /** 生效起始星期，0=周日..6=周六；跨午夜规则在次日的溢出部分同样生效。 */
  days: number[];
  start: string;
  end: string;
  /** targets 的零基索引全排列，按序软优先。 */
  target_order: number[];
}

/** 解析 'HH:mm' 为当天零点起的分钟数；'24:00' 返回 1440。非法返回 null。 */
export function parseHHmmToMinutes(value: unknown): number | null {
  if (typeof value !== "string") return null;
  if (value === "24:00") return MINUTES_PER_DAY;
  const match = HHMM_START_PATTERN.exec(value);
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

/** 是否为 Intl 接受的 IANA 时区名（大小写不敏感，'UTC' 等别名同样接受）。 */
export function isValidIANATimezone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch (error) {
    // Intl 对无效时区抛 RangeError，这是预期输入；其余异常不应被吞掉。
    if (error instanceof RangeError) return false;
    throw error;
  }
}

export interface ZonedWallClock {
  /** 0=周日..6=周六。 */
  weekday: number;
  /** 当天零点起的分钟数，[0, 1440)。 */
  minutes: number;
}

const WEEKDAY_BY_SHORT_NAME: Readonly<Record<string, number>> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

/** 取 epoch 毫秒在指定时区的墙上时间（星期 + 当天分钟数）；时区非法返回 null。 */
export function getZonedWallClock(epochMs: number, timeZone: string): ZonedWallClock | null {
  try {
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
    });
    const parts = formatter.formatToParts(new Date(epochMs));
    let weekday: number | undefined;
    let minutes = 0;
    for (const part of parts) {
      if (part.type === "weekday") {
        weekday = WEEKDAY_BY_SHORT_NAME[part.value];
      } else if (part.type === "hour") {
        minutes += Number(part.value) * 60;
      } else if (part.type === "minute") {
        minutes += Number(part.value);
      }
    }
    if (weekday === undefined || !Number.isInteger(minutes)) return null;
    if (minutes < 0 || minutes >= MINUTES_PER_DAY) return null;
    return { weekday, minutes };
  } catch (error) {
    // 同 isValidIANATimezone：仅把无效时区（RangeError）折叠为 null。
    if (error instanceof RangeError) return null;
    throw error;
  }
}

/**
 * 规则是否覆盖指定墙上时间。左闭右开；start > end 视为跨午夜：
 * 起始日 [start, 24:00) 与次日 [00:00, end)。start === end 为空区间（恒不生效）。
 */
export function isTimePriorityRuleActiveAt(
  rule: TimePriorityRule,
  weekday: number,
  minutes: number
): boolean {
  const startMinute = parseHHmmToMinutes(rule.start);
  const endMinute = parseHHmmToMinutes(rule.end);
  if (startMinute === null || endMinute === null) return false;
  if (!Array.isArray(rule.days) || rule.days.length === 0) return false;
  if (startMinute === endMinute) return false;

  const startsOnWeekday = rule.days.includes(weekday);
  if (startMinute < endMinute) {
    return startsOnWeekday && minutes >= startMinute && minutes < endMinute;
  }
  // 跨午夜：起始日的尾部 + 起始日前一天（= 当前时间的昨天）的溢出头部。
  if (startsOnWeekday && minutes >= startMinute && minutes < MINUTES_PER_DAY) {
    return true;
  }
  const previousWeekday = (weekday + 6) % 7;
  return rule.days.includes(previousWeekday) && minutes >= 0 && minutes < endMinute;
}

export interface MatchedTimePriorityRule {
  rule: TimePriorityRule;
  /** 命中规则在 time_rules 中的下标。 */
  index: number;
}

/**
 * 找到覆盖 epochMs 的第一条时段规则（配置校验禁止重叠，故至多一条）。
 * 时区缺失或非法返回 null（调用方自行决定回退与告警）。
 */
export function findMatchingTimePriorityRule(
  rules: TimePriorityRule[],
  epochMs: number,
  timeZone: string | undefined
): MatchedTimePriorityRule | null {
  if (!Array.isArray(rules) || rules.length === 0) return null;
  if (typeof timeZone !== "string" || !isValidIANATimezone(timeZone)) return null;
  const wallClock = getZonedWallClock(epochMs, timeZone);
  if (!wallClock) return null;

  for (let index = 0; index < rules.length; index++) {
    const rule = rules[index];
    if (rule && isTimePriorityRuleActiveAt(rule, wallClock.weekday, wallClock.minutes)) {
      return { rule, index };
    }
  }
  return null;
}

/** target_order 是否为 [0, targetCount) 的全排列（每个索引恰好一次）。 */
export function isTimePriorityTargetOrder(order: unknown, targetCount: number): order is number[] {
  if (!Array.isArray(order) || targetCount <= 0) return false;
  if (order.length !== targetCount) return false;
  const seen = new Set<number>();
  for (const index of order) {
    if (typeof index !== "number" || !Number.isInteger(index)) return false;
    if (index < 0 || index >= targetCount) return false;
    if (seen.has(index)) return false;
    seen.add(index);
  }
  return true;
}

interface WeekdaySegment {
  weekday: number;
  from: number;
  to: number;
  ruleIndex: number;
}

/** 把规则按起始星期展开为 (星期, [from, to)) 占用段；跨午夜拆成两段（次日头部）。 */
function expandRuleSegments(rule: TimePriorityRule, ruleIndex: number): WeekdaySegment[] {
  const startMinute = parseHHmmToMinutes(rule.start);
  const endMinute = parseHHmmToMinutes(rule.end);
  if (startMinute === null || endMinute === null || startMinute === endMinute) return [];

  const segments: WeekdaySegment[] = [];
  for (const weekday of rule.days) {
    if (startMinute < endMinute) {
      segments.push({ weekday, from: startMinute, to: endMinute, ruleIndex });
    } else {
      segments.push({ weekday, from: startMinute, to: MINUTES_PER_DAY, ruleIndex });
      segments.push({ weekday: (weekday + 1) % 7, from: 0, to: endMinute, ruleIndex });
    }
  }
  return segments;
}

export interface TimePriorityRuleOverlap {
  a: number;
  b: number;
}

/**
 * 检测规则间的时段重叠（含跨午夜溢出到次日的部分）。相邻区间（前者 end === 后者 start）不算重叠。
 * 返回相交的一对规则下标，无重叠返回 null。
 */
export function findTimePriorityRuleOverlap(rules: TimePriorityRule[]): TimePriorityRuleOverlap | null {
  const segmentsByWeekday = new Map<number, WeekdaySegment[]>();
  for (let ruleIndex = 0; ruleIndex < rules.length; ruleIndex++) {
    const rule = rules[ruleIndex];
    if (!rule || !Array.isArray(rule.days)) continue;
    for (const segment of expandRuleSegments(rule, ruleIndex)) {
      const daySegments = segmentsByWeekday.get(segment.weekday) ?? [];
      daySegments.push(segment);
      segmentsByWeekday.set(segment.weekday, daySegments);
    }
  }

  for (const daySegments of segmentsByWeekday.values()) {
    daySegments.sort((left, right) => left.from - right.from || left.to - right.to);
    for (let i = 1; i < daySegments.length; i++) {
      const previous = daySegments[i - 1]!;
      const current = daySegments[i]!;
      if (current.from < previous.to) {
        return { a: previous.ruleIndex, b: current.ruleIndex };
      }
    }
  }
  return null;
}

export const timePriorityRuleSchema = z
  .object({
    days: z
      .array(z.number().int().min(0).max(6))
      .min(1)
      .refine((days) => new Set(days).size === days.length, {
        message: "days 内的星期不能重复（0=周日..6=周六）",
      }),
    start: z.string().regex(HHMM_START_PATTERN, {
      message: "start 必须是 HH:mm 格式（00:00–23:59）",
    }),
    end: z.string().regex(HHMM_END_PATTERN, {
      message: "end 必须是 HH:mm 格式（00:00–23:59，或 24:00 表示当天收尾）",
    }),
    target_order: z.array(z.number().int()).min(1),
  })
  .strict();

/**
 * time_priority 路由配置整体契约校验。strategy/targets 内未知字段视为配置错误
 * （typo 如 targetOrder 会被静默忽略进而产生错误路由，宁拒勿猜）。
 */
export const timePriorityRoutingConfigSchema = z
  .object({
    strategy: z
      .object({
        mode: z.literal(TIME_PRIORITY_ROUTING_MODE),
        timezone: z.string().refine(isValidIANATimezone, {
          message: "timezone 必须是有效的 IANA 时区（如 Asia/Shanghai）",
        }),
        time_rules: z.array(timePriorityRuleSchema).min(1),
      })
      .strict(),
    targets: z.array(z.object({ provider: z.string().min(1) }).passthrough()).min(1),
  })
  .superRefine((config, ctx) => {
    const targetCount = config.targets.length;

    config.strategy.time_rules.forEach((rule, index) => {
      const rulePath = ["strategy", "time_rules", index];
      const startMinute = parseHHmmToMinutes(rule.start);
      const endMinute = parseHHmmToMinutes(rule.end);
      if (startMinute === null || endMinute === null || startMinute === endMinute) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [...rulePath, "start"],
          message: "start 与 end 不能相同（左闭右开区间为空）",
        });
      }
      if (!isTimePriorityTargetOrder(rule.target_order, targetCount)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [...rulePath, "target_order"],
          message: `target_order 必须是 targets 索引 0..${targetCount - 1} 的全排列`,
        });
      }
    });

    const overlap = findTimePriorityRuleOverlap(config.strategy.time_rules);
    if (overlap) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["strategy", "time_rules", overlap.b],
        message: `time_rules 存在时段重叠：规则 #${overlap.a} 与规则 #${overlap.b} 在同一星期的占用区间相交（跨午夜规则占用次日区间）`,
      });
    }
  });

export type TimePriorityRoutingConfig = z.infer<typeof timePriorityRoutingConfigSchema>;
