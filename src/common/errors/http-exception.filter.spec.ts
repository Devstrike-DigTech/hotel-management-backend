import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client.js';
import { AppException } from './app-exception.js';
import { GlobalExceptionFilter } from './http-exception.filter.js';

describe('GlobalExceptionFilter.toEnvelope', () => {
  const filter = new GlobalExceptionFilter();

  it('passes AppException through with details', () => {
    const e = new AppException(403, 'FEATURE_LOCKED', 'locked', { feature: 'pos', requiredPlan: 'pro' });
    expect(filter.toEnvelope(e)).toEqual({
      statusCode: 403,
      code: 'FEATURE_LOCKED',
      message: 'locked',
      details: { feature: 'pos', requiredPlan: 'pro' },
    });
  });

  it('omits details when absent', () => {
    expect(filter.toEnvelope(AppException.notFound('Room'))).toEqual({
      statusCode: 404,
      code: 'NOT_FOUND',
      message: 'Room not found',
    });
  });

  it('maps framework HttpExceptions to default codes', () => {
    expect(filter.toEnvelope(new NotFoundException('Cannot GET /x'))).toMatchObject({ statusCode: 404, code: 'NOT_FOUND' });
    expect(filter.toEnvelope(new BadRequestException(['a', 'b']))).toMatchObject({ statusCode: 400, message: 'a; b' });
  });

  it('maps Prisma unique violations to 409 CONFLICT', () => {
    const e = new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: 'x' });
    expect(filter.toEnvelope(e)).toMatchObject({ statusCode: 409, code: 'CONFLICT' });
  });

  it('hides unknown errors behind a 500 INTERNAL_ERROR', () => {
    expect(filter.toEnvelope(new Error('secret stack'))).toEqual({
      statusCode: 500,
      code: 'INTERNAL_ERROR',
      message: 'Something went wrong on our side',
    });
  });
});
