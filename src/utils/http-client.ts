interface HttpRequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  headers?: Record<string, string>;
  body?: any;
  timeout?: number;
  retries?: number;
  retryDelay?: number;
}

interface HttpResponse<T = any> {
  ok: boolean;
  status: number;
  data?: T;
  error?: string;
}

export class HttpClient {
  private static async delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  private static shouldRetry(status: number, attempt: number, maxRetries: number): boolean {
    if (attempt >= maxRetries) {
      return false;
    }
    return status === 0 || status === 429 || (status >= 500 && status < 600);
  }

  static async request<T = any>(
    url: string,
    options: HttpRequestOptions = {}
  ): Promise<HttpResponse<T>> {
    const {
      method = 'GET',
      headers = {},
      body,
      timeout = 30000,
      retries = 2,
      retryDelay = 1000,
    } = options;

    let lastError: HttpResponse<T> | null = null;

    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const fetchOptions: RequestInit = {
          method,
          headers: {
            'Content-Type': 'application/json',
            ...headers,
          },
          signal: AbortSignal.timeout(timeout),
        };

        if (body && method !== 'GET') {
          fetchOptions.body = JSON.stringify(body);
        }

        const response = await fetch(url, fetchOptions);

        if (!response.ok) {
          const errorText = await response.text();
          lastError = {
            ok: false,
            status: response.status,
            error: errorText,
          };

          if (this.shouldRetry(response.status, attempt, retries)) {
            await this.delay(retryDelay * (attempt + 1));
            continue;
          }

          return lastError;
        }

        const data = await response.json() as T;
        return {
          ok: true,
          status: response.status,
          data,
        };
      } catch (error: any) {
        lastError = {
          ok: false,
          status: 0,
          error: error.message || '请求失败',
        };

        if (this.shouldRetry(0, attempt, retries)) {
          await this.delay(retryDelay * (attempt + 1));
          continue;
        }

        return lastError;
      }
    }

    return lastError || {
      ok: false,
      status: 0,
      error: '请求失败',
    };
  }

  static async testProviderConnection(
    baseUrl: string,
    apiKey: string,
    timeout = 10000
  ): Promise<HttpResponse> {
    const endpoint = `${baseUrl}/models`;
    return this.request(endpoint, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
      },
      timeout,
    });
  }

  static async testModelCompletion(
    baseUrl: string,
    apiKey: string,
    modelIdentifier: string,
    timeout = 30000
  ): Promise<HttpResponse> {
    const endpoint = `${baseUrl}/chat/completions`;
    return this.request(endpoint, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
      },
      body: {
        model: modelIdentifier,
        messages: [{ role: 'user', content: '测试' }],
        max_tokens: 10,
        temperature: 0.1,
      },
      timeout,
    });
  }
}

