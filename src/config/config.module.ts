import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppConfigService } from './app-config.service.js';
import { validateEnv } from './env.schema.js';

@Global()
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      // Tests take every value from their own config (never the developer's .env and its database).
      ignoreEnvFile: process.env.NODE_ENV === 'test',
      validate: validateEnv,
      // Only validated values: an empty optional variable must not reach the
      // code as "" through the process.env fallback of ConfigService#get.
      skipProcessEnv: true,
    }),
  ],
  providers: [AppConfigService],
  exports: [AppConfigService],
})
export class AppConfigModule {}
