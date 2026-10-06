import type { inferRouterOutputs } from "@trpc/server";
import { useCallback, useState } from "react";
import { formatBRL } from "@/lib/formatBRL";
import type { AppRouter } from "../../../../../server/trpc/router.js";
import { InconsistenciasAviso } from "../receita/ReceitaAvisos";
import { ReceitaPorMeioProvedor } from "../receita/ReceitaTabelas";
import { formatInstante, ROTULOS } from "../receita/types";

/**
 * Prévia da NFS-e mensal (aperture-dh1k7) — painel puro de UMA resposta de
 * `admin.notaFiscal.previaMensal`.
 *
 * PRÉVIA: nada aqui envia, emite ou cancela nota. Não existe botão de emitir.
 * Campos que ninguém confirmou aparecem marcados "a confirmar".
 */

export type NotaFiscalPrevia = inferRouterOutputs<AppRouter>["admin"]["notaFiscal"]["previaMensal"];
type Dps = NotaFiscalPrevia["dps"];
type DpsGerada = Extract<Dps, { status: "gerada" }>;
type Campo = DpsGerada["campos"][number];
type Aviso = NotaFiscalPrevia["avisos"][number];

const TEXTO_AVISO: Record<Aviso, string> = {
  mes_em_andamento:
    "O mês ainda não terminou. O valor vai mudar até o fim do mês; a nota de verdade só faz sentido com o mês fechado.",
  resultado_nao_positivo:
    "O resultado de taxas do mês é zero ou negativo. Não há nota a emitir e nenhuma DPS foi gerada.",
  config_com_problemas: "Há variáveis NFSE_* ausentes ou inválidas (lista abaixo).",
  xml_nao_assinado:
    "O XML abaixo NÃO está assinado. Ele mostra o conteúdo da nota, mas não seria aceito pelo Sistema Nacional assim.",
  certificado_de_outro_cnpj:
    "O CNPJ do certificado não confere com NFSE_PRESTADOR_CNPJ. A assinatura seria recusada.",
  certificado_vencido: "O certificado configurado está vencido.",
  inconsistencias_no_periodo:
    "Há linhas incoerentes no ledger deste mês (detalhes abaixo). Nenhum total foi ajustado.",
  detalhamento_nao_concilia:
    "A soma por meio de pagamento difere do total do mês. O valor da nota usa o total.",
  tot_trib_pendente:
    "O total aproximado de tributos não é compatível com o regime tributário configurado: o Sistema Nacional recusaria esta DPS. Veja o campo totTrib abaixo e defina os percentuais com o contador.",
};

const ROTULO_ORIGEM: Record<Campo["origem"], string> = {
  ledger: "ledger",
  env: "configurado",
  default: "padrão",
  derivado: "calculado",
  fixo: "fixo",
};

export function NotaFiscalPainel({ data }: { data: NotaFiscalPrevia }) {
  const somaMeios = data.porMeioProvedor.reduce(
    (acc, row) => ({
      taxasRegistradasCents: acc.taxasRegistradasCents + row.taxasRegistradasCents,
      cancelamentosCents: acc.cancelamentosCents + row.cancelamentosCents,
    }),
    { taxasRegistradasCents: 0, cancelamentosCents: 0 },
  );
  return (
    <div className="space-y-8">
      {data.avisos.length > 0 ? (
        <div
          role="status"
          className="rounded-md border border-amber-200 bg-amber-50 p-4 text-[13px] leading-relaxed text-amber-900"
        >
          <p className="font-semibold">Atenção</p>
          <ul className="mt-2 list-disc space-y-1 pl-5">
            {data.avisos.map((aviso) => (
              <li key={aviso} data-aviso={aviso}>
                {TEXTO_AVISO[aviso]}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <ValorDoMes data={data} />
      <InconsistenciasAviso inconsistencias={data.inconsistencias} />
      <ReceitaPorMeioProvedor rows={data.porMeioProvedor} soma={somaMeios} />
      <ProblemasDeConfiguracao problemas={data.configuracao.problemas} />
      <SecaoDps dps={data.dps} mes={data.mes} />
    </div>
  );
}

function ValorDoMes({ data }: { data: NotaFiscalPrevia }) {
  const { valor } = data;
  return (
    <section aria-labelledby="nf-valor-title" className="space-y-3">
      <h2 id="nf-valor-title" className="text-lg font-semibold text-ink">
        Valor da nota de {data.rotulo}
      </h2>
      <div className="rounded-md border border-line bg-paper p-5">
        <p className="font-mono text-[11px] uppercase tracking-[0.12em] text-ink-mute">
          {ROTULOS.resultado} · valor do serviço
        </p>
        <p className="mt-1 font-mono text-3xl font-semibold tabular-nums text-ink" data-testid="nf-valor">
          {formatBRL(valor.resultadoDeTaxasCents)}
        </p>
        <dl className="mt-4 grid gap-3 text-[13px] sm:grid-cols-3">
          <div>
            <dt className="text-ink-mute">{ROTULOS.registradas}</dt>
            <dd className="font-mono tabular-nums text-ink">
              {formatBRL(valor.taxasRegistradasCents)}{" "}
              <span className="text-ink-mute">({valor.lancamentosRegistrados} lançamentos)</span>
            </dd>
          </div>
          <div>
            <dt className="text-ink-mute">{ROTULOS.cancelamentos}</dt>
            <dd className="font-mono tabular-nums text-ink">
              − {formatBRL(valor.cancelamentosCents)}{" "}
              <span className="text-ink-mute">({valor.lancamentosCancelados} lançamentos)</span>
            </dd>
          </div>
          <div>
            <dt className="text-ink-mute">Pagamentos com taxa</dt>
            <dd className="font-mono tabular-nums text-ink">{valor.pagamentosComTaxa}</dd>
          </div>
        </dl>
        <p className="mt-4 text-[12px] leading-relaxed text-ink-soft">
          Mesmo número da tela Receita para {data.periodo.de} a {data.periodo.ate} (exclusivo),
          horário de São Paulo: taxas pela data em que foram registradas, cancelamentos pela data em
          que ocorreram. {ROTULOS.adicional}: {formatBRL(data.adicionalCartao.registradoCents)}{" "}
          registrado, {formatBRL(data.adicionalCartao.canceladoCents)} cancelado — fora do valor.
        </p>
        <p className="mt-2 font-mono text-[11px] text-ink-mute">
          Leitura de {formatInstante(data.snapshotAt)} (horário de São Paulo).
        </p>
      </div>
    </section>
  );
}

function ProblemasDeConfiguracao({
  problemas,
}: {
  problemas: NotaFiscalPrevia["configuracao"]["problemas"];
}) {
  if (problemas.length === 0) return null;
  return (
    <section aria-labelledby="nf-config-title" className="space-y-2">
      <h2 id="nf-config-title" className="text-lg font-semibold text-ink">
        Configuração
      </h2>
      <ul className="list-disc space-y-1 pl-5 text-[13px] text-ink-soft">
        {problemas.map((p) => (
          <li key={p.variavel}>
            <code className="font-mono text-ink">{p.variavel}</code>{" "}
            {p.motivo === "ausente" ? "não definida" : "com valor inválido (usando o padrão)"}
          </li>
        ))}
      </ul>
    </section>
  );
}

function SecaoDps({ dps, mes }: { dps: Dps; mes: string }) {
  return (
    <section aria-labelledby="nf-dps-title" className="space-y-4">
      <h2 id="nf-dps-title" className="text-lg font-semibold text-ink">
        DPS que seria enviada
      </h2>
      {dps.status === "sem_valor" ? (
        <p className="rounded-md border border-line bg-paper p-5 text-[14px] text-ink-soft">
          Sem DPS: o resultado de taxas do mês não é positivo, então não há nota a emitir.
        </p>
      ) : null}
      {dps.status === "config_incompleta" ? (
        <div className="rounded-md border border-red-200 bg-red-50 p-4 text-[13px] text-red-800">
          <p className="font-semibold">Sem DPS: faltam dados do prestador.</p>
          <p className="mt-1">
            Defina{" "}
            {dps.faltando.map((v, i) => (
              <span key={v}>
                {i > 0 ? ", " : ""}
                <code className="font-mono">{v}</code>
              </span>
            ))}{" "}
            no ambiente do servidor.
          </p>
        </div>
      ) : null}
      {dps.status === "gerada" ? <DpsGeradaView dps={dps} mes={mes} /> : null}
    </section>
  );
}

function SeloAssinatura({ assinatura }: { assinatura: DpsGerada["assinatura"] }) {
  if (assinatura.status === "assinada") {
    return (
      <p className="text-[13px] text-ink-soft" data-testid="nf-assinatura">
        <span className="rounded bg-emerald-100 px-2 py-0.5 font-mono text-[11px] uppercase tracking-[0.1em] text-emerald-900">
          assinada
        </span>{" "}
        com o certificado {assinatura.certificadoCnpj ? `do CNPJ ${assinatura.certificadoCnpj}` : "configurado"},
        válido até {formatInstante(assinatura.certificadoValidoAte)}.
      </p>
    );
  }
  return (
    <p className="text-[13px] text-ink-soft" data-testid="nf-assinatura">
      <span className="rounded bg-red-100 px-2 py-0.5 font-mono text-[11px] uppercase tracking-[0.1em] text-red-900">
        não assinada
      </span>{" "}
      {assinatura.motivo === "sem_certificado"
        ? "Nenhum certificado configurado (NFSE_CERT_PATH ou NFSE_CERT_BASE64)."
        : "O certificado configurado não pôde ser lido (arquivo, conteúdo ou senha)."}
    </p>
  );
}

function DpsGeradaView({ dps, mes }: { dps: DpsGerada; mes: string }) {
  const grupos: string[] = [];
  for (const campo of dps.campos) if (!grupos.includes(campo.grupo)) grupos.push(campo.grupo);
  const aConfirmar = dps.campos.filter((c) => c.aConfirmar).length;
  return (
    <div className="space-y-4">
      <SeloAssinatura assinatura={dps.assinatura} />
      <p className="text-[13px] text-ink-soft">
        Identificador <code className="break-all font-mono text-ink">{dps.idDps}</code>. Série e
        número são de prévia e não consomem a numeração real.{" "}
        {aConfirmar > 0 ? (
          <strong className="font-semibold text-amber-900">
            {aConfirmar} campo(s) a confirmar.
          </strong>
        ) : null}
      </p>
      <div className="overflow-x-auto rounded-md border border-line bg-paper">
        <table className="min-w-full divide-y divide-line text-left text-[12px]">
          <thead className="bg-cream-2/60 font-mono uppercase tracking-[0.12em] text-ink-mute">
            <tr>
              <th scope="col" className="px-3 py-2">
                Campo
              </th>
              <th scope="col" className="px-3 py-2">
                Valor
              </th>
              <th scope="col" className="px-3 py-2">
                Origem
              </th>
              <th scope="col" className="px-3 py-2">
                Observação
              </th>
            </tr>
          </thead>
          {grupos.map((grupo) => (
            <tbody key={grupo} className="divide-y divide-line">
              <tr className="bg-cream-2/30">
                <th
                  scope="colgroup"
                  colSpan={4}
                  className="px-3 py-2 font-mono text-[11px] uppercase tracking-[0.12em] text-ink-mute"
                >
                  {grupo}
                </th>
              </tr>
              {dps.campos
                .filter((c) => c.grupo === grupo)
                .map((campo) => (
                  <tr key={campo.tag} className="align-top" data-campo={campo.tag}>
                    <th scope="row" className="px-3 py-2 font-normal text-ink">
                      {campo.rotulo}
                      <div className="font-mono text-[11px] text-ink-mute">{campo.tag}</div>
                    </th>
                    <td className="break-all px-3 py-2 font-mono text-ink">{campo.valor}</td>
                    <td className="whitespace-nowrap px-3 py-2 text-ink-soft">
                      {ROTULO_ORIGEM[campo.origem]}
                      {campo.aConfirmar ? (
                        <span
                          className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.08em] text-amber-900"
                          data-a-confirmar="true"
                        >
                          a confirmar
                        </span>
                      ) : null}
                    </td>
                    <td className="min-w-[16rem] px-3 py-2 text-ink-soft">{campo.nota ?? ""}</td>
                  </tr>
                ))}
            </tbody>
          ))}
        </table>
      </div>
      <XmlDaDps xml={dps.xml} mes={mes} assinada={dps.assinatura.status === "assinada"} />
    </div>
  );
}

const BOTAO =
  "min-h-11 rounded border border-line bg-paper px-3 py-2 font-mono text-[11px] uppercase tracking-[0.1em] text-ink-soft transition-colors hover:border-plum hover:text-plum focus:outline-none focus-visible:ring-2 focus-visible:ring-plum";

function XmlDaDps({ xml, mes, assinada }: { xml: string; mes: string; assinada: boolean }) {
  const [copiado, setCopiado] = useState<"ok" | "erro" | null>(null);

  const copiar = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(xml);
      setCopiado("ok");
    } catch {
      setCopiado("erro");
    }
  }, [xml]);

  const baixar = useCallback(() => {
    const url = URL.createObjectURL(new Blob([xml], { type: "application/xml" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `previa-nfse-${mes}${assinada ? "" : "-nao-assinada"}.xml`;
    link.click();
    URL.revokeObjectURL(url);
  }, [xml, mes, assinada]);

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="mr-auto text-[14px] font-semibold text-ink">
          XML da DPS {assinada ? "(assinado)" : "(NÃO assinado)"}
        </h3>
        <button type="button" className={BOTAO} onClick={copiar}>
          Copiar XML
        </button>
        <button type="button" className={BOTAO} onClick={baixar}>
          Baixar XML
        </button>
        <span role="status" className="font-mono text-[11px] text-ink-mute">
          {copiado === "ok" ? "copiado" : copiado === "erro" ? "não foi possível copiar" : ""}
        </span>
      </div>
      <pre
        className="max-h-[28rem] overflow-auto whitespace-pre-wrap break-all rounded-md border border-line bg-cream-2/40 p-3 font-mono text-[11px] leading-relaxed text-ink"
        data-testid="nf-xml"
      >
        {xml}
      </pre>
    </div>
  );
}
