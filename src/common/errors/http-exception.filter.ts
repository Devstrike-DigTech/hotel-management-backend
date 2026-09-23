import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Response } from 'express';
import { Prisma } from '../../generated/prisma/client.js';
import { AppException, ErrorCode, type ErrorEnvelope } from './app-exception.js';

const DEFAULT_CODES: Record<number, string> = {
  400: ErrorCode.BAD_REQUEST,
  401: ErrorCode.UNAUTHORIZED,
  402: ErrorCode.SUBSCRIPTION_READ_ONLY,
  403: ErrorCode.FORBIDDEN,
  404: ErrorCode.NOT_FOUND,
  409: ErrorCode.CONFLICT,
  413: 'PAYLOAD_TOO_LARGE',
  429: ErrorCode.RATE_LIMITED,
};

/**
 * Turns every thrown error into the API error envelope
 * `{ statusCode, code, message, details? }`.
 */
@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('ExceptionFilter');

  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    const envelope = this.toEnvelope(exception);
    if (envelope.statusCode >= 500) {
      this.logger.error(
        exception instanceof Error ? exception.stack : String(exception),
      );
    }
    res.status(envelope.statusCode).json(envelope);
  }

  toEnvelope(exception: unknown): ErrorEnvelope {
    if (exception instanceof AppException) {
      return strip({
        statusCode: exception.getStatus(),
        code: exception.code,
        message: exception.message,
        details: exception.details,
      });
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();
      let message = exception.message;
      if (typeof body === 'object' && body !== null && 'message' in body) {
        const m = (body as { message: unknown }).message;
        message = Array.isArray(m) ? m.join('; ') : String(m);
      }
      return {
        statusCode: status,
        code: DEFAULT_CODES[status] ?? (status >= 500 ? ErrorCode.INTERNAL_ERROR : ErrorCode.BAD_REQUEST),
        message,
      };
    }

    if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      if (exception.code === 'P2002') {
        return {
          statusCode: HttpStatus.CONFLICT,
          code: ErrorCode.CONFLICT,
          message: 'A record with these details already exists',
          details: { target: exception.meta?.target },
        };
      }
      if (exception.code === 'P2025') {
        return {
          statusCode: HttpStatus.NOT_FOUND,
          code: ErrorCode.NOT_FOUND,
          message: 'Resource not found',
        };
      }
      if (exception.code === 'P2003') {
        return {
          statusCode: HttpStatus.CONFLICT,
          code: ErrorCode.CONFLICT,
          message: 'This record is referenced by other records',
        };
      }
    }

    return {
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      code: ErrorCode.INTERNAL_ERROR,
      message: 'Something went wrong on our side',
    };
  }
}

function strip(e: ErrorEnvelope): ErrorEnvelope {
  if (e.details === undefined) {
    const { details: _omit, ...rest } = e;
    return rest;
  }
  return e;
}
