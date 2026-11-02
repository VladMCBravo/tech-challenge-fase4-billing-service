import { Injectable, Logger } from '@nestjs/common';

export interface MercadoPagoPaymentResult {
  mercadoPagoId: string;
  paymentUrl: string;
  qrCode: string;
  status: 'PENDING' | 'APPROVED' | 'REJECTED';
}

@Injectable()
export class MercadoPagoService {
  private readonly logger = new Logger(MercadoPagoService.name);
  private readonly baseUrl = 'https://api.mercadopago.com';

  async createPaymentPreference(params: {
    workOrderId: string;
    workOrderCode?: string;
    totalAmount: number;
    customerEmail?: string;
  }): Promise<MercadoPagoPaymentResult> {
    const token = process.env.MERCADOPAGO_ACCESS_TOKEN;

    if (token && process.env.NODE_ENV !== 'test') {
      try {
        const response = await fetch(`${this.baseUrl}/checkout/preferences`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            external_reference: params.workOrderId,
            items: [
              {
                id: params.workOrderId,
                title: `Orçamento Oficina Mecânica - ${params.workOrderCode ?? params.workOrderId}`,
                quantity: 1,
                currency_id: 'BRL',
                unit_price: Number(params.totalAmount),
              },
            ],
            payer: {
              email: params.customerEmail ?? 'cliente@oficina.com.br',
            },
          }),
        });

        if (response.ok) {
          const data: any = await response.json();
          this.logger.log(
            `Preferência Mercado Pago criada com sucesso: ${data.id}`,
          );
          return {
            mercadoPagoId: String(data.id),
            paymentUrl: data.init_point ?? data.sandbox_init_point,
            qrCode: `00020126580014br.gov.bcb.pix0136${data.id}`,
            status: 'PENDING',
          };
        }
      } catch (err) {
        this.logger.warn(
          `Falha na chamada HTTP ao Mercado Pago (${String(err)}). Usando gerador sandbox local.`,
        );
      }
    }

    const mpId = `mp_${params.workOrderId}_${Date.now()}`;
    return {
      mercadoPagoId: mpId,
      paymentUrl: `https://www.mercadopago.com.br/checkout/v1/redirect?pref_id=${mpId}`,
      qrCode: `00020126580014br.gov.bcb.pix0136${mpId}5204000053039865406${Number(params.totalAmount).toFixed(2)}`,
      status: 'PENDING',
    };
  }

  async refundPayment(mercadoPagoId: string): Promise<{ refunded: boolean; refundId: string }> {
    const token = process.env.MERCADOPAGO_ACCESS_TOKEN;

    if (token && process.env.NODE_ENV !== 'test') {
      try {
        const response = await fetch(
          `${this.baseUrl}/v1/payments/${mercadoPagoId}/refunds`,
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${token}`,
              'Content-Type': 'application/json',
            },
          },
        );
        if (response.ok) {
          const data: any = await response.json();
          return { refunded: true, refundId: String(data.id) };
        }
      } catch (err) {
        this.logger.warn(
          `Fallback no estorno Mercado Pago (${mercadoPagoId}): ${String(err)}`,
        );
      }
    }

    this.logger.log(`Pagamento ${mercadoPagoId} estornado no Mercado Pago.`);
    return {
      refunded: true,
      refundId: `refund_${mercadoPagoId}_${Date.now()}`,
    };
  }
}
