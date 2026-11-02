# Tech Challenge Fase 4 — Billing Service (`tech-challenge-fase4-billing-service`)

Microsserviço responsável pela geração de **Orçamentos (`Budgets`)**, processamento de **Pagamentos (`Payments`)** integrado ao **Mercado Pago** (Checkout Pro / PIX / Webhook) e coordenação de eventos de aprovação, recusa e estorno na **Saga Coreografada**.

- **Participante:** Vladmir Musa Costa Bravo (RM 374193)
- **Curso:** Pós-graduação em Arquitetura de Software — FIAP (SOAT)

---

## 1. Responsabilidades e Isolamento de Dados

- **Banco de Dados Próprio (SQL — PostgreSQL `billing_db`):** Contém exclusivamente as tabelas `budgets` e `payments`. Não possui acesso direto ao banco do `os-service` nem ao MongoDB do `execution-service`.
- **Integração com Mercado Pago (`src/mercadopago/mercadopago.service.ts`):**
  - Cria preferências de pagamento (`/checkout/preferences`) e QR Code PIX vinculados ao `workOrderId` (`external_reference`).
  - Recebe notificações via Webhook (`POST /api/budgets/webhook/mercadopago`).
  - Realiza estorno/reembolso (`/v1/payments/{id}/refunds`) em caso de falha na execução da OS.

---

## 2. Participação no Saga Pattern (Coreografado via RabbitMQ)

1. **Consumo de `os.budget.requested`:** Quando o `os-service` move a OS para `WAITING_APPROVAL`, o `billing-service` consome o evento, gera o orçamento (`PENDING`) e cria a cobrança no Mercado Pago.
2. **Publicação de `payment.approved`:** Quando o pagamento é confirmado (via Webhook do Mercado Pago ou endpoint de aprovação), atualiza o orçamento/pagamento para `APPROVED` e publica `payment.approved` no RabbitMQ, liberando o início da execução no `os-service` e no `execution-service`.
3. **Publicação de `payment.failed` (Gatilho de Rollback):** Quando o pagamento é recusado ou o orçamento é rejeitado, publica `payment.failed`, fazendo com que o `os-service` estorne as peças reservadas ao estoque e cancele a OS.
4. **Consumo de `execution.failed` (Compensação de Pagamento):** Se a execução falhar na oficina após o pagamento aprovado, o `billing-service` consome `execution.failed`, **executa o estorno no Mercado Pago (`REFUNDED`)** e marca o orçamento como `CANCELLED`.

---

## 3. Evidências de Testes e Cobertura (`> 80%`)

```text
PASS src/billing/billing.service.spec.ts
  BillingService & MercadoPagoService
    ✓ deve gerar orçamento e preferência PIX/Checkout no Mercado Pago quando acionado diretamente ou via evento os.budget.requested
    ✓ deve atualizar orçamento existente se estiver PENDING ou REJECTED
    ✓ deve impedir regeração de orçamento já aprovado ou cancelado
    ✓ deve consumir evento Saga os.budget.requested automaticamente
    ✓ deve aprovar orçamento via Webhook do Mercado Pago e publicar payment.approved na Saga
    ✓ deve rejeitar pagamento via Webhook do Mercado Pago e publicar payment.failed para acionar rollback na Saga
    ✓ deve estornar pagamento no Mercado Pago (REFUNDED) quando receber evento execution.failed da Saga
    ✓ deve listar e buscar orçamentos e lançar NotFoundException quando não existir
    ✓ deve impedir aprovação ou rejeição de orçamento fora de PENDING
    ✓ deve exercitar chamada HTTP real do MercadoPagoService com token e fallback em erro, além de MetricsService e RabbitMQService

-------------------|---------|----------|---------|---------|-------------------
File               | % Stmts | % Branch | % Funcs | % Lines | Uncovered Line #s 
-------------------|---------|----------|---------|---------|-------------------
All files          |   82.51 |     74.5 |   94.11 |   82.65 |                   
 billing           |   97.43 |    78.57 |     100 |   98.66 | 298               
 mercadopago       |   96.29 |    83.33 |     100 |      96 | 96                
 observability     |   85.71 |       75 |     100 |   84.21 | 25,33,42          
-------------------|---------|----------|---------|---------|-------------------
Test Suites: 1 passed, 1 total
Tests:       10 passed, 10 total
```

---

## 4. Principais Endpoints e Execução

- `POST /api/budgets` — Gera orçamento e cobrança no Mercado Pago
- `GET /api/budgets/work-order/:workOrderId` — Consulta orçamento e pagamentos da OS
- `POST /api/budgets/webhook/mercadopago` — Webhook de confirmação/recusa do Mercado Pago
- `POST /api/budgets/work-order/:workOrderId/approve` — Aprova orçamento/pagamento e dispara `payment.approved`
- `POST /api/budgets/work-order/:workOrderId/reject` — Rejeita orçamento/pagamento e dispara `payment.failed`
- `POST /api/budgets/work-order/:workOrderId/refund` — Estorna pagamento (`REFUNDED`)
- **Swagger:** `http://localhost:3001/docs`

```bash
npm ci
DATABASE_URL="postgresql://user:pass@localhost:5432/billing_db" npx prisma generate
npm run test:cov
npm run start:dev
```
