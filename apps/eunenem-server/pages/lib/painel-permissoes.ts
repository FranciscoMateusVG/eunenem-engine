// aperture-1z18g (kpesy-04) — what a shared-campanha member sees on the painel
// dashboard. Pure: PainelPage feeds it `useAcessoCampanha(...).pode`. UI-only;
// every action is also enforced server-side.
import type { AcaoCampanha } from "../../../../src/domain/arrecadacao/value-objects/permissao-campanha.js";
import type { PainelMenuGroup } from "./mocks/painelDemo";

export type PodeAcao = (acao: AcaoCampanha) => boolean;

/** Menu row id → action required to see it. Rows not listed are open to every admin. */
export const ACAO_POR_ITEM_MENU: Readonly<Record<string, AcaoCampanha>> = {
  presentes: "extrato:ver",
  convite: "convite:editar",
  "lista-convidados": "convidados:ver",
  mensagens: "mensagens:ver",
  perfil: "perfil:editar",
  compartilhar: "membros:gerenciar",
  bancarios: "recebedor:gerenciar",
};

/** Drops rows the caller can't use; drops groups left empty. */
export function filtrarMenuPorAcesso(groups: PainelMenuGroup[], pode: PodeAcao): PainelMenuGroup[] {
  return groups
    .map((g) => ({
      ...g,
      items: g.items.filter((item) => {
        const acao = ACAO_POR_ITEM_MENU[item.id];
        return acao === undefined || pode(acao);
      }),
    }))
    .filter((g) => g.items.length > 0);
}

export interface VisibilidadeRecebido {
  /** "recebido até agora" + amount. */
  valor: boolean;
  /** "resgatar valores" pill (lands on the statement, where the transfer lives). */
  resgatar: boolean;
  /** Strip cells. presentes/recados counts come from the financial summary. */
  presentes: boolean;
  confirmados: boolean;
  recados: boolean;
  /** Render the card at all. */
  card: boolean;
}

export function visibilidadeRecebido(pode: PodeAcao): VisibilidadeRecebido {
  const extrato = pode("extrato:ver");
  const v = {
    valor: extrato,
    resgatar: extrato && pode("saque:solicitar"),
    presentes: extrato,
    confirmados: pode("convidados:ver"),
    recados: extrato,
  };
  return { ...v, card: v.valor || v.confirmados };
}

/** Owner / pre-sharing default: everything visible. */
export const VISIBILIDADE_TOTAL: VisibilidadeRecebido = {
  valor: true,
  resgatar: true,
  presentes: true,
  confirmados: true,
  recados: true,
  card: true,
};
