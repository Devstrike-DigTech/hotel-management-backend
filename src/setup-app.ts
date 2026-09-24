import { RequestMethod, type INestApplication } from '@nestjs/common';
import type { Request } from 'express';
import type { CorsOptions } from '@nestjs/common/interfaces/external/cors-options.interface.js';
import { allowedOrigins, surfaceMiddleware, surfaceOf } from './common/http/surfaces.js';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import type { NestExpressApplication } from '@nestjs/platform-express';
import helmet from 'helmet';
import { GlobalExceptionFilter } from './common/errors/http-exception.filter.js';
import { createValidationPipe } from './common/errors/validation.js';
import { AppConfigService } from './config/app-config.service.js';

export const API_PREFIX = 'api/v1';
/** M6: the partner API lives outside the app prefix. */
export const PARTNER_PREFIX = 'api/partner/v1';

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
  const hotelOrigins = config.get('CORS_ORIGINS');
  const platformOrigins = config.get('PLATFORM_ORIGINS');
  // M6: X-Request-Id and the origin firewall between the hotel apps and the platform console.
  app.use(surfaceMiddleware(hotelOrigins, platformOrigins));
  app.setGlobalPrefix(API_PREFIX, { exclude: [{ path: `${PARTNER_PREFIX}/{*path}`, method: RequestMethod.ALL }] });
  // CORS per surface: platform routes answer only PLATFORM_ORIGINS, hotel
  // routes only CORS_ORIGINS, public routes both, the partner API none.
  app.enableCors((req: Request, cb: (err: Error | null, options: CorsOptions) => void) => {
    const allowed = allowedOrigins(surfaceOf(req.path), hotelOrigins, platformOrigins);
    const origin = req.headers.origin;
    cb(null, {
      origin: origin && allowed.includes(origin) ? origin : false,
      credentials: true,
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization', 'Idempotency-Key', 'X-Property-Id', 'X-Request-Id'],
      exposedHeaders: ['Idempotent-Replayed', 'Content-Disposition', 'X-Property-Id', 'X-Server-Time', 'X-Next-Cursor', 'X-Request-Id'],
      maxAge: 600,
    });
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
