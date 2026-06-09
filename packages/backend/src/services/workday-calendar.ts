import { memoryLogger } from './logger.js';

type HolidaysInstance = {
  isHoliday(date: Date): false | any[];
};

type HolidaysConstructor = new (country?: string) => HolidaysInstance & {
  getCountries(language?: string): Record<string, string> | undefined;
};

// Cached loaded modules (async-initialized, sync-accessed)
let chineseWorkdayModule: { isWorkday: (input: Date) => boolean | null | undefined } | null = null;
let HolidaysClass: HolidaysConstructor | null = null;
const holidaysCache = new Map<string, HolidaysInstance>();

async function ensureChineseWorkday(): Promise<void> {
  if (chineseWorkdayModule) return;
  try {
    chineseWorkdayModule = await import('chinese-workday') as any;
  } catch (error: any) {
    memoryLogger.warn(`WorkdayCalendarService: 无法加载 chinese-workday: ${error?.message}`, 'WorkdayCalendar');
  }
}

async function ensureDateHolidays(): Promise<void> {
  if (HolidaysClass) return;
  try {
    const mod = await import('date-holidays') as any;
    HolidaysClass = mod.default ?? mod;
  } catch (error: any) {
    memoryLogger.warn(`WorkdayCalendarService: 无法加载 date-holidays: ${error?.message}`, 'WorkdayCalendar');
  }
}

function isWeekday(date: Date): boolean {
  const day = date.getDay();
  return day >= 1 && day <= 5;
}

function getHolidaysInstance(country: string): HolidaysInstance | null {
  if (holidaysCache.has(country)) {
    return holidaysCache.get(country)!;
  }
  if (!HolidaysClass) return null;
  try {
    const hd = new HolidaysClass(country);
    holidaysCache.set(country, hd);
    return hd;
  } catch (error: any) {
    memoryLogger.warn(`WorkdayCalendarService: 无法初始化 date-holidays for ${country}: ${error?.message}`, 'WorkdayCalendar');
    return null;
  }
}

export const workdayCalendarService = {
  /**
   * Pre-loads holiday modules. Call once at service startup before isWorkday is used.
   */
  async initialize(): Promise<void> {
    await Promise.all([ensureChineseWorkday(), ensureDateHolidays()]);
  },

  isWorkday(timestampMs: number, region: string | null): boolean {
    const date = new Date(timestampMs);

    if (!region) {
      return isWeekday(date);
    }

    if (region === 'CN') {
      if (chineseWorkdayModule) {
        try {
          const result = chineseWorkdayModule.isWorkday(date);
          if (result === undefined || result === null) {
            throw new Error('chinese-workday returned undefined');
          }
          return result;
        } catch (error: any) {
          memoryLogger.warn(`WorkdayCalendarService: chinese-workday 出错，降级为 date-holidays CN: ${error?.message}`, 'WorkdayCalendar');
        }
      }
      // Fallback to date-holidays CN
      const hd = getHolidaysInstance('CN');
      if (!hd) return isWeekday(date);
      const holidays = hd.isHoliday(date);
      return !holidays && isWeekday(date);
    }

    try {
      const hd = getHolidaysInstance(region);
      if (!hd) {
        memoryLogger.warn(`WorkdayCalendarService: 无法获取 ${region} 节假日实例，降级为纯周末判断`, 'WorkdayCalendar');
        return isWeekday(date);
      }
      const holidays = hd.isHoliday(date);
      return !holidays && isWeekday(date);
    } catch (error: any) {
      memoryLogger.warn(`WorkdayCalendarService: ${region} 节假日判断出错，降级为纯周末判断: ${error?.message}`, 'WorkdayCalendar');
      return isWeekday(date);
    }
  },

  getCountries(): { code: string; name: string }[] {
    if (!HolidaysClass) return [];
    try {
      const hd = new HolidaysClass();
      const countries = hd.getCountries('en');
      if (!countries) return [];
      return Object.entries(countries as Record<string, string>).map(([code, name]) => ({ code, name }));
    } catch (error: any) {
      memoryLogger.warn(`WorkdayCalendarService: 获取国家列表失败: ${error?.message}`, 'WorkdayCalendar');
      return [];
    }
  },
};
