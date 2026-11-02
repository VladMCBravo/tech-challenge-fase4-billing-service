import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';

export class MercadoPagoWebhookDto {
  @ApiProperty({ example: 'wo-123', description: 'ID da Ordem de Serviço (external_reference)' })
  @IsString()
  workOrderId: string;

  @ApiPropertyOptional({ example: 'mp_wo-123_17100000', description: 'ID do pagamento no Mercado Pago' })
  @IsOptional()
  @IsString()
  mercadoPagoId?: string;

  @ApiProperty({
    example: 'approved',
    enum: ['approved', 'rejected', 'cancelled'],
    description: 'Status notificado pelo Mercado Pago',
  })
  @IsString()
  status: 'approved' | 'rejected' | 'cancelled';

  @ApiPropertyOptional({ example: 'Saldo insuficiente ou cartão recusado' })
  @IsOptional()
  @IsString()
  reason?: string;
}
