import {
  BadRequestException,
  Injectable,
  NotFoundException,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import {
  BudgetStatus,
  PaymentMethod,
  PaymentStatus,
} from '../generated/prisma/client';
import { PrismaService } from '../shared/prisma/prisma.service';
import { MercadoPagoService } from '../mercadopago/mercadopago.service';
import { RabbitMQService } from '../messaging/rabbitmq.service';
import { MetricsService } from '../observability/metrics.service';
import {
  ExecutionFailedPayload,
  OsBudgetRequestedPayload,
  SagaEventPattern,
} from '../messaging/saga-events.interface';
import { CreateBudgetDto } from './dto/create-budget.dto';
import { MercadoPagoWebhookDto } from './dto/mercadopago-webhook.dto';

@Injectable()
export class BillingService implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly mercadoPago: MercadoPagoService,
    private readonly metrics: MetricsService,
    @Optional() private readonly rabbitMQ?: RabbitMQService,
  ) {}

  onModuleInit() {
    if (!this.rabbitMQ) return;

    // 1. Quando uma OS solicita orçamento na Saga, gera o orçamento e a preferência no Mercado Pago
    this.rabbitMQ.registerHandler(
      SagaEventPattern.OS_BUDGET_REQUESTED,
      async (payload: OsBudgetRequestedPayload) => {
        await this.generateBudgetAndPayment({
          workOrderId: payload.workOrderId,
          workOrderCode: payload.workOrderCode,
          customerId: payload.customerId,
          customerName: payload.customerName,
          customerEmail: payload.customerEmail,
          servicesTotal: payload.servicesTotal,
          partsTotal: payload.partsTotal,
        });
      },
    );

    // 2. Compensação da Saga: se a execução falhar na oficina, estorna o pagamento do cliente
    this.rabbitMQ.registerHandler(
      SagaEventPattern.EXECUTION_FAILED,
      async (payload: ExecutionFailedPayload) => {
        await this.compensateExecutionFailure(
          payload.workOrderId,
          payload.reason,
        );
      },
    );
  }

  async generateBudgetAndPayment(dto: CreateBudgetDto) {
    const servicesTotal = Number(dto.servicesTotal);
    const partsTotal = Number(dto.partsTotal);
    const totalAmount = servicesTotal + partsTotal;

    const existing = await this.prisma.budget.findUnique({
      where: { workOrderId: dto.workOrderId },
    });

    if (
      existing &&
      (existing.status === BudgetStatus.APPROVED ||
        existing.status === BudgetStatus.CANCELLED)
    ) {
      throw new BadRequestException(
        'Não é permitido regerar um orçamento já aprovado ou cancelado.',
      );
    }

    const mpPreference = await this.mercadoPago.createPaymentPreference({
      workOrderId: dto.workOrderId,
      workOrderCode: dto.workOrderCode,
      totalAmount,
      customerEmail: dto.customerEmail,
    });

    const budget = existing
      ? await this.prisma.budget.update({
          where: { workOrderId: dto.workOrderId },
          data: {
            workOrderCode: dto.workOrderCode ?? existing.workOrderCode,
            customerId: dto.customerId,
            customerName: dto.customerName ?? existing.customerName,
            customerEmail: dto.customerEmail ?? existing.customerEmail,
            servicesTotal,
            partsTotal,
            totalAmount,
            status: BudgetStatus.PENDING,
            generatedAt: new Date(),
            sentAt: new Date(),
            approvedAt: null,
            rejectedAt: null,
          },
        })
      : await this.prisma.budget.create({
          data: {
            workOrderId: dto.workOrderId,
            workOrderCode: dto.workOrderCode,
            customerId: dto.customerId,
            customerName: dto.customerName,
            customerEmail: dto.customerEmail,
            servicesTotal,
            partsTotal,
            totalAmount,
            status: BudgetStatus.PENDING,
            sentAt: new Date(),
          },
        });

    const payment = await this.prisma.payment.create({
      data: {
        budgetId: budget.id,
        workOrderId: dto.workOrderId,
        amount: totalAmount,
        method: PaymentMethod.PIX,
        status: PaymentStatus.PENDING,
        mercadoPagoId: mpPreference.mercadoPagoId,
        paymentUrl: mpPreference.paymentUrl,
        qrCode: mpPreference.qrCode,
      },
    });

    this.metrics.increment('oficina.billing.budgets_generated');

    return {
      budget,
      payment,
    };
  }

  async findAll() {
    return this.prisma.budget.findMany({
      include: { payments: true },
      orderBy: { createdAt: 'desc' },
    });
  }

  async findByWorkOrder(workOrderId: string) {
    const budget = await this.prisma.budget.findUnique({
      where: { workOrderId },
      include: { payments: true },
    });

    if (!budget) {
      throw new NotFoundException('Orçamento não encontrado para esta OS.');
    }

    return budget;
  }

  async findOne(id: string) {
    const budget = await this.prisma.budget.findUnique({
      where: { id },
      include: { payments: true },
    });

    if (!budget) {
      throw new NotFoundException('Orçamento não encontrado.');
    }

    return budget;
  }

  async approveAndConfirmPayment(workOrderId: string, mercadoPagoId?: string) {
    const budget = await this.findByWorkOrder(workOrderId);

    if (budget.status !== BudgetStatus.PENDING) {
      throw new BadRequestException(
        'Só é possível aprovar um orçamento com status PENDING.',
      );
    }

    const updatedBudget = await this.prisma.budget.update({
      where: { workOrderId },
      data: {
        status: BudgetStatus.APPROVED,
        approvedAt: new Date(),
        rejectedAt: null,
      },
    });

    const pendingPayment = budget.payments?.find(
      (p: any) => p.status === PaymentStatus.PENDING,
    );

    let updatedPayment: any = null;
    if (pendingPayment) {
      updatedPayment = await this.prisma.payment.update({
        where: { id: pendingPayment.id },
        data: {
          status: PaymentStatus.APPROVED,
          mercadoPagoId: mercadoPagoId ?? pendingPayment.mercadoPagoId,
          paidAt: new Date(),
        },
      });
    }

    this.metrics.increment('oficina.billing.payments_approved');

    await this.rabbitMQ?.publish(SagaEventPattern.PAYMENT_APPROVED, {
      event: SagaEventPattern.PAYMENT_APPROVED,
      workOrderId,
      budgetId: updatedBudget.id,
      paymentId: updatedPayment?.id,
      totalAmount: Number(updatedBudget.totalAmount),
      approvedAt: new Date().toISOString(),
    });

    return {
      budget: updatedBudget,
      payment: updatedPayment,
    };
  }

  async rejectPayment(workOrderId: string, reason = 'Orçamento/pagamento recusado') {
    const budget = await this.findByWorkOrder(workOrderId);

    if (budget.status !== BudgetStatus.PENDING) {
      throw new BadRequestException(
        'Só é possível rejeitar um orçamento com status PENDING.',
      );
    }

    const updatedBudget = await this.prisma.budget.update({
      where: { workOrderId },
      data: {
        status: BudgetStatus.REJECTED,
        rejectedAt: new Date(),
        approvedAt: null,
      },
    });

    const pendingPayment = budget.payments?.find(
      (p: any) => p.status === PaymentStatus.PENDING,
    );

    if (pendingPayment) {
      await this.prisma.payment.update({
        where: { id: pendingPayment.id },
        data: {
          status: PaymentStatus.REJECTED,
          failureReason: reason,
        },
      });
    }

    this.metrics.integrationError('payment_rejected');

    // Publica evento de falha na Saga para que o OS Service faça o rollback do estoque e cancele a OS
    await this.rabbitMQ?.publish(SagaEventPattern.PAYMENT_FAILED, {
      event: SagaEventPattern.PAYMENT_FAILED,
      workOrderId,
      budgetId: updatedBudget.id,
      reason,
      failedAt: new Date().toISOString(),
    });

    return updatedBudget;
  }

  async handleMercadoPagoWebhook(dto: MercadoPagoWebhookDto) {
    if (dto.status === 'approved') {
      return this.approveAndConfirmPayment(dto.workOrderId, dto.mercadoPagoId);
    }

    return this.rejectPayment(
      dto.workOrderId,
      dto.reason ?? `Pagamento Mercado Pago ${dto.status}`,
    );
  }

  /**
   * Compensação / Rollback da Saga:
   * Quando a execução da OS falha na oficina após o pagamento ter sido aprovado,
   * estorna o pagamento no Mercado Pago e atualiza o status para REFUNDED / CANCELLED.
   */
  async compensateExecutionFailure(workOrderId: string, reason: string) {
    const budget = await this.prisma.budget.findUnique({
      where: { workOrderId },
      include: { payments: true },
    });

    if (!budget) {
      return null;
    }

    const approvedPayment = budget.payments?.find(
      (p: any) => p.status === PaymentStatus.APPROVED,
    );

    if (approvedPayment) {
      if (approvedPayment.mercadoPagoId) {
        await this.mercadoPago.refundPayment(approvedPayment.mercadoPagoId);
      }

      await this.prisma.payment.update({
        where: { id: approvedPayment.id },
        data: {
          status: PaymentStatus.REFUNDED,
          refundedAt: new Date(),
          failureReason: `Estorno Saga: ${reason}`,
        },
      });
    }

    const updatedBudget = await this.prisma.budget.update({
      where: { workOrderId },
      data: {
        status: BudgetStatus.CANCELLED,
      },
    });

    this.metrics.integrationError('billing_saga_refund');

    return updatedBudget;
  }
}
