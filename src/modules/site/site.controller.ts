import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Query, Res, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsInt, IsObject, IsOptional, IsString, Matches, Max, MaxLength, Min, ValidateIf, ValidateNested } from 'class-validator';
import type { AuthUser } from '../../common/auth-types.js';
import { AnyPermission, ClientIp, CurrentUser, Public, RequirePermission } from '../../common/decorators/index.js';
import { RequireFeature } from '../entitlements/entitlements.decorators.js';
import { SiteAssetsService } from './site-assets.service.js';
import { ThemeService, type ThemeScope } from './theme.service.js';
import { FONT_PAIRINGS, TEMPLATES } from './site.registry.js';

const HEX = /^#[0-9a-fA-F]{6}$/;
const nullable = () => ValidateIf((_o, v) => v !== null);

export class ScopeQueryDto {
  @IsOptional() @IsIn(['PROPERTY', 'GROUP']) scope?: ThemeScope;
}

export class ThemeBrandDto {
  @IsOptional() @nullable() @IsString() @MaxLength(36) logoAssetId?: string | null;
  @IsOptional() @nullable() @IsString() @MaxLength(36) faviconAssetId?: string | null;
  @IsOptional() @nullable() @IsString() @MaxLength(500) logoUrl?: string | null;
  @IsOptional() @Matches(HEX, { message: 'primary must be #RRGGBB' }) primary?: string;
  @IsOptional() @nullable() @Matches(HEX, { message: 'secondary must be #RRGGBB' }) secondary?: string | null;
  @IsOptional() @nullable() @IsString() @MaxLength(40) fontPairingId?: string | null;
}

export class ThemeDraftDto {
  @IsOptional() @IsString() @MaxLength(20) templateId?: string;
  @IsOptional() @IsBoolean() resetSections?: boolean;
  @IsOptional() @ValidateNested() @Type(() => ThemeBrandDto) brand?: ThemeBrandDto;
  @IsOptional() @IsIn(['LIGHT', 'DARK', 'SYSTEM']) colourMode?: 'LIGHT' | 'DARK' | 'SYSTEM';
  @IsOptional() @IsArray() @ArrayMaxSize(24) @IsObject({ each: true }) sections?: Record<string, unknown>[];
}

export class PublishDto {
  @IsOptional() @IsString() @MaxLength(200) note?: string;
}

export class ContrastDto {
  @Matches(HEX, { message: 'primary must be #RRGGBB' }) primary!: string;
  @IsOptional() @nullable() @Matches(HEX, { message: 'secondary must be #RRGGBB' }) secondary?: string | null;
}

export class PreviewTokenDto {
  @IsOptional() @IsIn(['PROPERTY', 'GROUP']) scope?: ThemeScope;
  @IsOptional() @IsArray() @IsIn(['THEME', 'FORM'], { each: true }) kinds?: ('THEME' | 'FORM')[];
  @IsOptional() @IsInt() @Min(5) @Max(120) ttlMinutes?: number;
}

export class AssetListQueryDto {
  @IsOptional() @IsIn(['logo', 'favicon', 'image']) kind?: string;
}

@ApiTags('Brand Studio')
@ApiBearerAuth()
@Controller('site')
export class SiteController {
  constructor(
    private readonly themes: ThemeService,
    private readonly assets: SiteAssetsService,
  ) {}

  @Get('templates')
  @ApiOperation({ summary: 'Booking-site template registry' })
  templates() {
    return TEMPLATES;
  }

  @Get('font-pairings')
  fontPairings() {
    return FONT_PAIRINGS;
  }

  @Get('gates')
  @ApiOperation({ summary: 'Plan gates and limits for the Brand Studio and the form builder' })
  gates(@CurrentUser() u: AuthUser) {
    return this.themes.gatesFor(u);
  }

  @Get('theme') @RequirePermission('site.manage')
  theme(@CurrentUser() u: AuthUser, @Query() q: ScopeQueryDto) {
    return this.themes.state(u, q.scope);
  }

  @Put('theme/draft') @RequirePermission('site.manage') @RequireFeature('brand_kit')
  draft(@CurrentUser() u: AuthUser, @Query() q: ScopeQueryDto, @Body() dto: ThemeDraftDto, @ClientIp() ip?: string) {
    return this.themes.updateDraft(u, q.scope, dto as never, ip);
  }

  @Post('theme/publish') @RequirePermission('site.manage') @RequireFeature('brand_kit') @HttpCode(200)
  publish(@CurrentUser() u: AuthUser, @Query() q: ScopeQueryDto, @Body() dto: PublishDto, @ClientIp() ip?: string) {
    return this.themes.publish(u, q.scope, dto.note, ip);
  }

  @Post('theme/discard') @RequirePermission('site.manage') @HttpCode(200)
  discard(@CurrentUser() u: AuthUser, @Query() q: ScopeQueryDto) {
    return this.themes.discard(u, q.scope);
  }

  @Get('theme/versions') @RequirePermission('site.manage')
  versions(@CurrentUser() u: AuthUser, @Query() q: ScopeQueryDto) {
    return this.themes.versions(u, q.scope);
  }

  @Get('theme/versions/:id') @RequirePermission('site.manage')
  version(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.themes.version(u, id);
  }

  @Post('theme/versions/:id/revert') @RequirePermission('site.manage') @RequireFeature('brand_kit') @HttpCode(200)
  revert(@CurrentUser() u: AuthUser, @Query() q: ScopeQueryDto, @Param('id', ParseUUIDPipe) id: string, @Body() dto: PublishDto, @ClientIp() ip?: string) {
    return this.themes.revert(u, q.scope, id, dto.note, ip);
  }

  @Post('theme/contrast') @HttpCode(200)
  @ApiOperation({ summary: 'Accessible light and dark variants of a colour pair (nothing saved)' })
  contrast(@Body() dto: ContrastDto) {
    return this.themes.contrast(dto.primary, dto.secondary ?? null);
  }

  @Get('assets') @RequirePermission('site.manage')
  listAssets(@CurrentUser() u: AuthUser, @Query() q: AssetListQueryDto) {
    return this.assets.list(u, q.kind);
  }

  @Post('assets') @RequirePermission('site.manage') @RequireFeature('brand_kit')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 5 * 1024 * 1024, files: 1 } }))
  upload(@CurrentUser() u: AuthUser, @UploadedFile() file: { buffer: Buffer; size: number; originalname?: string } | undefined, @Body('kind') kind: string, @ClientIp() ip?: string) {
    return this.assets.upload(u, kind, file, ip);
  }

  @Delete('assets/:id') @RequirePermission('site.manage')
  removeAsset(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @ClientIp() ip?: string) {
    return this.assets.remove(u, id, ip);
  }

  @Post('preview-token') @AnyPermission('site.manage', 'forms.manage') @HttpCode(200)
  previewToken(@CurrentUser() u: AuthUser, @Body() dto: PreviewTokenDto) {
    return this.themes.previewToken(u, dto);
  }
}

@ApiTags('Public')
@Public()
@Controller('public/site-assets')
export class PublicSiteAssetsController {
  constructor(private readonly assets: SiteAssetsService) {}

  @Get(':tenantId/:file')
  async get(@Param('tenantId') tenantId: string, @Param('file') file: string, @Res() res: Response) {
    const o = await this.assets.read(tenantId, file);
    res.setHeader('Content-Type', o.contentType ?? 'application/octet-stream');
    res.setHeader('Cache-Control', 'public, max-age=86400, immutable');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'");
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.send(o.body);
  }
}
