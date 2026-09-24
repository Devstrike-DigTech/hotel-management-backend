import { Controller, Get } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { Public } from '../../../common/decorators/index.js';
import { AppConfigService } from '../../../config/app-config.service.js';
import { partnerOpenApi } from './openapi.js';

/** Public OpenAPI 3.1 document of the partner API (no key). */
@ApiExcludeController()
@Public()
@Controller('api/partner/v1')
export class PartnerDocsController {
  constructor(private readonly config: AppConfigService) {}

  @Get('openapi.json')
  openapi() {
    return partnerOpenApi(`${this.config.get('API_PUBLIC_URL').replace(/\/$/, '')}/api/partner/v1`);
  }
}
