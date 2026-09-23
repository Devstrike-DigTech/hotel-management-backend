import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiConsumes, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import type { AuthUser } from '../../common/auth-types.js';
import { ClientIp, CurrentUser, Public, RequirePermission } from '../../common/decorators/index.js';
import { RequireFeature } from '../entitlements/entitlements.decorators.js';
import { ReservationsService } from '../reservations/reservations.service.js';
import {
  AnonymiseDto,
  GuestInputDto,
  GuestLookupDto,
  GuestQueryDto,
  GuestUpdateDto,
  RegisterQueryDto,
} from './guests.dto.js';
import { GuestsService, MAX_ID_IMAGE_BYTES, type UploadedFileLike } from './guests.service.js';

@ApiTags('Guests')
@ApiBearerAuth()
@RequireFeature('guest_register')
@Controller('guests')
export class GuestsController {
  constructor(
    private readonly guests: GuestsService,
    private readonly reservations: ReservationsService,
  ) {}

  @Get()
  @RequirePermission('guests.view')
  list(@CurrentUser() user: AuthUser, @Query() q: GuestQueryDto) {
    return this.guests.list(user, q);
  }

  @Get('lookup')
  @RequirePermission('guests.view')
  lookup(@CurrentUser() user: AuthUser, @Query() q: GuestLookupDto) {
    return this.guests.lookup(user, q.phone);
  }

  @Post()
  @RequirePermission('guests.edit')
  create(@CurrentUser() user: AuthUser, @Body() dto: GuestInputDto, @ClientIp() ip?: string) {
    return this.guests.create(user, dto, ip);
  }

  @Get(':id')
  @RequirePermission('guests.view')
  async get(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.reservations.guestWithStays(user, id);
  }

  @Patch(':id')
  @RequirePermission('guests.edit')
  update(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: GuestUpdateDto, @ClientIp() ip?: string) {
    return this.guests.update(user, id, dto, ip);
  }

  @Get(':id/id-document')
  @RequirePermission('guests.reveal_id')
  @ApiOperation({ summary: 'Reveal the full ID number and a 10-minute image URL (audited)' })
  reveal(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @ClientIp() ip?: string) {
    return this.guests.revealId(user, id, ip);
  }

  @Post(':id/id-image')
  @HttpCode(200)
  @RequirePermission('guests.edit')
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_ID_IMAGE_BYTES, files: 1 } }))
  upload(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @UploadedFile() file: UploadedFileLike | undefined,
    @ClientIp() ip?: string,
  ) {
    return this.guests.uploadIdImage(user, id, file, ip);
  }

  @Delete(':id/id-image')
  @RequirePermission('guests.anonymise')
  deleteImage(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @ClientIp() ip?: string) {
    return this.guests.deleteIdImage(user, id, ip);
  }

  @Get(':id/export')
  @RequirePermission('guests.export')
  @ApiOperation({ summary: 'NDPA data export (audited)' })
  export(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @ClientIp() ip?: string) {
    return this.guests.exportData(user, id, ip);
  }

  @Post(':id/anonymise')
  @HttpCode(200)
  @RequirePermission('guests.anonymise')
  @ApiOperation({ summary: 'NDPA erasure: wipe personal data, keep financial records (irreversible, audited)' })
  anonymise(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: AnonymiseDto, @ClientIp() ip?: string) {
    return this.guests.anonymise(user, id, dto.reason, ip);
  }
}

@ApiTags('Guests')
@ApiBearerAuth()
@RequireFeature('guest_register')
@Controller('guest-register')
export class GuestRegisterController {
  constructor(private readonly guests: GuestsService) {}

  @Get()
  @RequirePermission('frontdesk.checkin')
  @ApiOperation({ summary: 'Guest register (police / security book) as JSON or CSV' })
  async register(
    @CurrentUser() user: AuthUser,
    @Query() q: RegisterQueryDto,
    @Res({ passthrough: true }) res: Response,
    @ClientIp() ip?: string,
  ) {
    const data = await this.guests.register(user, q, ip);
    if (q.format === 'csv') {
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="guest-register-${q.from}-to-${q.to}.csv"`);
      res.setHeader('Cache-Control', 'no-store');
      return GuestsService.toCsv(data.items as unknown as Record<string, unknown>[]);
    }
    return data;
  }
}

@ApiTags('Public')
@Public()
@Controller('files')
export class FilesController {
  constructor(private readonly guests: GuestsService) {}

  /** Serves an uploaded file from a signed, short-lived token. */
  @Get(':token')
  async get(@Param('token') token: string, @Res() res: Response) {
    const obj = await this.guests.readFile(token);
    res.setHeader('Content-Type', obj.contentType ?? 'application/octet-stream');
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Disposition', 'inline');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.send(obj.body);
  }
}
