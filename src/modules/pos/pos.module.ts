import { Module } from '@nestjs/common';
import { KdsController, PosController, StockController } from './pos.controller.js';
import { KdsService } from './kds.service.js';
import { MinibarService } from './minibar.service.js';
import { PosReportsService } from './pos-reports.service.js';
import { PosService } from './pos.service.js';
import { StockService } from './stock.service.js';

/** M5 point of sale, kitchen display, stock and minibar (feature `pos`). */
@Module({
  controllers: [PosController, KdsController, StockController],
  providers: [PosService, KdsService, StockService, MinibarService, PosReportsService],
  exports: [PosService, StockService],
})
export class PosModule {}
