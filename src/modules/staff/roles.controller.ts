import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ArrayMaxSize, IsArray, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import type { AuthUser } from '../../common/auth-types.js';
import { ClientIp, CurrentUser, GroupWide, RequirePermission } from '../../common/decorators/index.js';
import { RolesService } from './roles.service.js';

export class CreateRoleDto {
  @IsString() @MinLength(2) @MaxLength(60) name!: string;
  @IsOptional() @IsString() @MaxLength(300) description?: string;
  @IsOptional() @IsArray() @ArrayMaxSize(200) @IsString({ each: true }) permissions?: string[];
  @IsOptional() @IsString() @MaxLength(60) cloneFrom?: string;
}

export class UpdateRoleDto {
  @IsOptional() @IsString() @MinLength(2) @MaxLength(60) name?: string;
  @IsOptional() @IsString() @MaxLength(300) description?: string;
  @IsOptional() @IsArray() @ArrayMaxSize(200) @IsString({ each: true }) permissions?: string[];
}

@ApiTags('Staff')
@ApiBearerAuth()
@GroupWide()
@Controller()
export class RolesController {
  constructor(private readonly roles: RolesService) {}

  @Get('permissions')
  @ApiOperation({ summary: 'Permission catalogue, grouped' })
  permissions() {
    return this.roles.catalogue();
  }

  @Get('roles')
  @RequirePermission('staff.manage')
  list(@CurrentUser() user: AuthUser) {
    return this.roles.list(user);
  }

  @Get('roles/:id')
  @RequirePermission('staff.manage')
  get(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.roles.get(user, id);
  }

  @Post('roles')
  @RequirePermission('staff.manage')
  @ApiOperation({ summary: 'Create (or clone) a custom role (custom_roles)' })
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateRoleDto, @ClientIp() ip?: string) {
    return this.roles.create(user, dto, ip);
  }

  @Patch('roles/:id')
  @RequirePermission('staff.manage')
  update(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: UpdateRoleDto, @ClientIp() ip?: string) {
    return this.roles.update(user, id, dto, ip);
  }

  @Delete('roles/:id')
  @RequirePermission('staff.manage')
  remove(@CurrentUser() user: AuthUser, @Param('id') id: string, @ClientIp() ip?: string) {
    return this.roles.remove(user, id, ip);
  }
}
