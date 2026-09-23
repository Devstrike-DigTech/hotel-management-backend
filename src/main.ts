import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module.js';
import { AppConfigService } from './config/app-config.service.js';
import { setupApp } from './setup-app.js';

async function bootstrap() {
  // rawBody is needed to verify Paystack webhook signatures byte-for-byte.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    rawBody: true,
    bufferLogs: false,
  });
  setupApp(app);
  const config = app.get(AppConfigService);
  const port = config.get('PORT');
  await app.listen(port);
  Logger.log(
    `${config.get('APP_NAME')} API listening on http://localhost:${port}/api/v1 (docs at /docs)`,
    'Bootstrap',
  );
}
await bootstrap();
