import type { inferRouterOutputs } from "@trpc/server";
import { useCallback } from "react";
import { formatBRL } from "@/lib/formatBRL";
import { trpc } from "@/lib/trpc.js";
import type { AppRouter } from "../../../../../server/trpc/router.js";

/**
 * aperture-xdylg — listas com taxa no mês e cadastro fiscal incompleto, para
 * a equipe cobrar o cadastro (CPF + endereço do titular são obrigatórios
 * para a NFS-e). Não mostra CPF: só o motivo. Exporta CSV.
 */

export type CadastroIncompleto =
  inferRouterOutputs<AppRouter>["admin"]["notaFiscal"]["cadastrosIncompletos"][number];

export const TEXTO_MOTIVO: Record<CadastroIncompleto["motivos"][number], string> = {
  sem_recebedor: "sem dados de recebimento",
  cpf_invalido: "CPF ausente ou inválido",
  nome_ausente: "nome do titular ausente",
  sem_endereco: "sem endereço",
};

function celula(valor: string): string {
  // RFC 4180 + neutraliza fórmula em planilha (=, +, -, @ no início).
  const seguro = /^[=+\-@]/.test(valor) ? `'${valor}` : valor;
  return /[",\n\r;]/.test(seguro) ? `"${seguro.replace(/"/g, '""')}"` : seguro;
}

/** CSV (separador vírgula, UTF-8 com BOM para o Excel abrir acentos). */
export function csvCadastrosIncompletos(lista: readonly CadastroIncompleto[]): string {
  const linhas = [
    ["campanha", "id_campanha", "responsaveis", "emails", "taxa_reais", "pendencias"],
    ...lista.map((l) => [
      l.campanhaTitulo,
      l.campanhaId,
      l.responsaveis.map((r) => r.nome).join("; "),
      l.responsaveis.map((r) => r.email).join("; "),
      (l.taxaCents / 100).toFixed(2),
      l.motivos.map((m) => TEXTO_MOTIVO[m]).join("; "),
    ]),
  ];
  return `﻿${linhas.map((cols) => cols.map(celula).join(",")).join("\r\n")}\r\n`;
}

const BOTAO =
  "min-h-11 rounded border border-line bg-paper px-3 py-2 font-mono text-[11px] uppercase tracking-[0.1em] text-ink-soft transition-colors hover:border-plum hover:text-plum focus:outline-none focus-visible:ring-2 focus-visible:ring-plum";

export function TabelaCadastrosIncompletos({
  lista,
  onBaixarCsv,
}: {
  lista: readonly CadastroIncompleto[];
  onBaixarCsv: () => void;
}) {
  if (lista.length === 0) {
    return <p className="text-[13px] text-ink-soft">Nenhuma lista com taxa neste mês está com cadastro incompleto.</p>;
  }
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <p className="mr-auto text-[13px] text-ink-soft">
          {lista.length} lista(s) com taxa no mês e cadastro fiscal incompleto.
        </p>
        <button type="button" className={BOTAO} onClick={onBaixarCsv}>
          Baixar CSV
        </button>
      </div>
      <div className="overflow-x-auto rounded-md border border-line bg-paper">
        <table className="min-w-full divide-y divide-line text-left text-[12px]">
          <thead className="bg-cream-2/60 font-mono uppercase tracking-[0.1em] text-ink-mute">
            <tr>
              <th scope="col" className="px-3 py-2">Lista</th>
              <th scope="col" className="px-3 py-2">Responsáveis</th>
              <th scope="col" className="px-3 py-2">Taxa no mês</th>
              <th scope="col" className="px-3 py-2">Falta</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {lista.map((l) => (
              <tr key={l.campanhaId} className="align-top" data-cadastro-incompleto={l.campanhaId}>
                <td className="px-3 py-2 text-ink">{l.campanhaTitulo}</td>
                <td className="px-3 py-2 text-ink">
                  {l.responsaveis.length === 0
                    ? "—"
                    : l.responsaveis.map((r) => (
                        <div key={r.email}>
                          {r.nome} <span className="font-mono text-[11px] text-ink-mute">{r.email}</span>
                        </div>
                      ))}
                </td>
                <td className="px-3 py-2 font-mono text-ink">{formatBRL(l.taxaCents)}</td>
                <td className="px-3 py-2 text-ink">{l.motivos.map((m) => TEXTO_MOTIVO[m]).join(", ")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function CadastrosIncompletos({ mes }: { mes: string }) {
  const query = trpc.admin.notaFiscal.cadastrosIncompletos.useQuery({ mes }, { staleTime: 30_000 });
  const lista = query.data;
  const baixar = useCallback(() => {
    if (!lista) return;
    const url = URL.createObjectURL(new Blob([csvCadastrosIncompletos(lista)], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `cadastros-incompletos-${mes}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  }, [lista, mes]);
  return (
    <section aria-label="Cadastros incompletos" className="space-y-3 rounded-md border border-line p-5">
      <h2 className="text-lg font-semibold text-ink">Cadastros incompletos (CPF / endereço)</h2>
      {query.error ? <p role="alert" className="text-[13px] text-red-800">{query.error.message}</p> : null}
      {lista ? <TabelaCadastrosIncompletos lista={lista} onBaixarCsv={baixar} /> : null}
    </section>
  );
}
