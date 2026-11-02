import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNumber, IsOptional, IsString, Min } from 'class-validator';

export class CreateBudgetDto {
  @ApiProperty({ example: 'wo-123' })
  @IsString()
  workOrderId: string;

  @ApiPropertyOptional({ example: 'OS-17100000' })
  @IsOptional()
  @IsString()
  workOrderCode?: string;

  @ApiProperty({ example: 'customer-123' })
  @IsString()
  customerId: string;

  @ApiPropertyOptional({ example: 'Maria Oliveira' })
  @IsOptional()
  @IsString()
  customerName?: string;

  @ApiPropertyOptional({ example: 'maria@email.com' })
  @IsOptional()
  @IsString()
  customerEmail?: string;

  @ApiProperty({ example: 150.0 })
  @IsNumber()
  @Min(0)
  servicesTotal: number;

  @ApiProperty({ example: 100.0 })
  @IsNumber()
  @Min(0)
  partsTotal: number;
}
