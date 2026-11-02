import { Module } from '@nestjs/common';
import { PrismaModule } from '../shared/prisma/prisma.module';
import { MercadoPagoService } from '../mercadopago/mercadopago.service';
import { BillingController } from './billing.controller';
import { BillingService } from './billing.service';

@Module({
  imports: [PrismaModule],
  controllers: [BillingController],
  providers: [BillingService, MercadoPagoService],
  exports: [BillingService, MercadoPagoService],
})
export class BillingModule {}
