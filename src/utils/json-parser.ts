export interface ParseResult<T> {
  success: boolean;
  data?: T;
  error?: string;
}

export class JsonParser {
  static safeParse<T = any>(jsonString: string | null | undefined): ParseResult<T> {
    if (!jsonString) {
      return {
        success: true,
        data: undefined,
      };
    }

    if (typeof jsonString !== 'string') {
      return {
        success: false,
        error: 'Input must be a string',
      };
    }

    const trimmed = jsonString.trim();
    if (!trimmed) {
      return {
        success: true,
        data: undefined,
      };
    }

    try {
      const parsed = JSON.parse(trimmed);
      return {
        success: true,
        data: parsed,
      };
    } catch (error: any) {
      return {
        success: false,
        error: `JSON parse error: ${error.message}`,
      };
    }
  }

  static parseOrDefault<T>(jsonString: string | null | undefined, defaultValue: T): T {
    const result = this.safeParse<T>(jsonString);
    return result.success && result.data !== undefined ? result.data : defaultValue;
  }

  static parseOrNull<T>(jsonString: string | null | undefined): T | null {
    const result = this.safeParse<T>(jsonString);
    return result.success && result.data !== undefined ? result.data : null;
  }

  static safeStringify(value: any, defaultValue: string = '{}'): string {
    if (value === null || value === undefined) {
      return defaultValue;
    }

    try {
      return JSON.stringify(value);
    } catch (error: any) {
      return defaultValue;
    }
  }
}

