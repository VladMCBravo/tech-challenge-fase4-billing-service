import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { BillingService } from './billing.service';
import { MercadoPagoService } from '../mercadopago/mercadopago.service';
import { CreateBudgetDto } from './dto/create-budget.dto';
import { MercadoPagoWebhookDto } from './dto/mercadopago-webhook.dto';

@ApiTags('Billing & Mercado Pago')
@Controller('budgets')
export class BillingController {
  constructor(
    private readonly billingService: BillingService,
    private readonly mercadoPagoService: MercadoPagoService,
  ) {}

  @Post('mercadopago/oauth/token')
  @ApiOperation({
    summary:
      'Autentica no Mercado Pago via client_id e client_secret retornando o token OAuth2 para chamadas de pagamento',
  })
  getMercadoPagoToken(
    @Body() body?: { clientId?: string; clientSecret?: string },
  ) {
    return this.mercadoPagoService.getAccessToken(
      body?.clientId,
      body?.clientSecret,
    );
  }

  @Post()
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @ApiOperation({
    summary: 'Gera orçamento para uma OS e cria cobrança integrada no Mercado Pago',
  })
  generate(@Body() dto: CreateBudgetDto) {
    return this.billingService.generateBudgetAndPayment(dto);
  }

  @Get()
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'Lista todos os orçamentos e pagamentos' })
  findAll() {
    return this.billingService.findAll();
  }

  @Get('work-order/:workOrderId')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'Consulta orçamento e pagamentos pelo ID da OS' })
  findByWorkOrder(@Param('workOrderId') workOrderId: string) {
    return this.billingService.findByWorkOrder(workOrderId);
  }

  @Get(':id')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'Consulta orçamento pelo ID' })
  findOne(@Param('id') id: string) {
    return this.billingService.findOne(id);
  }

  @Post('work-order/:workOrderId/approve')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @ApiOperation({
    summary:
      'Aprova orçamento / confirma pagamento e publica evento Saga payment.approved',
  })
  approve(@Param('workOrderId') workOrderId: string) {
    return this.billingService.approveAndConfirmPayment(workOrderId);
  }

  @Post('work-order/:workOrderId/reject')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @ApiOperation({
    summary:
      'Rejeita orçamento / pagamento e dispara compensação Saga payment.failed',
  })
  reject(
    @Param('workOrderId') workOrderId: string,
    @Body() body?: { reason?: string },
  ) {
    return this.billingService.rejectPayment(workOrderId, body?.reason);
  }

  @Post('webhook/mercadopago')
  @ApiOperation({
    summary:
      'Webhook público do Mercado Pago para confirmação ou recusa de pagamento',
  })
  mercadoPagoWebhook(@Body() dto: MercadoPagoWebhookDto) {
    return this.billingService.handleMercadoPagoWebhook(dto);
  }

  @Post('work-order/:workOrderId/refund')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @ApiOperation({
    summary: 'Executa estorno do pagamento no Mercado Pago (Compensação Saga)',
  })
  refund(
    @Param('workOrderId') workOrderId: string,
    @Body() body?: { reason?: string },
  ) {
    return this.billingService.compensateExecutionFailure(
      workOrderId,
      body?.reason ?? 'Estorno solicitado via API',
    );
  }
}
