jest.mock('../shared/prisma/prisma.service', () => ({
  PrismaService: class PrismaService {},
}));

jest.mock('../generated/prisma/client', () => ({
  BudgetStatus: {
    PENDING: 'PENDING',
    APPROVED: 'APPROVED',
    REJECTED: 'REJECTED',
    CANCELLED: 'CANCELLED',
  },
  PaymentStatus: {
    PENDING: 'PENDING',
    APPROVED: 'APPROVED',
    REJECTED: 'REJECTED',
    REFUNDED: 'REFUNDED',
  },
  PaymentMethod: {
    PIX: 'PIX',
    CHECKOUT_PRO: 'CHECKOUT_PRO',
    CREDIT_CARD: 'CREDIT_CARD',
  },
}));

import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '../shared/prisma/prisma.service';
import { MercadoPagoService } from '../mercadopago/mercadopago.service';
import { RabbitMQService } from '../messaging/rabbitmq.service';
import { MetricsService } from '../observability/metrics.service';
import { BillingService } from './billing.service';
import { SagaEventPattern } from '../messaging/saga-events.interface';

describe('BillingService & MercadoPagoService', () => {
  let service: BillingService;
  let rabbitMQ: RabbitMQService;
  let mercadoPago: MercadoPagoService;

  const prismaMock = {
    budget: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    payment: {
      create: jest.fn(),
      update: jest.fn(),
    },
  };

  beforeEach(async () => {
    jest.resetAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BillingService,
        MercadoPagoService,
        RabbitMQService,
        MetricsService,
        {
          provide: PrismaService,
          useValue: prismaMock,
        },
      ],
    }).compile();

    service = module.get<BillingService>(BillingService);
    rabbitMQ = module.get<RabbitMQService>(RabbitMQService);
    mercadoPago = module.get<MercadoPagoService>(MercadoPagoService);
    await rabbitMQ.onModuleInit();
    service.onModuleInit();
  });

  it('deve gerar orçamento e preferência PIX/Checkout no Mercado Pago quando acionado diretamente ou via evento os.budget.requested', async () => {
    prismaMock.budget.findUnique.mockResolvedValue(null);
    prismaMock.budget.create.mockResolvedValue({
      id: 'budget-1',
      workOrderId: 'wo-1',
      servicesTotal: 150,
      partsTotal: 100,
      totalAmount: 250,
      status: 'PENDING',
    });
    prismaMock.payment.create.mockImplementation(async ({ data }) => ({
      id: 'pay-1',
      ...data,
    }));

    const result = await service.generateBudgetAndPayment({
      workOrderId: 'wo-1',
      workOrderCode: 'OS-100',
      customerId: 'cust-1',
      customerName: 'João',
      customerEmail: 'joao@email.com',
      servicesTotal: 150,
      partsTotal: 100,
    });

    expect(result.budget.totalAmount).toBe(250);
    expect(result.payment.mercadoPagoId).toContain('mp_wo-1_');
    expect(result.payment.paymentUrl).toContain('mercadopago.com.br');
    expect(result.payment.qrCode).toContain('br.gov.bcb.pix');
  });

  it('deve atualizar orçamento existente se estiver PENDING ou REJECTED', async () => {
    prismaMock.budget.findUnique.mockResolvedValue({
      id: 'budget-1',
      workOrderId: 'wo-1',
      status: 'REJECTED',
    });
    prismaMock.budget.update.mockResolvedValue({
      id: 'budget-1',
      workOrderId: 'wo-1',
      totalAmount: 300,
      status: 'PENDING',
    });
    prismaMock.payment.create.mockResolvedValue({
      id: 'pay-2',
      status: 'PENDING',
    });

    const result = await service.generateBudgetAndPayment({
      workOrderId: 'wo-1',
      customerId: 'cust-1',
      servicesTotal: 200,
      partsTotal: 100,
    });

    expect(prismaMock.budget.update).toHaveBeenCalled();
    expect(result.budget.status).toBe('PENDING');
  });

  it('deve impedir regeração de orçamento já aprovado ou cancelado', async () => {
    prismaMock.budget.findUnique.mockResolvedValue({
      id: 'budget-1',
      workOrderId: 'wo-1',
      status: 'APPROVED',
    });

    await expect(
      service.generateBudgetAndPayment({
        workOrderId: 'wo-1',
        customerId: 'cust-1',
        servicesTotal: 100,
        partsTotal: 50,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('deve consumir evento Saga os.budget.requested automaticamente', async () => {
    prismaMock.budget.findUnique.mockResolvedValue(null);
    prismaMock.budget.create.mockResolvedValue({
      id: 'budget-saga',
      workOrderId: 'wo-saga',
      totalAmount: 400,
      status: 'PENDING',
    });
    prismaMock.payment.create.mockResolvedValue({
      id: 'pay-saga',
      status: 'PENDING',
    });

    await rabbitMQ.dispatchEvent(SagaEventPattern.OS_BUDGET_REQUESTED, {
      event: SagaEventPattern.OS_BUDGET_REQUESTED,
      workOrderId: 'wo-saga',
      workOrderCode: 'OS-SAGA',
      customerId: 'cust-1',
      servicesTotal: 250,
      partsTotal: 150,
      totalAmount: 400,
      timestamp: new Date().toISOString(),
    });

    expect(prismaMock.budget.create).toHaveBeenCalled();
    expect(prismaMock.payment.create).toHaveBeenCalled();
  });

  it('deve aprovar orçamento via Webhook do Mercado Pago e publicar payment.approved na Saga', async () => {
    prismaMock.budget.findUnique.mockResolvedValue({
      id: 'budget-1',
      workOrderId: 'wo-1',
      totalAmount: 250,
      status: 'PENDING',
      payments: [
        {
          id: 'pay-1',
          status: 'PENDING',
          mercadoPagoId: 'mp_123',
        },
      ],
    });

    prismaMock.budget.update.mockResolvedValue({
      id: 'budget-1',
      workOrderId: 'wo-1',
      totalAmount: 250,
      status: 'APPROVED',
    });

    prismaMock.payment.update.mockResolvedValue({
      id: 'pay-1',
      status: 'APPROVED',
      mercadoPagoId: 'mp_official_999',
    });

    const res: any = await service.handleMercadoPagoWebhook({
      workOrderId: 'wo-1',
      mercadoPagoId: 'mp_official_999',
      status: 'approved',
    });

    expect(res.budget.status).toBe('APPROVED');
    expect(res.payment.status).toBe('APPROVED');

    const events = rabbitMQ.getPublishedEvents();
    expect(events).toHaveLength(1);
    expect(events[0].pattern).toBe(SagaEventPattern.PAYMENT_APPROVED);
    expect(events[0].payload.workOrderId).toBe('wo-1');
  });

  it('deve rejeitar pagamento via Webhook do Mercado Pago e publicar payment.failed para acionar rollback na Saga', async () => {
    prismaMock.budget.findUnique.mockResolvedValue({
      id: 'budget-1',
      workOrderId: 'wo-1',
      totalAmount: 250,
      status: 'PENDING',
      payments: [{ id: 'pay-1', status: 'PENDING' }],
    });

    prismaMock.budget.update.mockResolvedValue({
      id: 'budget-1',
      workOrderId: 'wo-1',
      status: 'REJECTED',
    });

    prismaMock.payment.update.mockResolvedValue({
      id: 'pay-1',
      status: 'REJECTED',
    });

    const res: any = await service.handleMercadoPagoWebhook({
      workOrderId: 'wo-1',
      status: 'rejected',
      reason: 'Cartão sem limite',
    });

    expect(res.status).toBe('REJECTED');

    const events = rabbitMQ.getPublishedEvents();
    expect(events).toHaveLength(1);
    expect(events[0].pattern).toBe(SagaEventPattern.PAYMENT_FAILED);
    expect(events[0].payload.reason).toBe('Cartão sem limite');
  });

  it('deve estornar pagamento no Mercado Pago (REFUNDED) quando receber evento execution.failed da Saga', async () => {
    prismaMock.budget.findUnique.mockResolvedValue({
      id: 'budget-1',
      workOrderId: 'wo-1',
      status: 'APPROVED',
      payments: [
        {
          id: 'pay-1',
          status: 'APPROVED',
          mercadoPagoId: 'mp_approved_1',
        },
      ],
    });

    prismaMock.payment.update.mockResolvedValue({
      id: 'pay-1',
      status: 'REFUNDED',
    });

    prismaMock.budget.update.mockResolvedValue({
      id: 'budget-1',
      workOrderId: 'wo-1',
      status: 'CANCELLED',
    });

    const refundSpy = jest.spyOn(mercadoPago, 'refundPayment');

    await rabbitMQ.dispatchEvent(SagaEventPattern.EXECUTION_FAILED, {
      event: SagaEventPattern.EXECUTION_FAILED,
      workOrderId: 'wo-1',
      reason: 'Motor fundido sem possibilidade de reparo',
      failedAt: new Date().toISOString(),
    });

    expect(refundSpy).toHaveBeenCalledWith('mp_approved_1');
    expect(prismaMock.payment.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'pay-1' },
        data: expect.objectContaining({ status: 'REFUNDED' }),
      }),
    );
    expect(prismaMock.budget.update).toHaveBeenCalledWith({
      where: { workOrderId: 'wo-1' },
      data: { status: 'CANCELLED' },
    });
  });

  it('deve listar e buscar orçamentos e lançar NotFoundException quando não existir', async () => {
    prismaMock.budget.findMany.mockResolvedValue([{ id: 'b1' }]);
    expect(await service.findAll()).toHaveLength(1);

    prismaMock.budget.findUnique.mockResolvedValue({ id: 'b1' });
    expect((await service.findOne('b1')).id).toBe('b1');

    prismaMock.budget.findUnique.mockResolvedValue(null);
    await expect(service.findOne('missing')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(service.findByWorkOrder('missing')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('deve impedir aprovação ou rejeição de orçamento fora de PENDING', async () => {
    prismaMock.budget.findUnique.mockResolvedValue({
      id: 'b1',
      workOrderId: 'wo-1',
      status: 'APPROVED',
    });

    await expect(
      service.approveAndConfirmPayment('wo-1'),
    ).rejects.toBeInstanceOf(BadRequestException);

    await expect(service.rejectPayment('wo-1')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('deve exercitar chamada HTTP real do MercadoPagoService com token e fallback em erro, além de MetricsService e RabbitMQService', async () => {
    const originalEnv = process.env.NODE_ENV;
    const originalToken = process.env.MERCADOPAGO_ACCESS_TOKEN;
    const originalFetch = global.fetch;

    try {
      process.env.NODE_ENV = 'production';
      process.env.MERCADOPAGO_ACCESS_TOKEN = 'TEST-MP-TOKEN';

      global.fetch = jest.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: 'pref_999',
          init_point: 'https://mercadopago.com.br/checkout/pref_999',
        }),
      } as any);

      const pref = await mercadoPago.createPaymentPreference({
        workOrderId: 'wo-http',
        totalAmount: 199.9,
      });
      expect(pref.mercadoPagoId).toBe('pref_999');

      global.fetch = jest.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: 'ref_999' }),
      } as any);

      const ref = await mercadoPago.refundPayment('pay_999');
      expect(ref.refundId).toBe('ref_999');

      // Simula falha de rede para exercitar o fallback
      global.fetch = jest.fn().mockRejectedValueOnce(new Error('Network error'));
      const fallbackPref = await mercadoPago.createPaymentPreference({
        workOrderId: 'wo-fallback',
        totalAmount: 100,
      });
      expect(fallbackPref.mercadoPagoId).toContain('mp_wo-fallback_');
    } finally {
      process.env.NODE_ENV = originalEnv;
      process.env.MERCADOPAGO_ACCESS_TOKEN = originalToken;
      global.fetch = originalFetch;
    }

    const metrics = new MetricsService();
    metrics.workOrderCreated();
    metrics.workOrderStatusChanged('APPROVED');
    metrics.workOrderStageDuration('execucao', 10);
    metrics.gauge('oficina.billing.pending', 1);
    rabbitMQ.clearPublishedEvents();
    expect(rabbitMQ.getPublishedEvents()).toHaveLength(0);
    await rabbitMQ.onModuleDestroy();
  });
});
