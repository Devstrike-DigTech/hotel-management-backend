import type { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import type { NestExpressApplication } from '@nestjs/platform-express';
import helmet from 'helmet';
import { GlobalExceptionFilter } from './common/errors/http-exception.filter.js';
import { createValidationPipe } from './common/errors/validation.js';
import { AppConfigService } from './config/app-config.service.js';

export const API_PREFIX = 'api/v1';

/**
 * Applies the HTTP-level configuration shared by `main.ts` and the e2e tests:
 * prefix, CORS, security headers, validation, error envelope and Swagger.
 */
export function setupApp(app: INestApplication): void {
  const config = app.get(AppConfigService);
  const express = app as NestExpressApplication;

  express.set('trust proxy', 1);
  express.disable('x-powered-by');
  app.use(helmet({ contentSecurityPolicy: false }));
  app.setGlobalPrefix(API_PREFIX);
  app.enableCors({
    origin: config.get('CORS_ORIGINS'),
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    maxAge: 600,
  });
  app.useGlobalPipes(createValidationPipe());
  app.useGlobalFilters(new GlobalExceptionFilter());
  app.enableShutdownHooks();

  if (config.get('SWAGGER_ENABLED')) {
    const doc = new DocumentBuilder()
      .setTitle(`${config.get('APP_NAME')} API`)
      .setDescription(
        'Multi-tenant hotel management API. Errors use the envelope ' +
          '{ statusCode, code, message, details? }. Money is integer kobo.',
      )
      .setVersion('1.0')
      .addBearerAuth()
      .build();
    SwaggerModule.setup('docs', app, SwaggerModule.createDocument(app, doc), {
      jsonDocumentUrl: 'docs/json',
    });
  }
}
