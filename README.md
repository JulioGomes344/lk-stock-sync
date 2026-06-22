# LK Sneakers — Controle de Compras Internacionais (Fase 1)

Dashboard para controlar compras em StockX, GOAT, Alo Yoga, Lululemon, Nude Project,
Aimé Leon Dore e Rhode. Fluxo: **Pendente → Enviado → Entregue**, com foto + lote
obrigatórios no envio e alertas automáticos de perda.

## Rodar localmente

```bash
npm install
npm run init-db      # cria o schema
npm start            # http://localhost:3000
```

## Conceito

- **Pendente**: pedido entra aqui (manual via formulário; na Fase 2, automático via Gmail).
- **Enviado**: só é possível mover para cá após anexar ≥1 foto do vendedor E vincular a um lote.
- **Entregue**: ao marcar o lote como chegado, TODOS os pedidos dele viram entregue de uma vez.

### Semáforo de prazo (por idade desde a compra)
Cada pedido não-entregue recebe uma cor pela data da compra:
- 🟢 **Verde** — até 2 semanas (0–14 dias): no prazo.
- 🟡 **Amarelo** — 3ª e 4ª semana (15–28 dias): prazo prestes a expirar.
- 🔴 **Vermelho** — a partir de 4 semanas (28+ dias): atrasado.

A cor aparece na borda lateral do card, num badge, e nos contadores do topo.
Limiares em `src/store.js` (`SEMANAS_VERDE`, `SEMANAS_AMARELO`).

### Alerta de atraso por e-mail
Pedidos vermelhos (+4 semanas) que ainda não chegaram disparam um e-mail-resumo
com a identidade LK (logo branco, Cormorant + DM Sans). Cada pedido só é avisado
uma vez (campo `aviso_atraso_em`), então o e-mail não se repete a cada checagem.

- **Manual:** botão "Verificar Atrasos · E-mail" no dashboard, ou `GET /check-atrasos`.
- **Automático:** rode `npm run check-atrasos` via Cron do Railway.

#### Configurar envio (variáveis de ambiente)
```
SMTP_HOST=...        # ex: smtp.resend.com / smtp.gmail.com
SMTP_PORT=587
SMTP_USER=...
SMTP_PASS=...
ALERT_TO=contato@lksneakers.com.br
ALERT_FROM=LK Sneakers <contato@lksneakers.com.br>
```
> **Sem SMTP configurado o sistema roda em modo teste (dry-run):** o alerta é
> apenas logado no console, sem enviar nada. Bom para validar antes de plugar o e-mail.

#### Cron no Railway
Adicione um serviço Cron com schedule `0 12 * * *` (todo dia, 12h UTC) e comando:
```
node src/check-atrasos.js
```

## Modelo de dados
`pedidos` (1) → `itens` (N) · `pedidos` (N) → `lotes` (1)

## Deploy no Railway
1. Suba o repo (GitHub web UI).
2. Adicione um **Volume** montado em `/data`.
3. Variáveis de ambiente:
   - `DB_PATH=/data/lk-compras.db`
   - `UPLOAD_DIR=/data/uploads`
   - `PORT` → o Railway injeta sozinho.
4. Start command: `npm run init-db && npm start`.

> O Volume garante que banco e fotos sobrevivam a cada deploy (mesma lição do cache-loss
> que resolvemos no lk-estoque-web).

## Próximas fases
- **Fase 2**: parser de Gmail por loja (começar pelos Shopify — Nude, ALD, Alo, Rhode).
- **Fase 3**: relatório de perdas + cruzamento valor pago × entrada no Tiny ERP.

## Migração para Postgres
A lógica em `src/store.js` é agnóstica. Trocar `better-sqlite3` por `pg`,
ajustar `AUTOINCREMENT`/`datetime('now')` para sintaxe Postgres, manter as queries.
