# Tech Challenge Fase 4 — Billing Service (`tech-challenge-fase4-billing-service`)

Microsserviço responsável pela geração de **Orçamentos (`Budgets`)**, autenticação OAuth2 (`client_id` / `client_secret` → `access_token`) e processamento de **Pagamentos (`Payments`)** integrado ao **Mercado Pago** (Checkout Pro / PIX / Webhook), além da coordenação de eventos de aprovação, recusa e estorno na **Saga Coreografada**.

- **Participante:** Vladmir Musa Costa Bravo (RM 374193)
- **Curso:** Pós-graduação em Arquitetura de Software — FIAP (SOAT)

---

## 1. Responsabilidades, Isolamento de Dados e Fluxo Mercado Pago

- **Banco de Dados Próprio (SQL — PostgreSQL `billing_db`):** Contém exclusivamente as tabelas `budgets` e `payments`. Não possui acesso direto ao banco do `os-service` nem ao MongoDB do `execution-service`.
- **Infraestrutura Terraform Própria (`/infra`) e Manifestos K8s (`/k8s`):** Provisionamento isolado do repositório ECR e da instância RDS PostgreSQL (`billing_db`).
- **Integração com Mercado Pago (`src/mercadopago/mercadopago.service.ts`):**
  1. **Fluxo OAuth2 (`client_id` + `client_secret` → `access_token`):** Antes de criar uma preferência de pagamento ou via endpoint dedicado (`POST /api/budgets/mercadopago/oauth/token`), o serviço autentica no endpoint `/oauth/token` do Mercado Pago usando `client_id` e `client_secret` (`grant_type: client_credentials`) para obter um `access_token` Bearer.
  2. **Fallback Mock Resiliente:** Caso o painel de credenciais de teste do Mercado Pago esteja indisponível ou sem credenciais externas configuradas, o serviço opera automaticamente com um **Mock OAuth2 + Checkout/PIX realista**, garantindo 100% de testabilidade ponta a ponta conforme alinhado com a coordenação da FIAP.
  3. **Checkout / PIX e Webhook (`POST /api/budgets/webhook/mercadopago`):** Cria preferências (`/checkout/preferences`) e QR Code PIX vinculados ao `workOrderId` (`external_reference`) e processa notificações de aprovação (`approved`) ou rejeição (`rejected`).
  4. **Estorno/Reembolso (`/v1/payments/{id}/refunds`):** Executado automaticamente quando a Saga reporta falha na execução (`execution.failed`).

---

## 2. Participação no Saga Pattern (Coreografado via RabbitMQ)

1. **Consumo de `os.budget.requested`:** Quando o `os-service` move a OS para `WAITING_APPROVAL`, o `billing-service` consome o evento, gera o orçamento (`PENDING`), obtém o token OAuth2 e cria a cobrança no Mercado Pago.
2. **Publicação de `payment.approved`:** Quando o pagamento é confirmado (via Webhook do Mercado Pago ou endpoint de aprovação), atualiza o orçamento/pagamento para `APPROVED` e publica `payment.approved` no RabbitMQ, liberando o início da execução no `os-service` e no `execution-service`.
3. **Publicação de `payment.failed` (Gatilho de Rollback):** Quando o pagamento é recusado ou o orçamento é rejeitado, publica `payment.failed`, fazendo com que o `os-service` estorne as peças reservadas ao estoque e cancele a OS.
4. **Consumo de `execution.failed` (Compensação de Pagamento):** Se a execução falhar na oficina após o pagamento aprovado, o `billing-service` consome `execution.failed`, **executa o estorno no Mercado Pago (`REFUNDED`)** e marca o orçamento como `CANCELLED`.

---

## 3. Evidências de Testes e Cobertura (`> 80%`)

```text
PASS src/billing/billing.service.spec.ts
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
PASS src/messaging/rabbitmq.service.spec.ts
    ✓ modo in-memory > não conecta ao broker sem RABBITMQ_URL e registra eventos publicados
    ✓ modo in-memory > despacha eventos para todos os handlers registrados
    ✓ com RabbitMQ real > cria exchange/fila, faz bind das routing keys e só consome após o bootstrap
    ✓ com RabbitMQ real > processa a mensagem no handler e confirma (ack)
    ✓ com RabbitMQ real > rejeita (nack) mensagens inválidas ou cujo handler falha
    ✓ com RabbitMQ real > publica eventos persistentes na exchange da Saga
    ✓ com RabbitMQ real > registra erro quando a publicação no canal falha
    ✓ com RabbitMQ real > reconecta automaticamente quando o broker ainda não está disponível
    ✓ com RabbitMQ real > reconecta quando a conexão é encerrada e para ao desligar
    ✓ com RabbitMQ real > cancela a reconexão pendente ao desligar

-------------------------|---------|----------|---------|---------|--------------------
File                     | % Stmts | % Branch | % Funcs | % Lines | Uncovered Line #s  
-------------------------|---------|----------|---------|---------|--------------------
All files                |   96.41 |    83.97 |     100 |   97.44 |                    
 billing                 |   97.43 |    78.57 |     100 |   98.66 |                    
 mercadopago             |   95.45 |    85.36 |     100 |   95.23 |                    
 messaging               |   98.14 |    90.19 |     100 |     100 |                    
 observability           |   85.71 |       75 |     100 |   84.21 |                    
-------------------------|---------|----------|---------|---------|--------------------
Test Suites: 2 passed, 2 total
Tests:       20 passed, 20 total
```

---

## 4. CI/CD, Deploy Automatizado em Kubernetes e Nota sobre AWS Academy

Pipeline: [`.github/workflows/deploy.yml`](./.github/workflows/deploy.yml) — disparado automaticamente em `push` e `pull_request` na `main` (e `workflow_dispatch`). A `main` é protegida: o merge só acontece via Pull Request com os dois jobs abaixo aprovados.

| Job | O que faz |
|---|---|
| `test-and-quality` | `npm ci` → testes unitários com cobertura (`npm run test:cov`) → build → análise SonarQube/SonarCloud |
| `build-and-deploy` | build da imagem Docker → cria cluster Kubernetes **Kind** → instala o metrics-server (HPA) → executa [`scripts/deploy-k8s.sh`](./scripts/deploy-k8s.sh) |

O script [`scripts/deploy-k8s.sh`](./scripts/deploy-k8s.sh) faz o deploy completo e **falha o pipeline** se algo não subir:
1. Sobe as dependências próprias do serviço — `k8s/postgres.yaml` (PostgreSQL `billing_db`) e `k8s/rabbitmq.yaml` (broker da Saga) — e espera ficarem prontas;
2. Aplica `secret.yaml`, `deployment.yaml`, `service.yaml` e `hpa.yaml`;
3. Espera o `kubectl rollout status` do `billing-service` (2 réplicas Ready);
4. Testa os health checks pelo Service: `GET /api/health` e `GET /api/health/ready` (banco **e** RabbitMQ conectados — `"messaging":"connected"`);
5. Imprime as evidências: deployments, pods, services, HPA e logs de conexão com o RabbitMQ.

Para rodar localmente contra qualquer cluster (ex.: Kind): `kind create cluster && docker build -t oficina-billing-service:latest . && kind load docker-image oficina-billing-service:latest && ./scripts/deploy-k8s.sh`.

**Nota sobre o AWS Academy:** as sessões do laboratório expiram e os créditos são limitados, então — conforme orientação dos professores — o deploy automatizado do pipeline é feito em Kubernetes local (**Kind**) dentro do próprio GitHub Actions, com manifests, script de deploy e evidências de pods/services/health checks nos logs de cada execução. Os mesmos manifestos são aplicáveis no Amazon EKS provisionado pelo Terraform (`/infra` e repositório `tech-challenge-fase3-infra-k8s`); nesse caso o `DATABASE_URL`/`MONGODB_URI` do Secret aponta para o banco gerenciado.

---

## 5. Principais Endpoints e Execução

- `POST /api/budgets/mercadopago/oauth/token` — Obtém `access_token` OAuth2 no Mercado Pago a partir de `client_id` e `client_secret` (com fallback Mock)
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
