import type { Database } from '../../../src/index.js';

/**
 * aperture-bqvb5 — quem pode ser agradecido numa lista: presentes pagos
 * (status `aprovado`, ou seja, não estornados) com contribuinte identificado.
 * Uma pessoa = um e-mail (sem diferenciar maiúsculas); o e-mail nunca sai
 * do servidor, a tela trabalha só com os ids dos pagamentos.
 */
interface PagamentoAgradecivel {
  readonly id: string;
  readonly nome: string;
  readonly email: string;
  readonly agradecidoEm: Date | null;
}

async function pagamentosAgradeciveis(
  db: Database,
  idCampanha: string,
  idsPagamento?: readonly string[],
): Promise<PagamentoAgradecivel[]> {
  let query = db
    .selectFrom('pagamentos as p')
    .leftJoin('agradecimentos_presentes as a', 'a.id_pagamento', 'p.id')
    .select([
      'p.id',
      'p.intencao_contribuinte_nome as nome',
      'p.intencao_contribuinte_email as email',
      'a.agradecido_em',
    ])
    .where('p.intencao_id_campanha', '=', idCampanha)
    .where('p.status', '=', 'aprovado')
    .where('p.intencao_contribuinte_email', 'is not', null)
    .orderBy('p.criado_em', 'desc')
    .orderBy('p.id', 'asc');
  if (idsPagamento) query = query.where('p.id', 'in', idsPagamento);
  const rows = await query.execute();
  return rows.flatMap((row) =>
    row.email?.trim()
      ? [
          {
            id: row.id,
            nome: row.nome?.trim() ?? '',
            email: row.email.trim(),
            agradecidoEm: row.agradecido_em,
          },
        ]
      : [],
  );
}

interface Pessoa {
  readonly nome: string;
  readonly email: string;
  readonly pagamentos: PagamentoAgradecivel[];
}

function agruparPorPessoa(pagamentos: readonly PagamentoAgradecivel[]): Pessoa[] {
  const pessoas = new Map<string, Pessoa>();
  for (const pagamento of pagamentos) {
    const chave = pagamento.email.toLowerCase();
    const pessoa = pessoas.get(chave);
    if (pessoa) pessoa.pagamentos.push(pagamento);
    // Pagamentos vêm do mais recente: o nome mais recente representa a pessoa.
    else pessoas.set(chave, { nome: pagamento.nome, email: pagamento.email, pagamentos: [pagamento] });
  }
  return [...pessoas.values()];
}

export interface PessoaAgradecivelDTO {
  readonly nome: string;
  /** Mais recente primeiro; `idsPagamento[0]` identifica a pessoa na tela. */
  readonly idsPagamento: string[];
  readonly presentes: string[];
  /** ISO do último agradecimento — null enquanto algum presente dela não foi agradecido. */
  readonly agradecidoEm: string | null;
}

export async function listarPessoasAgradeciveis(
  db: Database,
  idCampanha: string,
): Promise<PessoaAgradecivelDTO[]> {
  const pessoas = agruparPorPessoa(await pagamentosAgradeciveis(db, idCampanha));
  const ids = pessoas.flatMap((p) => p.pagamentos.map((pg) => pg.id));
  const itens = ids.length
    ? await db
        .selectFrom('intencao_items as i')
        .innerJoin('contribuicoes as c', 'c.id', 'i.id_contribuicao')
        .select(['i.id_pagamento', 'c.nome'])
        .where('i.id_pagamento', 'in', ids)
        .where('i.tipo', '=', 'contribuicao')
        .orderBy('i.position', 'asc')
        .execute()
    : [];
  return pessoas.map((pessoa) => {
    const meus = new Set(pessoa.pagamentos.map((pg) => pg.id));
    const datas = pessoa.pagamentos.map((pg) => pg.agradecidoEm);
    const todosAgradecidos = datas.every((d): d is Date => d !== null);
    return {
      nome: pessoa.nome,
      idsPagamento: pessoa.pagamentos.map((pg) => pg.id),
      presentes: [...new Set(itens.filter((i) => meus.has(i.id_pagamento)).map((i) => i.nome))],
      agradecidoEm: todosAgradecidos
        ? new Date(Math.max(...datas.map((d) => d.getTime()))).toISOString()
        : null,
    };
  });
}

export interface Destinatario {
  readonly nome: string;
  readonly email: string;
  readonly idsPagamento: readonly string[];
}

/**
 * Resolve os ids escolhidos na tela em destinatários (um por e-mail).
 * `null` quando algum id não é um presente agradecível DESTA lista — o
 * chamador recusa o pedido inteiro, sem revelar qual id falhou.
 */
export async function resolverDestinatarios(
  db: Database,
  idCampanha: string,
  idsPagamento: readonly string[],
): Promise<Destinatario[] | null> {
  const unicos = [...new Set(idsPagamento)];
  const pagamentos = await pagamentosAgradeciveis(db, idCampanha, unicos);
  if (pagamentos.length !== unicos.length) return null;
  return agruparPorPessoa(pagamentos).map((p) => ({
    nome: p.nome,
    email: p.email,
    idsPagamento: p.pagamentos.map((pg) => pg.id),
  }));
}

export async function registrarAgradecimento(
  db: Database,
  idCampanha: string,
  idsPagamento: readonly string[],
  agradecidoEm: Date,
): Promise<void> {
  if (idsPagamento.length === 0) return;
  await db
    .insertInto('agradecimentos_presentes')
    .values(
      idsPagamento.map((id) => ({
        id_pagamento: id,
        id_campanha: idCampanha,
        agradecido_em: agradecidoEm,
      })),
    )
    .onConflict((oc) => oc.column('id_pagamento').doUpdateSet({ agradecido_em: agradecidoEm }))
    .execute();
}
