export interface GeminiEmptyOutputDetails {
  attempt?: number;
  totalAttempts?: number;
}

export class GeminiEmptyOutputError extends Error {
  public readonly code = 'gemini_empty_output';
  public readonly statusCode = 502;
  public readonly status = 502;
  public readonly details?: GeminiEmptyOutputDetails;

  constructor(message: string, details?: GeminiEmptyOutputDetails) {
    super(message);
    this.name = 'GeminiEmptyOutputError';
    this.details = details;
  }
}
