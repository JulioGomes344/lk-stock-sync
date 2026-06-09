// Verifica pedidos atrasados (+4 semanas) e dispara um único e-mail-resumo.
// Marca cada pedido como avisado para não repetir o alerta diariamente.
//
// Railway: configure um Cron Schedule (ex: "0 12 * * *" = todo dia 12h UTC)
// com o comando:  node src/check-atrasos.js
import { pedidosAtrasadosNaoAvisados, marcarAvisoEnviado } from './store.js';
import { enviarAlertaAtraso } from './email.js';
import { initDb } from './init-db.js';

initDb(); // garante schema (cron pode rodar em container separado)


const atrasados = pedidosAtrasadosNaoAvisados();

if (atrasados.length === 0) {
  console.log('✓ Nenhum pedido atrasado pendente de aviso.');
  process.exit(0);
}

const r = await enviarAlertaAtraso(atrasados);
if (r.enviado || r.dryRun) {
  atrasados.forEach(p => marcarAvisoEnviado(p.id));
  console.log(`✓ ${atrasados.length} pedido(s) processado(s) e marcado(s) como avisado(s).`);
}
process.exit(0);
