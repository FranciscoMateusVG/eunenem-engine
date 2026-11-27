import type { inferRouterOutputs } from "@trpc/server";
import { type FormEvent, useCallback, useId, useState } from "react";
import { formatBRL } from "@/lib/formatBRL";
import { trpc } from "@/lib/trpc.js";
import type { AppRouter } from "../../../../../server/trpc/router.js";
import { formatInstante } from "../receita/types";

/**
 * Emissão REAL da NFS-e mensal (aperture-wp6j6).
 *
 * Nada é enviado sem dois cliques: "Emitir NFS-e" abre a confirmação com
 * ambiente, série, tomadores, total e campos fiscais; só "Confirmar emissão"
 * chama o servidor, que recalcula o plano e recusa se mudou. Cancelar exige
 * motivo e redigitar a chave de acesso.
 *
 * As partes visuais (`ConfirmacaoEmissao`, `ListaEmissoes`,
 * `FormularioCancelamento`) são puras; `NotaFiscalEmissao` liga os hooks.
 */

type Saidas = inferRouterOutputs<AppRouter>["admin"]["notaFiscal"];
export type PlanoEmissao = Saidas["planoEmissao"];
export type Emissao = Saidas["emissoes"][number];
/** Piso de competência decidido no servidor (vem na prévia do mês). */
export type PisoEmissao = Saidas["previaMensal"]["pisoEmissao"];

export const ROTULO_AMBIENTE: Record<PlanoEmissao["ambiente"], string> = {
  "1": "PRODUÇÃO (nota com valor fiscal)",
  "2": "Homologação (produção restrita, sem valor fiscal)",
};

const TEXTO_BLOQUEIO: Record<string, string> = {
  mes_em_andamento: "O mês ainda não terminou. Só meses fechados podem ser emitidos.",
  config_com_problemas: "Há variáveis NFSE_* ausentes ou inválidas.",
  config_incompleta: "Faltam NFSE_PRESTADOR_CNPJ ou NFSE_MUNICIPIO_IBGE.",
  sem_certificado: "Nenhum certificado configurado (NFSE_CERT_PATH ou NFSE_CERT_BASE64).",
  certificado_ilegivel: "O certificado não pôde ser lido (arquivo, conteúdo ou senha).",
  certificado_de_outro_cnpj: "O certificado é de outro CNPJ.",
  certificado_vencido: "O certificado está vencido.",
  tot_trib_pendente: "Total aproximado de tributos incompatível com o regime.",
  competencia_anterior_ao_inicio:
    "Em produção, competências anteriores ao início da emissão (novembro/2026) nunca são emitidas por aqui. Outubro/2026 e anteriores: nunca.",
  pendencias_de_tomador:
    "Há campanhas sem CPF/nome válido do recebedor. Enquanto houver pendência, nenhuma nota do mês é emitida.",
  producao_nao_liberada:
    "Ambiente de produção configurado, mas a emissão em produção não foi liberada (NFSE_EMISSAO_PRODUCAO).",
  sem_notas: "Não há nota a emitir neste mês.",
  cnbs_obrigatorio:
    "No leiaute da Reforma (IBS/CBS) a Receita exige o código NBS do serviço. Defina NFSE_CNBS (9 dígitos), com o contador.",
  serie_divergente:
    "NFSE_SERIE mudou depois que o mês foi emitido. As notas pendentes usam a série já reservada; volte a série configurada para a original antes de reenviar.",
  competencia_divergente:
    "O mês já foi emitido e o cálculo de hoje é diferente do que foi gravado (ex.: recebedor trocado ou valor mudou). Nada novo é emitido: reconcilie com o contador antes.",
};

const MOTIVOS_PULADA: Record<string, string> = {
  recebedor_ausente_ou_ambiguo: "Sem recebedor cadastrado",
  cpf_ausente_ou_invalido: "CPF ausente ou inválido",
  nome_ausente: "Nome do titular ausente",
  nomes_divergentes_no_cpf: "Nomes divergentes para o mesmo CPF",
  tomador_cpf_nome: "CPF/nome do tomador inválido",
  sem_endereco: "Sem endereço do titular (obrigatório no leiaute da Reforma)",
};

const TEXTO_STATUS: Record<Emissao["status"], string> = {
  pendente: "reservada, não enviada",
  enviando: "enviando…",
  incerta: "sem resposta — consulte antes de reenviar",
  rejeitada: "rejeitada",
  autorizada: "autorizada",
  cancelada: "cancelada",
};

/** DANFSe: gerado pela Consulta Pública da NFS-e (chave de acesso + captcha). */
export const CONSULTA_PUBLICA = "https://www.nfse.gov.br/consultapublica";

const MOTIVOS_CANCELAMENTO = [
  { valor: "1", rotulo: "1 — Erro na emissão" },
  { valor: "2", rotulo: "2 — Serviço não prestado" },
  { valor: "9", rotulo: "9 — Outros" },
] as const;

const BOTAO =
  "min-h-11 rounded border border-line bg-paper px-3 py-2 font-mono text-[11px] uppercase tracking-[0.1em] text-ink-soft transition-colors hover:border-plum hover:text-plum focus:outline-none focus-visible:ring-2 focus-visible:ring-plum disabled:cursor-not-allowed disabled:opacity-50";
const BOTAO_PRIMARIO =
  "min-h-11 rounded border border-plum bg-plum px-4 py-2 font-mono text-[11px] uppercase tracking-[0.1em] text-paper transition-colors hover:opacity-90 focus:outline-none focus-visible:ring-2 focus-visible:ring-plum disabled:cursor-not-allowed disabled:opacity-50";

// ────────────────────────────────────────────────────────────────────
//  Confirmação (pura)
// ────────────────────────────────────────────────────────────────────

export function ConfirmacaoEmissao({
  plano,
  enviando,
  onConfirmar,
  onVoltar,
}: {
  plano: PlanoEmissao;
  enviando: boolean;
  onConfirmar: () => void;
  onVoltar: () => void;
}) {
  const titulo = useId();
  const [ciente, setCiente] = useState(false);
  const bloqueada = plano.bloqueios.length > 0;
  const producao = plano.ambiente === "1";
  return (
    <section
      role="dialog"
      aria-labelledby={titulo}
      className="space-y-4 rounded-md border-2 border-plum bg-paper p-5"
      data-testid="nf-confirmacao"
    >
      <h3 id={titulo} className="text-lg font-semibold text-ink">
        Confirmar emissão das NFS-e de {plano.rotulo}
      </h3>
      <dl className="grid gap-2 text-[13px] sm:grid-cols-2">
        <div>
          <dt className="text-ink-mute">Ambiente</dt>
          <dd className={producao ? "font-semibold text-red-800" : "text-ink"} data-testid="nf-ambiente">
            {ROTULO_AMBIENTE[plano.ambiente]}
          </dd>
        </div>
        <div>
          <dt className="text-ink-mute">Série</dt>
          <dd className="font-mono text-ink">{plano.serie}</dd>
        </div>
        <div>
          <dt className="text-ink-mute">Notas</dt>
          <dd className="font-mono text-ink" data-testid="nf-quantidade">
            {plano.quantidade}
          </dd>
        </div>
        <div>
          <dt className="text-ink-mute">Total</dt>
          <dd className="font-mono text-ink" data-testid="nf-total">
            {formatBRL(plano.totalCents)}
          </dd>
        </div>
      </dl>

      {plano.fixada ? (
        <p className="text-[13px] text-ink-soft">
          Este mês já teve emissão. Este clique envia só as notas gravadas que ainda não foram autorizadas (com os
          valores gravados) e as pendências que já foram resolvidas.
        </p>
      ) : null}

      {bloqueada ? (
        <div role="alert" className="rounded-md border border-red-200 bg-red-50 p-4 text-[13px] text-red-800">
          <p className="font-semibold">A emissão está bloqueada:</p>
          <ul className="mt-1 list-disc pl-5">
            {plano.bloqueios.map((b) => (
              <li key={b} data-bloqueio={b}>
                {TEXTO_BLOQUEIO[b] ?? b}
              </li>
            ))}
          </ul>
          {plano.divergencias.length > 0 ? (
            <ul className="mt-2 list-disc pl-5 font-mono text-[12px]" data-testid="nf-divergencias">
              {plano.divergencias.map((d) => (
                <li key={d}>{d}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      {plano.avisos.length > 0 ? (
        <p className="text-[13px] text-amber-900">Avisos da prévia: {plano.avisos.join(", ")}.</p>
      ) : null}

      <div className="overflow-x-auto">
        <table className="min-w-full text-left text-[12px]">
          <caption className="text-left text-[13px] font-semibold text-ink">Tomadores</caption>
          <thead className="font-mono uppercase tracking-[0.1em] text-ink-mute">
            <tr>
              <th scope="col" className="py-1 pr-3">Nome</th>
              <th scope="col" className="py-1 pr-3">CPF</th>
              <th scope="col" className="py-1 pr-3">Valor</th>
              <th scope="col" className="py-1 pr-3">Endereço</th>
            </tr>
          </thead>
          <tbody>
            {plano.notas.map((n) => (
              <tr key={n.tomadorCpf} data-tomador={n.tomadorCpf}>
                <td className="py-1 pr-3 text-ink">{n.tomadorNome}</td>
                <td className="py-1 pr-3 font-mono text-ink">{n.tomadorCpf}</td>
                <td className="py-1 pr-3 font-mono text-ink">{formatBRL(n.valorCents)}</td>
                <td className="py-1 pr-3 text-ink">
                  {n.endereco ? (
                    `${n.endereco.logradouro}, ${n.endereco.numero} — CEP ${n.endereco.cep}`
                  ) : (
                    <span className="text-amber-900">sem endereço (nota sai só com CPF e nome)</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {plano.puladas.length > 0 ? (
        <div className="rounded-md border border-amber-200 bg-amber-50 p-4 text-[13px] text-amber-900" data-testid="nf-puladas">
          <p className="font-semibold">
            Ficam de fora desta emissão ({plano.puladas.length}) — dados do tomador incompletos:
          </p>
          <ul className="mt-1 list-disc pl-5">
            {plano.puladas.map((p) => (
              <li key={`${p.referencia}-${p.motivo}`}>
                {MOTIVOS_PULADA[p.motivo] ?? p.motivo} — {formatBRL(p.valorCents)}{" "}
                <span className="font-mono text-[11px]">({p.referencia})</span>
              </li>
            ))}
          </ul>
          <p className="mt-1">Podem ser emitidas depois, neste mesmo mês, quando os dados estiverem completos.</p>
        </div>
      ) : null}

      {plano.camposFiscais.length > 0 ? (
        <details className="text-[12px]">
          <summary className="cursor-pointer text-[13px] font-semibold text-ink">
            Campos fiscais de todas as notas
          </summary>
          <ul className="mt-2 grid gap-1 sm:grid-cols-2">
            {plano.camposFiscais.map((c) => (
              <li key={c.tag} data-campo-fiscal={c.tag}>
                <span className="text-ink-mute">{c.rotulo}:</span>{" "}
                <span className="break-all font-mono text-ink">{c.valor}</span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      <label className="flex items-start gap-2 text-[13px] text-ink">
        <input
          type="checkbox"
          checked={ciente}
          disabled={bloqueada}
          onChange={(e) => setCiente(e.target.checked)}
          className="mt-1"
        />
        <span>
          Conferi os tomadores, o total e os campos fiscais. Entendo que
          {producao ? " estas notas terão valor fiscal e " : " "}
          só podem ser desfeitas por cancelamento.
        </span>
      </label>

      <div className="flex flex-wrap gap-2">
        <button type="button" className={BOTAO_PRIMARIO} disabled={bloqueada || !ciente || enviando} onClick={onConfirmar}>
          {enviando ? "Emitindo…" : `Confirmar emissão de ${plano.quantidade} nota(s)`}
        </button>
        <button type="button" className={BOTAO} onClick={onVoltar} disabled={enviando}>
          Voltar
        </button>
      </div>
    </section>
  );
}

// ────────────────────────────────────────────────────────────────────
//  Lista de emissões (pura)
// ────────────────────────────────────────────────────────────────────

export function ListaEmissoes({
  emissoes,
  ocupado,
  onConsultar,
  onBaixarXml,
  onCancelar,
}: {
  emissoes: readonly Emissao[];
  ocupado: boolean;
  onConsultar: (id: string) => void;
  onBaixarXml: (e: Emissao, tipo: "dps" | "nfse") => void;
  onCancelar: (e: Emissao) => void;
}) {
  if (emissoes.length === 0) {
    return <p className="text-[13px] text-ink-soft">Nenhuma NFS-e emitida para este mês neste ambiente.</p>;
  }
  return (
    <div className="overflow-x-auto rounded-md border border-line bg-paper">
      <table className="min-w-full divide-y divide-line text-left text-[12px]">
        <thead className="bg-cream-2/60 font-mono uppercase tracking-[0.1em] text-ink-mute">
          <tr>
            <th scope="col" className="px-3 py-2">Tomador</th>
            <th scope="col" className="px-3 py-2">Valor</th>
            <th scope="col" className="px-3 py-2">DPS</th>
            <th scope="col" className="px-3 py-2">Situação</th>
            <th scope="col" className="px-3 py-2">NFS-e</th>
            <th scope="col" className="px-3 py-2">Ações</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {emissoes.map((e) => (
            <tr key={e.id} className="align-top" data-emissao={e.status}>
              <td className="px-3 py-2 text-ink">
                {e.tomadorNome}
                <div className="font-mono text-[11px] text-ink-mute">{e.tomadorCpf}</div>
              </td>
              <td className="px-3 py-2 font-mono text-ink">{formatBRL(e.valorCents)}</td>
              <td className="px-3 py-2 font-mono text-ink">
                {e.serie}/{e.nDps}
                <div className="text-[11px] text-ink-mute">{e.tentativas} tentativa(s)</div>
              </td>
              <td className="px-3 py-2 text-ink">
                {TEXTO_STATUS[e.status]}
                {e.cancelamentoStatus === "incerto" ? (
                  <div className="text-amber-900">cancelamento sem resposta — tente cancelar de novo (consulta antes)</div>
                ) : null}
                {e.cancelamentoStatus === "rejeitado" ? <div className="text-red-800">cancelamento recusado</div> : null}
                {e.erros && e.erros.length > 0 ? (
                  <ul className="mt-1 text-red-800">
                    {e.erros.map((erro) => (
                      <li key={`${erro.codigo}-${erro.descricao}`}>
                        <code className="font-mono">{erro.codigo}</code> {erro.descricao}
                        {erro.complemento ? ` (${erro.complemento})` : ""}
                      </li>
                    ))}
                  </ul>
                ) : null}
                {e.autorizadaEm ? (
                  <div className="text-[11px] text-ink-mute">autorizada em {formatInstante(e.autorizadaEm)}</div>
                ) : null}
              </td>
              <td className="px-3 py-2 font-mono text-ink">
                {e.numeroNfse ? `nº ${e.numeroNfse}` : "—"}
                {e.chaveAcesso ? <div className="break-all text-[11px] text-ink-mute">{e.chaveAcesso}</div> : null}
              </td>
              <td className="px-3 py-2">
                <div className="flex flex-wrap gap-1">
                  <button type="button" className={BOTAO} disabled={ocupado} onClick={() => onConsultar(e.id)}>
                    Consultar
                  </button>
                  {e.temDpsXml ? (
                    <button type="button" className={BOTAO} onClick={() => onBaixarXml(e, "dps")}>
                      XML DPS
                    </button>
                  ) : null}
                  {e.temNfseXml ? (
                    <button type="button" className={BOTAO} onClick={() => onBaixarXml(e, "nfse")}>
                      XML NFS-e
                    </button>
                  ) : null}
                  {e.chaveAcesso ? (
                    // A API de DANFSe do governo foi desativada em 03/08/2026
                    // (NT 008): o PDF sai na Consulta Pública, pela chave.
                    <a
                      className={BOTAO}
                      href={CONSULTA_PUBLICA}
                      target="_blank"
                      rel="noopener noreferrer"
                      title={`Chave de acesso: ${e.chaveAcesso}`}
                    >
                      Consulta Pública (DANFSe)
                    </a>
                  ) : null}
                  {e.status === "autorizada" ? (
                    <button type="button" className={BOTAO} disabled={ocupado} onClick={() => onCancelar(e)}>
                      Cancelar NFS-e
                    </button>
                  ) : null}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────
//  Cancelamento (puro)
// ────────────────────────────────────────────────────────────────────

export interface PedidoCancelamentoUi {
  readonly id: string;
  readonly motivo: "1" | "2" | "9";
  readonly texto: string;
  readonly confirmacaoChave: string;
}

export function FormularioCancelamento({
  emissao,
  enviando,
  onConfirmar,
  onVoltar,
}: {
  emissao: Emissao;
  enviando: boolean;
  onConfirmar: (pedido: PedidoCancelamentoUi) => void;
  onVoltar: () => void;
}) {
  const id = useId();
  const [motivo, setMotivo] = useState<"1" | "2" | "9">("1");
  const [texto, setTexto] = useState("");
  const [chave, setChave] = useState("");
  const textoOk = texto.trim().length >= 15 && texto.trim().length <= 255;
  const chaveOk = chave.trim() === emissao.chaveAcesso;
  const enviar = (event: FormEvent) => {
    event.preventDefault();
    if (!textoOk || !chaveOk) return;
    onConfirmar({ id: emissao.id, motivo, texto: texto.trim(), confirmacaoChave: chave.trim() });
  };
  return (
    <form
      role="dialog"
      aria-labelledby={`${id}-titulo`}
      onSubmit={enviar}
      className="space-y-3 rounded-md border-2 border-red-300 bg-paper p-5"
      data-testid="nf-cancelamento"
    >
      <h3 id={`${id}-titulo`} className="text-lg font-semibold text-ink">
        Cancelar a NFS-e nº {emissao.numeroNfse ?? "?"} de {emissao.tomadorNome}
      </h3>
      <p className="text-[13px] text-ink-soft">
        O cancelamento é registrado no Sistema Nacional e não pode ser desfeito.
      </p>
      <div className="flex flex-col gap-1">
        <label htmlFor={`${id}-motivo`} className="text-[12px] text-ink-soft">Motivo</label>
        <select
          id={`${id}-motivo`}
          value={motivo}
          onChange={(e) => setMotivo(e.target.value as "1" | "2" | "9")}
          className="min-h-11 rounded border border-line bg-paper px-3 py-2 text-[13px] text-ink"
        >
          {MOTIVOS_CANCELAMENTO.map((m) => (
            <option key={m.valor} value={m.valor}>
              {m.rotulo}
            </option>
          ))}
        </select>
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor={`${id}-texto`} className="text-[12px] text-ink-soft">
          Justificativa (15 a 255 caracteres)
        </label>
        <textarea
          id={`${id}-texto`}
          value={texto}
          onChange={(e) => setTexto(e.target.value)}
          maxLength={255}
          rows={3}
          className="rounded border border-line bg-paper px-3 py-2 text-[13px] text-ink"
        />
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor={`${id}-chave`} className="text-[12px] text-ink-soft">
          Para confirmar, digite a chave de acesso: <code className="break-all font-mono">{emissao.chaveAcesso}</code>
        </label>
        <input
          id={`${id}-chave`}
          value={chave}
          onChange={(e) => setChave(e.target.value)}
          inputMode="numeric"
          autoComplete="off"
          className="min-h-11 rounded border border-line bg-paper px-3 py-2 font-mono text-[13px] text-ink"
        />
      </div>
      <div className="flex flex-wrap gap-2">
        <button type="submit" className={BOTAO_PRIMARIO} disabled={!textoOk || !chaveOk || enviando}>
          {enviando ? "Cancelando…" : "Confirmar cancelamento"}
        </button>
        <button type="button" className={BOTAO} onClick={onVoltar} disabled={enviando}>
          Voltar
        </button>
      </div>
    </form>
  );
}

// ────────────────────────────────────────────────────────────────────
//  Ação "Emitir NFS-e" (pura)
// ────────────────────────────────────────────────────────────────────

/**
 * Botão que abre a confirmação. Desligado com o mês em andamento e, em
 * produção, abaixo do piso de competência — decisão do servidor
 * (`pisoEmissao.abaixoDoPiso`, a mesma regra que bloqueia o plano).
 */
export function AcaoEmitir({
  mesFechado,
  piso,
  ocupado,
  onEmitir,
}: {
  mesFechado: boolean;
  piso: PisoEmissao;
  ocupado: boolean;
  onEmitir: () => void;
}) {
  return (
    <>
      <button type="button" className={BOTAO_PRIMARIO} disabled={!mesFechado || piso.abaixoDoPiso || ocupado} onClick={onEmitir}>
        Emitir NFS-e
      </button>
      {!mesFechado ? <p className="basis-full text-[13px] text-ink-soft">Só é possível emitir depois que o mês terminar.</p> : null}
      {piso.abaixoDoPiso ? (
        <p className="basis-full text-[13px] text-ink-soft" data-testid="nf-abaixo-do-piso">
          Competências anteriores a {piso.rotuloMinima} não são emitidas por este sistema.
        </p>
      ) : null}
    </>
  );
}

// ────────────────────────────────────────────────────────────────────
//  Container (hooks)
// ────────────────────────────────────────────────────────────────────

function baixar(conteudo: BlobPart, tipo: string, nome: string) {
  const url = URL.createObjectURL(new Blob([conteudo], { type: tipo }));
  const link = document.createElement("a");
  link.href = url;
  link.download = nome;
  link.click();
  URL.revokeObjectURL(url);
}

export function NotaFiscalEmissao({ mes, mesFechado, piso }: { mes: string; mesFechado: boolean; piso: PisoEmissao }) {
  const utils = trpc.useUtils();
  const [confirmando, setConfirmando] = useState(false);
  const [cancelando, setCancelando] = useState<Emissao | null>(null);
  const [mensagem, setMensagem] = useState<string | null>(null);

  const emissoes = trpc.admin.notaFiscal.emissoes.useQuery({ mes }, { staleTime: 10_000 });
  const plano = trpc.admin.notaFiscal.planoEmissao.useQuery({ mes }, { enabled: confirmando, staleTime: 0 });

  const recarregar = useCallback(async () => {
    await Promise.all([utils.admin.notaFiscal.emissoes.invalidate({ mes }), utils.admin.notaFiscal.planoEmissao.invalidate({ mes })]);
  }, [utils, mes]);

  const emitir = trpc.admin.notaFiscal.emitir.useMutation({
    onSuccess: async (r) => {
      setConfirmando(false);
      const contagem = new Map<string, number>();
      for (const x of r.resultados) contagem.set(x.resultado, (contagem.get(x.resultado) ?? 0) + 1);
      setMensagem(`Resultado: ${[...contagem].map(([k, v]) => `${v} ${k}`).join(", ")}.`);
      await recarregar();
    },
    onError: async (e) => {
      setMensagem(`Não emitido: ${e.message}`);
      await recarregar();
    },
  });
  const consultar = trpc.admin.notaFiscal.consultar.useMutation({
    onSuccess: recarregar,
    onError: (e) => setMensagem(`Consulta falhou: ${e.message}`),
  });
  const cancelar = trpc.admin.notaFiscal.cancelar.useMutation({
    onSuccess: async (r) => {
      setCancelando(null);
      setMensagem(r.status === "cancelada" ? "NFS-e cancelada." : "Cancelamento não confirmado; veja a situação na lista.");
      await recarregar();
    },
    onError: (e) => setMensagem(`Cancelamento falhou: ${e.message}`),
  });

  const baixarXml = useCallback(
    async (e: Emissao, tipo: "dps" | "nfse") => {
      const r = await utils.admin.notaFiscal.xml.fetch({ id: e.id, tipo });
      if (r.xml) baixar(r.xml, "application/xml", `nfse-${e.competencia}-${e.serie}-${e.nDps}-${tipo}.xml`);
    },
    [utils],
  );

  const ocupado = emitir.isPending || consultar.isPending || cancelar.isPending;

  return (
    <section aria-label="Emissão da NFS-e" className="space-y-4 rounded-md border border-line p-5">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="mr-auto text-lg font-semibold text-ink">Emissão no Sistema Nacional</h2>
        {!confirmando ? (
          <AcaoEmitir
            mesFechado={mesFechado}
            piso={piso}
            ocupado={ocupado}
            onEmitir={() => {
              setMensagem(null);
              setConfirmando(true);
            }}
          />
        ) : null}
      </div>

      {mensagem ? (
        <p role="status" className="rounded border border-line bg-cream-2/40 p-3 text-[13px] text-ink">
          {mensagem}
        </p>
      ) : null}

      {confirmando && plano.error ? (
        <p role="alert" className="text-[13px] text-red-800">Não foi possível montar o plano: {plano.error.message}</p>
      ) : null}
      {confirmando && plano.data ? (
        <ConfirmacaoEmissao
          plano={plano.data}
          enviando={emitir.isPending}
          onVoltar={() => setConfirmando(false)}
          onConfirmar={() =>
            emitir.mutate({ mes, confirmacao: { impressao: plano.data.impressao } })
          }
        />
      ) : null}
      {confirmando && !plano.data && !plano.error ? <p role="status" className="text-[12px] text-ink-mute">montando o plano…</p> : null}

      {cancelando ? (
        <FormularioCancelamento
          emissao={cancelando}
          enviando={cancelar.isPending}
          onVoltar={() => setCancelando(null)}
          onConfirmar={(pedido) => cancelar.mutate(pedido)}
        />
      ) : null}

      {emissoes.error ? <p role="alert" className="text-[13px] text-red-800">{emissoes.error.message}</p> : null}
      {emissoes.data ? (
        <ListaEmissoes
          emissoes={emissoes.data}
          ocupado={ocupado}
          onConsultar={(id) => consultar.mutate({ id })}
          onBaixarXml={(e, tipo) => void baixarXml(e, tipo)}
          onCancelar={(e) => {
            setMensagem(null);
            setCancelando(e);
          }}
        />
      ) : null}
    </section>
  );
}
