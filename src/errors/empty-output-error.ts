export interface EmptyOutputDetails {
  source: 'gemini' | 'responses';
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
    this.code = details?.source === 'gemini' ? 'gemini_empty_output' : 'responses_empty_output';
  }
}