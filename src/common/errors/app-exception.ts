import { HttpException, HttpStatus } from '@nestjs/common';

/** Machine-readable error codes returned in the `code` field of the envelope. */
export const ErrorCode = {
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  BAD_REQUEST: 'BAD_REQUEST',
  UNAUTHORIZED: 'UNAUTHORIZED',
  INVALID_CREDENTIALS: 'INVALID_CREDENTIALS',
  INVALID_REFRESH_TOKEN: 'INVALID_REFRESH_TOKEN',
  REFRESH_TOKEN_REUSED: 'REFRESH_TOKEN_REUSED',
  FORBIDDEN: 'FORBIDDEN',
  FEATURE_LOCKED: 'FEATURE_LOCKED',
  LIMIT_REACHED: 'LIMIT_REACHED',
  SUBSCRIPTION_READ_ONLY: 'SUBSCRIPTION_READ_ONLY',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  EMAIL_TAKEN: 'EMAIL_TAKEN',
  INVALID_SIGNATURE: 'INVALID_SIGNATURE',
  PAYMENT_PROVIDER_ERROR: 'PAYMENT_PROVIDER_ERROR',
  RATE_LIMITED: 'RATE_LIMITED',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

export interface ErrorEnvelope {
  statusCode: number;
  code: string;
  message: string;
  details?: unknown;
}

/**
 * The single exception type services throw. It carries the exact envelope
 * the global filter will send.
 */
export class AppException extends HttpException {
  constructor(
    status: HttpStatus,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super({ statusCode: status, code, message, details }, status);
  }

  static notFound(what = 'Resource'): AppException {
    return new AppException(
      HttpStatus.NOT_FOUND,
      ErrorCode.NOT_FOUND,
      `${what} not found`,
    );
  }

  static conflict(message: string, details?: unknown): AppException {
    return new AppException(
      HttpStatus.CONFLICT,
      ErrorCode.CONFLICT,
      message,
      details,
    );
  }

  static badRequest(message: string, details?: unknown): AppException {
    return new AppException(
      HttpStatus.BAD_REQUEST,
      ErrorCode.BAD_REQUEST,
      message,
      details,
    );
  }

  static forbidden(message = 'You do not have access to this resource') {
    return new AppException(HttpStatus.FORBIDDEN, ErrorCode.FORBIDDEN, message);
  }

  static unauthorized(
    message = 'Authentication required',
    code: string = ErrorCode.UNAUTHORIZED,
  ): AppException {
    return new AppException(HttpStatus.UNAUTHORIZED, code, message);
  }
}
