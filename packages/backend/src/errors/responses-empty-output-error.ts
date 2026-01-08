export interface ResponsesEmptyOutputDetails {
  attempt?: number;
  totalAttempts?: number;
  status?: string;
  lastEventType?: string;
  responseId?: string;
}

export class ResponsesEmptyOutputError extends Error {
  public readonly code = 'responses_empty_output';
  public readonly statusCode = 502;
  public readonly status = 502;
  public readonly details?: ResponsesEmptyOutputDetails;

  constructor(message: string, details?: ResponsesEmptyOutputDetails) {
    super(message);
    this.name = 'ResponsesEmptyOutputError';
    this.details = details;
  }
}
