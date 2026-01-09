export interface EmptyOutputDetails {
  source: 'gemini' | 'responses' | 'claude';
  attempt?: number;
  totalAttempts?: number;
  status?: string;
  lastEventType?: string;
  responseId?: string;
}

export class EmptyOutputError extends Error {
  public readonly code: string;
  public readonly statusCode = 502;
  public readonly status = 502;
  public readonly details?: EmptyOutputDetails;

  constructor(message: string, details?: EmptyOutputDetails) {
    super(message);
    this.name = 'EmptyOutputError';
    this.details = details;
    if (details?.source === 'gemini') {
      this.code = 'gemini_empty_output';
    } else if (details?.source === 'claude') {
      this.code = 'claude_empty_output';
    } else {
      this.code = 'responses_empty_output';
    }
  }
}