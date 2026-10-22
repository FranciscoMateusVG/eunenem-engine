import { sql } from 'kysely';
import type { Database } from '../../../src/adapters/database.js';

export async function getPrivacy(db: Database, campaignId: string): Promise<boolean> {
  const { rows } = await sql<{ exibir_recados: boolean }>`SELECT exibir_recados FROM campanha_privacidade WHERE campanha_id=${campaignId}`.execute(db);
  return rows[0]?.exibir_recados ?? true;
}
export async function approvedMessages(db: Database, campaignId: string): Promise<Set<string>> {
  const { rows } = await sql<{ pagamento_id: string }>`SELECT pagamento_id FROM recado_moderacao WHERE campanha_id=${campaignId} AND aprovado=true`.execute(db);
  return new Set(rows.map((r) => r.pagamento_id));
}

/** Apply approval BEFORE the public limit; pending recent rows must not hide approved older ones. */
export async function publicMessages(db: Database, campaignId: string) {
  const { rows } = await sql<{ id: string; contribuinteNome: string; mensagem: string; criadoEm: Date }>`
    SELECT p.id, p.intencao_contribuinte_nome AS "contribuinteNome", p.intencao_contribuinte_mensagem AS mensagem, p.criado_em AS "criadoEm"
    FROM pagamentos p JOIN recado_moderacao m ON m.pagamento_id=p.id AND m.campanha_id=p.intencao_id_campanha
    WHERE p.intencao_id_campanha=${campaignId} AND p.status='aprovado' AND m.aprovado=true
      AND p.intencao_contribuinte_nome IS NOT NULL AND btrim(p.intencao_contribuinte_mensagem)<>''
    ORDER BY p.criado_em DESC, p.id LIMIT 50`.execute(db);
  return rows.map((r) => ({ ...r, criadoEm: r.criadoEm.toISOString() }));
}
