import { useState } from "react";
import { formatBRL } from "@/lib/formatBRL";
import {
  DIA_COBRANCA_MAX,
  descreverRecorrencia,
  parseValorBRL,
  type Recorrencia,
} from "@/lib/despesasManuais";
import { formatLocalDate } from "@/lib/receitaPeriodo";
import { MONO } from "../receita/ReceitaPainel";
import type { DespesaManualData } from "./types";

/**
 * Cadastro de despesas recorrentes/manuais (aperture-0ngn4): servidores,
 * ferramentas, assinaturas. Mensal (dia de cobrança 1–28, início, fim
 * opcional) ou única (uma data). Mudar o valor vale a partir de uma data e
 * não reescreve meses anteriores; encerrar grava o fim uma vez.
 *
 * Componentes puros: as mutações chegam por callback (AdminDespesasPage).
 */

export interface NovaDespesaManual {
  readonly nome: string;
  readonly categoria?: string;
  readonly valorCents: number;
  readonly tipo:
    | {
        readonly recorrencia: "mensal";
        readonly diaCobranca: number;
        readonly inicio: string;
        readonly fim?: string;
      }
    | { readonly recorrencia: "unica"; readonly data: string };
}

const CAMPO = "flex flex-col gap-1 text-[12px] text-ink-soft";
const INPUT =
  "rounded-md border border-line bg-paper px-3 py-2 text-[14px] text-ink tabular-nums";
const BOTAO = "rounded-md bg-plum px-4 py-2 text-[13px] font-semibold text-white disabled:opacity-50";
const BOTAO_SECUNDARIO =
  "rounded-md border border-line px-3 py-1.5 text-[12px] text-ink hover:bg-cream disabled:opacity-50";

function Erro({ mensagem }: { mensagem: string | null | undefined }) {
  if (!mensagem) return null;
  return (
    <p role="alert" className="text-[12px] text-red-800">
      {mensagem}
    </p>
  );
}

export function FormDespesaManual({
  hoje,
  onSalvar,
  salvando = false,
  erro,
  recorrenciaInicial = "mensal",
}: {
  hoje: string;
  onSalvar: (despesa: NovaDespesaManual) => void;
  salvando?: boolean;
  erro?: string | null;
  recorrenciaInicial?: Recorrencia;
}) {
  const [recorrencia, setRecorrencia] = useState<Recorrencia>(recorrenciaInicial);
  const [nome, setNome] = useState("");
  const [valor, setValor] = useState("");
  const [categoria, setCategoria] = useState("");
  const [diaCobranca, setDiaCobranca] = useState("");
  const [inicio, setInicio] = useState(hoje);
  const [fim, setFim] = useState("");
  const [data, setData] = useState(hoje);
  const [invalido, setInvalido] = useState<string | null>(null);

  function enviar() {
    const valorCents = parseValorBRL(valor);
    if (!nome.trim()) return setInvalido("Informe o nome.");
    if (valorCents === null) return setInvalido("Valor inválido. Use, por exemplo, 1.234,56.");
    const base = {
      nome: nome.trim(),
      valorCents,
      ...(categoria.trim() ? { categoria: categoria.trim() } : {}),
    };
    if (recorrencia === "unica") {
      if (!data) return setInvalido("Informe a data.");
      setInvalido(null);
      return onSalvar({ ...base, tipo: { recorrencia, data } });
    }
    const dia = Number(diaCobranca);
    if (!Number.isInteger(dia) || dia < 1 || dia > DIA_COBRANCA_MAX) {
      return setInvalido(`Dia de cobrança deve ser de 1 a ${DIA_COBRANCA_MAX}.`);
    }
    if (!inicio) return setInvalido("Informe o início.");
    if (fim && fim < inicio) return setInvalido("O fim não pode ser antes do início.");
    setInvalido(null);
    onSalvar({
      ...base,
      tipo: { recorrencia, diaCobranca: dia, inicio, ...(fim ? { fim } : {}) },
    });
  }

  return (
    <form
      data-testid="despesas-manuais-form"
      className="flex flex-col gap-4 rounded-lg border border-line px-6 py-5"
      onSubmit={(event) => {
        event.preventDefault();
        enviar();
      }}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-[15px] font-semibold tracking-normal! text-ink">Nova despesa</h3>
        <fieldset className="flex gap-4 text-[13px] text-ink">
          <legend className="sr-only">Recorrência</legend>
          {(
            [
              ["mensal", "Mensal"],
              ["unica", "Única"],
            ] as const
          ).map(([valorOpcao, rotulo]) => (
            <label key={valorOpcao} className="flex items-center gap-1.5">
              <input
                type="radio"
                name="recorrencia"
                value={valorOpcao}
                checked={recorrencia === valorOpcao}
                onChange={() => setRecorrencia(valorOpcao)}
              />
              {rotulo}
            </label>
          ))}
        </fieldset>
      </div>
      <div className="grid gap-4 sm:grid-cols-3">
        <label className={CAMPO}>
          Nome
          <input
            className={INPUT}
            name="nome"
            required
            maxLength={120}
            placeholder="Servidor, ferramenta, assinatura…"
            value={nome}
            onChange={(e) => setNome(e.target.value)}
          />
        </label>
        <label className={CAMPO}>
          Valor (R$)
          <input
            className={INPUT}
            name="valor"
            inputMode="decimal"
            required
            placeholder="0,00"
            value={valor}
            onChange={(e) => setValor(e.target.value)}
          />
        </label>
        <label className={CAMPO}>
          Categoria (opcional)
          <input
            className={INPUT}
            name="categoria"
            maxLength={60}
            value={categoria}
            onChange={(e) => setCategoria(e.target.value)}
          />
        </label>
      </div>
      {recorrencia === "mensal" ? (
        <div className="grid gap-4 sm:grid-cols-3">
          <label className={CAMPO}>
            Dia de cobrança (1–{DIA_COBRANCA_MAX})
            <input
              className={INPUT}
              name="diaCobranca"
              type="number"
              min="1"
              max={String(DIA_COBRANCA_MAX)}
              required
              value={diaCobranca}
              onChange={(e) => setDiaCobranca(e.target.value)}
            />
          </label>
          <label className={CAMPO}>
            Início
            <input
              className={INPUT}
              name="inicio"
              type="date"
              required
              value={inicio}
              onChange={(e) => setInicio(e.target.value)}
            />
          </label>
          <label className={CAMPO}>
            Fim (opcional)
            <input
              className={INPUT}
              name="fim"
              type="date"
              value={fim}
              onChange={(e) => setFim(e.target.value)}
            />
          </label>
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-3">
          <label className={CAMPO}>
            Data da despesa
            <input
              className={INPUT}
              name="data"
              type="date"
              required
              value={data}
              onChange={(e) => setData(e.target.value)}
            />
          </label>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" className={BOTAO} disabled={salvando}>
          {salvando ? "Salvando…" : "Cadastrar despesa"}
        </button>
        <Erro mensagem={invalido ?? erro} />
      </div>
    </form>
  );
}

type Acao = { tipo: "valor" | "encerrar"; id: string } | null;

function FormAcao({
  rotulo,
  comValor,
  hoje,
  onConfirmar,
  onCancelar,
  salvando,
}: {
  rotulo: string;
  comValor: boolean;
  hoje: string;
  onConfirmar: (dados: { valorCents: number | null; data: string }) => void;
  onCancelar: () => void;
  salvando: boolean;
}) {
  const [valor, setValor] = useState("");
  const [data, setData] = useState(hoje);
  const [invalido, setInvalido] = useState<string | null>(null);
  return (
    <form
      className="flex flex-wrap items-end gap-3 pt-2"
      onSubmit={(event) => {
        event.preventDefault();
        const valorCents = comValor ? parseValorBRL(valor) : null;
        if (comValor && valorCents === null) return setInvalido("Valor inválido.");
        if (!data) return setInvalido("Informe a data.");
        setInvalido(null);
        onConfirmar({ valorCents, data });
      }}
    >
      {comValor ? (
        <label className={CAMPO}>
          Novo valor (R$)
          <input
            className={INPUT}
            name="novoValor"
            inputMode="decimal"
            required
            value={valor}
            onChange={(e) => setValor(e.target.value)}
          />
        </label>
      ) : null}
      <label className={CAMPO}>
        {comValor ? "A partir de" : "Última cobrança até"}
        <input
          className={INPUT}
          name={comValor ? "vigenteDesde" : "fim"}
          type="date"
          required
          value={data}
          onChange={(e) => setData(e.target.value)}
        />
      </label>
      <button type="submit" className={BOTAO_SECUNDARIO} disabled={salvando}>
        {rotulo}
      </button>
      <button type="button" className={BOTAO_SECUNDARIO} onClick={onCancelar}>
        Cancelar
      </button>
      <Erro mensagem={invalido} />
    </form>
  );
}

export function DespesasManuaisLista({
  despesas,
  hoje,
  onAlterarValor,
  onEncerrar,
  salvando = false,
  erro,
}: {
  despesas: readonly DespesaManualData[];
  hoje: string;
  onAlterarValor: (input: { id: string; valorCents: number; vigenteDesde: string }) => void;
  onEncerrar: (input: { id: string; fim: string }) => void;
  salvando?: boolean;
  erro?: string | null;
}) {
  const [acao, setAcao] = useState<Acao>(null);
  if (despesas.length === 0) {
    return (
      <p className="text-[13px] text-ink-mute">Nenhuma despesa recorrente ou manual cadastrada.</p>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      <Erro mensagem={erro} />
      <ul className="flex flex-col rounded-lg border border-line px-6">
        {despesas.map((d) => {
          const encerrada = d.fim !== null && d.fim < hoje;
          const ativaMensal = d.recorrencia === "mensal" && !encerrada;
          const futuras = d.valores.filter((v) => v.vigenteDesde > hoje);
          return (
            <li
              key={d.id}
              data-testid={`despesa-manual-${d.id}`}
              className="flex flex-col gap-1 border-t border-line py-3 first:border-t-0"
            >
              <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                <span className="flex flex-wrap items-baseline gap-2 text-[14px] text-ink">
                  {d.nome}
                  {d.categoria ? <span className={MONO}>{d.categoria}</span> : null}
                  {encerrada ? <span className={MONO}>encerrada</span> : null}
                </span>
                <span className="text-[14px] font-semibold tabular-nums text-ink">
                  {formatBRL(d.valorAtualCents)}
                </span>
              </div>
              <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                <span className="text-[12px] text-ink-soft">
                  {descreverRecorrencia(d, formatLocalDate)}
                  {futuras.map((v) => (
                    <span key={v.vigenteDesde}>
                      {" "}
                      · {formatBRL(v.valorCents)} a partir de {formatLocalDate(v.vigenteDesde)}
                    </span>
                  ))}
                </span>
                {ativaMensal ? (
                  <span className="flex gap-2">
                    <button
                      type="button"
                      className={BOTAO_SECUNDARIO}
                      onClick={() => setAcao({ tipo: "valor", id: d.id })}
                    >
                      Alterar valor
                    </button>
                    {d.fim === null ? (
                      <button
                        type="button"
                        className={BOTAO_SECUNDARIO}
                        onClick={() => setAcao({ tipo: "encerrar", id: d.id })}
                      >
                        Encerrar
                      </button>
                    ) : null}
                  </span>
                ) : null}
              </div>
              {acao?.id === d.id ? (
                <FormAcao
                  key={acao.tipo}
                  rotulo={acao.tipo === "valor" ? "Salvar novo valor" : "Encerrar despesa"}
                  comValor={acao.tipo === "valor"}
                  hoje={hoje}
                  salvando={salvando}
                  onCancelar={() => setAcao(null)}
                  onConfirmar={({ valorCents, data }) => {
                    if (acao.tipo === "valor" && valorCents !== null) {
                      onAlterarValor({ id: d.id, valorCents, vigenteDesde: data });
                    } else if (acao.tipo === "encerrar") {
                      onEncerrar({ id: d.id, fim: data });
                    }
                    setAcao(null);
                  }}
                />
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
