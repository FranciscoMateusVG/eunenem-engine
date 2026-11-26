/**
 * nfse-smoke-seed (aperture-wp6j6) — prepara o smoke de HOMOLOGAÇÃO da NFS-e
 * num Postgres LOCAL e DESCARTÁVEL: UMA campanha sintética com UM recebedor
 * fictício (CPF de teste com DV válido e nome fictício; sem endereço) e UMA
 * taxa da plataforma num mês passado. Nenhum CPF de cliente real vai para o ambiente de testes
 * da Receita.
 *
 * Segurança:
 *   - exige --banco-descartavel (localhost só prova o endereço, não que o
 *     banco é descartável: um port-forward pode chegar em outro banco);
 *   - recusa DATABASE_URL que não seja localhost/127.0.0.1;
 *   - recusa se o mês escolhido já tem taxa de OUTRA campanha (a emissão
 *     pegaria esses tomadores também) — escolha outro --mes;
 *   - idempotente: se a campanha sintética do mês já existe COM o recebedor
 *     fictício (CPF/nome conferidos), não cria outra; se o título existe com
 *     outro recebedor, recusa.
 *
 * Uso (da raiz):
 *   DATABASE_URL=postgresql://frame:frame@localhost:54320/frame \
 *     pnpm tsx scripts/nfse-smoke-seed.ts --banco-descartavel [--mes 2025-01] [--taxa 1234]
 */
import { parseArgs } from 'node:util';
import { sql } from 'kysely';
import { createDatabase } from '../src/adapters/database.js';
import { ID_PLATAFORMA_EUNENEM } from '../src/index.js';
import { ReceitaLedgerSeed } from '../tests/helpers/receita-ledger-seed.js';

/** CPF de teste (DV válido), amplamente usado como exemplo; não é de cliente. */
const CPF_FICTICIO = '52998224725';
const TITULO = 'NFSE SMOKE SINTETICO';
const NOME_FICTICIO = 'Tomador Ficticio de Teste';

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      mes: { type: 'string', default: '2025-01' },
      taxa: { type: 'string', default: '1234' },
      'banco-descartavel': { type: 'boolean', default: false },
    },
  });
  if (!values['banco-descartavel']) {
    throw new Error(
      'Recusado: passe --banco-descartavel para confirmar que o banco é local e descartável.',
    );
  }
  const mes = values.mes ?? '2025-01';
  const taxaCents = Number(values.taxa);
  if (!/^20\d{2}-(0[1-9]|1[0-2])$/.test(mes)) throw new Error('--mes deve ser AAAA-MM');
  if (!Number.isSafeInteger(taxaCents) || taxaCents <= 0)
    throw new Error('--taxa deve ser centavos > 0');

  const url = process.env.DATABASE_URL ?? '';
  const host = (() => {
    try {
      return new URL(url).hostname;
    } catch {
      return '';
    }
  })();
  if (host !== 'localhost' && host !== '127.0.0.1') {
    throw new Error(
      'Recusado: DATABASE_URL precisa apontar para um Postgres local (localhost/127.0.0.1).',
    );
  }

  const db = createDatabase(url);
  try {
    const de = `${mes}-01`;
    const [ano, m] = mes.split('-').map(Number) as [number, number];
    const ate = m === 12 ? `${ano + 1}-01-01` : `${ano}-${String(m + 1).padStart(2, '0')}-01`;
    // Recebedor MAIS RECENTE de cada campanha (mesma ordem da prévia/plano).
    const noMes = (
      await sql<{ campanha_id: string; titulo: string; cpf: string | null; nome: string | null }>`
      SELECT c.id AS campanha_id, c.titulo, r.cpf_titular AS cpf, r.nome_titular AS nome
      FROM campanhas c
      LEFT JOIN LATERAL (
        SELECT cpf_titular, nome_titular FROM recebedores
        WHERE campanha_id = c.id ORDER BY criada_em DESC, id DESC LIMIT 1
      ) r ON true
      WHERE EXISTS (
        SELECT 1 FROM lancamentos_financeiros l JOIN pagamentos p ON p.id = l.id_pagamento
        WHERE p.intencao_id_campanha = c.id AND l.tipo = 'credito_receita_plataforma'
          AND l.criado_em >= (${de}::date::timestamp AT TIME ZONE 'America/Sao_Paulo')
          AND l.criado_em < (${ate}::date::timestamp AT TIME ZONE 'America/Sao_Paulo')
      )
    `.execute(db)
    ).rows;
    const sintetica = (r: (typeof noMes)[number]) =>
      r.titulo === `${TITULO} ${mes}` && r.cpf === CPF_FICTICIO && r.nome === NOME_FICTICIO;
    const outras = noMes.filter((r) => !sintetica(r));
    if (outras.length > 0) {
      throw new Error(
        `Recusado: ${outras.length} outra(s) campanha(s) têm taxa em ${mes}. Use outro --mes.`,
      );
    }
    if (noMes.length > 0) {
      console.log(
        `[nfse-smoke-seed] já semeado para ${mes} (campanha ${noMes[0]?.campanha_id}). Nada feito.`,
      );
      return;
    }

    const seed = new ReceitaLedgerSeed(db);
    const idCampanha = await seed.campanha(ID_PLATAFORMA_EUNENEM);
    await sql`UPDATE campanhas SET titulo = ${`${TITULO} ${mes}`} WHERE id = ${idCampanha}::uuid`.execute(
      db,
    );
    await sql`
      INSERT INTO recebedores (id, campanha_id, metodo, nome_titular, cpf_titular, tipo_chave_pix, chave_pix, is_active, criada_em)
      VALUES (gen_random_uuid(), ${idCampanha}::uuid, 'pix', ${NOME_FICTICIO}, ${CPF_FICTICIO}, 'email',
        'smoke@example.invalid', true, now())
    `.execute(db);
    // Meio do mês, 15h UTC (12h em São Paulo): longe das bordas.
    await seed.taxa({
      campaignId: idCampanha,
      taxaCents,
      criadoEm: new Date(`${mes}-15T15:00:00Z`),
    });
    console.log(
      `[nfse-smoke-seed] campanha ${idCampanha}: taxa de ${taxaCents} centavos em ${mes}, tomador fictício.`,
    );
  } finally {
    await db.destroy();
  }
}

main().catch((e: unknown) => {
  console.error(`[nfse-smoke-seed] ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
});
