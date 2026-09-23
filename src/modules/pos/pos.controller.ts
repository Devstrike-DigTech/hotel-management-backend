import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put, Query, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import type { AuthUser } from '../../common/auth-types.js';
import { AnyPermission, ClientIp, CurrentUser, RequirePermission } from '../../common/decorators/index.js';
import { RequireFeature } from '../entitlements/entitlements.decorators.js';
import {
  AddLinesDto,
  AdjustmentDto,
  AvailabilityDto,
  CancelOrderDto,
  CategoryDto,
  CountDto,
  CreateItemDto,
  CreateOrderDto,
  CreateOutletDto,
  InHouseQueryDto,
  ItemQueryDto,
  KdsQueryDto,
  KdsStatusDto,
  MenuQueryDto,
  MinibarConsumptionDto,
  MinibarParDto,
  MinibarParQueryDto,
  MovementsQueryDto,
  OrderDiscountDto,
  OrdersQueryDto,
  PriceRuleDto,
  PurchaseDto,
  RangeDto,
  SettleDto,
  SplitDto,
  StockItemDto,
  StockQueryDto,
  UpdateCategoryDto,
  UpdateItemDto,
  UpdateLineDto,
  UpdateOrderDto,
  UpdateOutletDto,
  UpdatePriceRuleDto,
  UpdateStockItemDto,
  VoidLineDto,
} from './pos.dto.js';
import { KdsService } from './kds.service.js';
import { MinibarService } from './minibar.service.js';
import { PosReportsService } from './pos-reports.service.js';
import { PosService } from './pos.service.js';
import { StockService } from './stock.service.js';
import { PaginationQueryDto } from '../../common/utils/pagination.dto.js';

@ApiTags('POS')
@ApiBearerAuth()
@RequireFeature('pos')
@Controller('pos')
export class PosController {
  constructor(
    private readonly pos: PosService,
    private readonly reports: PosReportsService,
    private readonly kds: KdsService,
  ) {}

  // Outlets
  @Get('outlets') @RequirePermission('pos.view')
  outlets(@CurrentUser() u: AuthUser) { return this.pos.listOutlets(u); }

  @Post('outlets') @RequirePermission('pos.manage')
  createOutlet(@CurrentUser() u: AuthUser, @Body() dto: CreateOutletDto, @ClientIp() ip?: string) { return this.pos.createOutlet(u, dto, ip); }

  @Patch('outlets/:id') @RequirePermission('pos.manage')
  updateOutlet(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateOutletDto, @ClientIp() ip?: string) { return this.pos.updateOutlet(u, id, dto, ip); }

  @Delete('outlets/:id') @RequirePermission('pos.manage')
  deleteOutlet(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @ClientIp() ip?: string) { return this.pos.deleteOutlet(u, id, ip); }

  // Categories
  @Get('categories') @RequirePermission('pos.view')
  categories(@CurrentUser() u: AuthUser) { return this.pos.listCategories(u); }

  @Post('categories') @RequirePermission('pos.manage')
  createCategory(@CurrentUser() u: AuthUser, @Body() dto: CategoryDto, @ClientIp() ip?: string) { return this.pos.createCategory(u, dto, ip); }

  @Patch('categories/:id') @RequirePermission('pos.manage')
  updateCategory(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateCategoryDto, @ClientIp() ip?: string) { return this.pos.updateCategory(u, id, dto, ip); }

  @Delete('categories/:id') @RequirePermission('pos.manage')
  deleteCategory(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @ClientIp() ip?: string) { return this.pos.deleteCategory(u, id, ip); }

  // Items
  @Get('items') @RequirePermission('pos.view')
  items(@CurrentUser() u: AuthUser, @Query() q: ItemQueryDto) { return this.pos.listItems(u, q); }

  @Post('items') @RequirePermission('pos.manage')
  createItem(@CurrentUser() u: AuthUser, @Body() dto: CreateItemDto, @ClientIp() ip?: string) { return this.pos.createItem(u, dto, ip); }

  @Patch('items/:id') @RequirePermission('pos.manage')
  updateItem(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateItemDto, @ClientIp() ip?: string) { return this.pos.updateItem(u, id, dto, ip); }

  @Patch('items/:id/availability') @RequirePermission('pos.order')
  @ApiOperation({ summary: 'Mark an item available or not (86 it) from the terminal' })
  availability(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: AvailabilityDto, @ClientIp() ip?: string) { return this.pos.setAvailability(u, id, dto.available, ip); }

  @Delete('items/:id') @RequirePermission('pos.manage')
  deleteItem(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @ClientIp() ip?: string) { return this.pos.deleteItem(u, id, ip); }

  // Happy hours
  @Get('price-rules') @RequirePermission('pos.view')
  rules(@CurrentUser() u: AuthUser) { return this.pos.listRules(u); }

  @Post('price-rules') @RequirePermission('pos.manage')
  createRule(@CurrentUser() u: AuthUser, @Body() dto: PriceRuleDto, @ClientIp() ip?: string) { return this.pos.createRule(u, dto, ip); }

  @Patch('price-rules/:id') @RequirePermission('pos.manage')
  updateRule(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdatePriceRuleDto, @ClientIp() ip?: string) { return this.pos.updateRule(u, id, dto, ip); }

  @Delete('price-rules/:id') @RequirePermission('pos.manage')
  deleteRule(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @ClientIp() ip?: string) { return this.pos.deleteRule(u, id, ip); }

  @Get('menu') @RequirePermission('pos.view')
  @ApiOperation({ summary: 'Terminal menu for an outlet with the happy-hour prices in force now' })
  menu(@CurrentUser() u: AuthUser, @Query() q: MenuQueryDto) { return this.pos.menu(u, q.outletId); }

  // Orders
  @Get('orders') @RequirePermission('pos.view')
  orders(@CurrentUser() u: AuthUser, @Query() q: OrdersQueryDto) { return this.pos.list(u, q); }

  @Post('orders') @RequirePermission('pos.order')
  createOrder(@CurrentUser() u: AuthUser, @Body() dto: CreateOrderDto, @ClientIp() ip?: string) { return this.pos.create(u, dto, ip); }

  @Get('orders/:id') @RequirePermission('pos.view')
  order(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) { return this.pos.get(u, id); }

  @Patch('orders/:id') @RequirePermission('pos.order')
  updateOrder(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateOrderDto, @ClientIp() ip?: string) { return this.pos.update(u, id, dto, ip); }

  @Post('orders/:id/lines') @RequirePermission('pos.order') @HttpCode(200)
  addLines(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: AddLinesDto, @ClientIp() ip?: string) { return this.pos.addLines(u, id, dto.lines, ip); }

  @Patch('orders/:id/lines/:lineId') @RequirePermission('pos.order')
  updateLine(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Param('lineId', ParseUUIDPipe) lineId: string, @Body() dto: UpdateLineDto, @ClientIp() ip?: string) { return this.pos.updateLine(u, id, lineId, dto, ip); }

  @Delete('orders/:id/lines/:lineId') @RequirePermission('pos.order')
  deleteLine(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Param('lineId', ParseUUIDPipe) lineId: string, @ClientIp() ip?: string) { return this.pos.deleteLine(u, id, lineId, ip); }

  @Post('orders/:id/send') @RequirePermission('pos.order') @HttpCode(200)
  @ApiOperation({ summary: 'Send new items to the kitchen / bar (tickets per station, stock deducted)' })
  send(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @ClientIp() ip?: string) { return this.pos.send(u, id, ip); }

  @Post('orders/:id/lines/:lineId/void') @RequirePermission('pos.void') @HttpCode(200)
  voidLine(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Param('lineId', ParseUUIDPipe) lineId: string, @Body() dto: VoidLineDto, @ClientIp() ip?: string) { return this.pos.voidLine(u, id, lineId, dto, ip); }

  @Post('orders/:id/discount') @RequirePermission('pos.discount') @HttpCode(200)
  discount(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: OrderDiscountDto, @ClientIp() ip?: string) { return this.pos.discount(u, id, dto, ip); }

  @Delete('orders/:id/discount') @RequirePermission('pos.discount')
  removeDiscount(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @ClientIp() ip?: string) { return this.pos.removeDiscount(u, id, ip); }

  @Post('orders/:id/split') @RequirePermission('pos.order') @HttpCode(200)
  split(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: SplitDto, @ClientIp() ip?: string) { return this.pos.split(u, id, dto.lines, ip); }

  @Post('orders/:id/cancel') @RequirePermission('pos.order') @HttpCode(200)
  cancel(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: CancelOrderDto, @ClientIp() ip?: string) { return this.pos.cancel(u, id, dto.reason, ip); }

  @Post('orders/:id/settle') @RequirePermission('pos.settle') @HttpCode(200)
  @ApiOperation({ summary: 'Settle: payments in the shift, charge to room, city ledger or complimentary' })
  settle(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: SettleDto, @ClientIp() ip?: string) { return this.pos.settle(u, id, dto, ip); }

  @Get('orders/:id/bill') @RequirePermission('pos.view')
  bill(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) { return this.pos.bill(u, id); }

  @Get('rooms/in-house') @RequirePermission('pos.settle')
  inHouse(@CurrentUser() u: AuthUser, @Query() q: InHouseQueryDto) { return this.pos.inHouse(u, q.q); }

  @Get('tickets/:id/print') @RequirePermission('pos.view')
  printTicket(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) { return this.kds.print(u, id); }

  @Get('reports/sales') @RequirePermission('pos.view', 'reports.view')
  sales(@CurrentUser() u: AuthUser, @Query() q: RangeDto) { return this.reports.sales(u, q.from, q.to, q.outletId); }
}

@ApiTags('POS')
@ApiBearerAuth()
@RequireFeature('pos')
@RequirePermission('kds.view')
@Controller('kds')
export class KdsController {
  constructor(private readonly kds: KdsService) {}

  @Get('tickets')
  @ApiOperation({ summary: 'Kitchen / bar tickets (poll every 5 s; ?since= returns changes)' })
  tickets(@CurrentUser() u: AuthUser, @Query() q: KdsQueryDto, @Res({ passthrough: true }) res: Response) {
    res.setHeader('X-Server-Time', new Date().toISOString());
    return this.kds.list(u, q);
  }

  @Post('tickets/:id/status') @HttpCode(200)
  status(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: KdsStatusDto) { return this.kds.setStatus(u, id, dto.status); }

  @Post('tickets/:id/bump') @HttpCode(200)
  bump(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) { return this.kds.bump(u, id); }
}

@ApiTags('POS')
@ApiBearerAuth()
@RequireFeature('pos')
@Controller()
export class StockController {
  constructor(
    private readonly stock: StockService,
    private readonly minibar: MinibarService,
  ) {}

  @Get('stock/items') @RequirePermission('stock.view')
  items(@CurrentUser() u: AuthUser, @Query() q: StockQueryDto) { return this.stock.list(u, q); }

  @Post('stock/items') @RequirePermission('stock.manage')
  create(@CurrentUser() u: AuthUser, @Body() dto: StockItemDto, @ClientIp() ip?: string) { return this.stock.create(u, dto, ip); }

  @Patch('stock/items/:id') @RequirePermission('stock.manage')
  update(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateStockItemDto, @ClientIp() ip?: string) { return this.stock.update(u, id, dto, ip); }

  @Delete('stock/items/:id') @RequirePermission('stock.manage')
  remove(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @ClientIp() ip?: string) { return this.stock.remove(u, id, ip); }

  @Post('stock/purchases') @RequirePermission('stock.manage') @HttpCode(200)
  purchase(@CurrentUser() u: AuthUser, @Body() dto: PurchaseDto, @ClientIp() ip?: string) { return this.stock.purchase(u, dto, ip); }

  @Post('stock/adjustments') @RequirePermission('stock.manage') @HttpCode(200)
  adjust(@CurrentUser() u: AuthUser, @Body() dto: AdjustmentDto, @ClientIp() ip?: string) { return this.stock.adjust(u, dto, ip); }

  @Post('stock/counts') @RequirePermission('stock.manage')
  count(@CurrentUser() u: AuthUser, @Body() dto: CountDto, @ClientIp() ip?: string) { return this.stock.count(u, dto, ip); }

  @Get('stock/counts') @RequirePermission('stock.view')
  counts(@CurrentUser() u: AuthUser, @Query() q: PaginationQueryDto) { return this.stock.counts(u, q.page, q.pageSize); }

  @Get('stock/movements') @RequirePermission('stock.view')
  movements(@CurrentUser() u: AuthUser, @Query() q: MovementsQueryDto) { return this.stock.movements(u, q); }

  @Get('stock/variance') @RequirePermission('stock.view')
  variance(@CurrentUser() u: AuthUser, @Query() q: RangeDto) { return this.stock.variance(u, q.from, q.to); }

  @Get('stock/alerts') @RequirePermission('stock.view')
  alerts(@CurrentUser() u: AuthUser) { return this.stock.alerts(u); }

  @Get('minibar/par') @AnyPermission('stock.view', 'minibar.record')
  par(@CurrentUser() u: AuthUser, @Query() q: MinibarParQueryDto) { return this.minibar.par(u, q.roomTypeId); }

  @Put('minibar/par') @RequirePermission('stock.manage')
  setPar(@CurrentUser() u: AuthUser, @Body() dto: MinibarParDto, @ClientIp() ip?: string) { return this.minibar.setPar(u, dto, ip); }

  @Get('minibar/rooms/:roomId') @RequirePermission('minibar.record')
  room(@CurrentUser() u: AuthUser, @Param('roomId', ParseUUIDPipe) roomId: string) { return this.minibar.room(u, roomId); }

  @Post('minibar/consumption') @RequirePermission('minibar.record')
  @ApiOperation({ summary: 'Record minibar use; charged to the stay in the room (or left open for the desk)' })
  consumption(@CurrentUser() u: AuthUser, @Body() dto: MinibarConsumptionDto, @ClientIp() ip?: string) { return this.minibar.consumption(u, dto, ip); }
}
