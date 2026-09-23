import { HttpStatus, ValidationError, ValidationPipe } from '@nestjs/common';
import { AppException, ErrorCode } from './app-exception.js';

function flatten(
  errors: ValidationError[],
  prefix = '',
  out: Record<string, string[]> = {},
): Record<string, string[]> {
  for (const err of errors) {
    const path = prefix ? `${prefix}.${err.property}` : err.property;
    if (err.constraints) {
      out[path] = Object.values(err.constraints);
    }
    if (err.children?.length) {
      flatten(err.children, path, out);
    }
  }
  return out;
}

export function createValidationPipe(): ValidationPipe {
  return new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
    transformOptions: { enableImplicitConversion: false },
    exceptionFactory: (errors) => {
      const fields = flatten(errors);
      const first = Object.values(fields)[0]?.[0] ?? 'Invalid request';
      return new AppException(
        HttpStatus.BAD_REQUEST,
        ErrorCode.VALIDATION_ERROR,
        first,
        { fields },
      );
    },
  });
}
