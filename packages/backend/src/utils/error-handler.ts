import { FastifyReply } from 'fastify';
import { memoryLogger } from '../services/logger.js';

export interface ApiError {
  success: false;
  message: string;
  code?: string;
  statusCode?: number;
}

export interface ApiSuccess<T = any> {
  success: true;
  data?: T;
  message?: string;
}

export type ApiResponse<T = any> = ApiSuccess<T> | ApiError;

export function handleError(
  error: any,
  reply: FastifyReply,
  context: string,
  defaultMessage: string = '操作失败'
): ApiError {
  const message = error.message || defaultMessage;
  const statusCode = error.statusCode || 500;

  memoryLogger.error(`${context}: ${message}`, context, {
    error: error.stack,
    statusCode,
  });

  const response: ApiError = {
    success: false,
    message,
    code: error.code,
    statusCode,
  };

  reply.code(statusCode).send(response);
  return response;
}

export function createSuccessResponse<T>(data?: T, message?: string): ApiSuccess<T> {
  return {
    success: true,
    data,
    message,
  };
}

export function createErrorResponse(message: string, code?: string, statusCode: number = 500): ApiError {
  return {
    success: false,
    message,
    code,
    statusCode,
  };
}

export class AppError extends Error {
  constructor(
    message: string,
    public statusCode: number = 500,
    public code?: string
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export class NotFoundError extends AppError {
  constructor(message: string = '资源不存在') {
    super(message, 404, 'NOT_FOUND');
  }
}

export class ValidationError extends AppError {
  constructor(message: string = '参数验证失败') {
    super(message, 400, 'VALIDATION_ERROR');
  }
}

export class UnauthorizedError extends AppError {
  constructor(message: string = '未授权') {
    super(message, 401, 'UNAUTHORIZED');
  }
}

export async function withErrorHandling<T>(
  fn: () => Promise<T>,
  context: string,
  defaultMessage?: string
): Promise<ApiResponse<T>> {
  try {
    const result = await fn();
    return createSuccessResponse(result);
  } catch (error: any) {
    memoryLogger.error(`${context}: ${error.message}`, context, {
      error: error.stack,
    });
    return createErrorResponse(
      error.message || defaultMessage || '操作失败',
      error.code,
      error.statusCode || 500
    );
  }
}

