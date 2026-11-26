import { type FormEvent, useId, useState } from "react";
import { trpc } from "@/lib/trpc.js";

/**
 * aperture-xdylg — dados fiscais obrigatórios para resgatar (decisão do
 * contador, 26/11/2026): o endereço do titular vai como tomador na NFS-e.
 *
 * Aparece no lugar do "confirmar transferência" quando o recebedor ativo não
 * tem endereço fiscal. O CEP preenche o resto via ViaCEP (só o CEP sai do
 * navegador); se o ViaCEP falhar ou errar, tudo continua editável à mão. O
 * servidor valida de novo (CEP, código IBGE de 7 dígitos coerente com a UF).
 */

export interface EnderecoForm {
  cep: string;
  logradouro: string;
  numero: string;
  complemento: string;
  bairro: string;
  cidade: string;
  uf: string;
  codigoMunicipioIbge: string;
}

export const ENDERECO_VAZIO: EnderecoForm = {
  cep: "",
  logradouro: "",
  numero: "",
  complemento: "",
  bairro: "",
  cidade: "",
  uf: "",
  codigoMunicipioIbge: "",
};

export const UFS_BR = [
  "AC", "AL", "AM", "AP", "BA", "CE", "DF", "ES", "GO", "MA", "MG", "MS", "MT", "PA",
  "PB", "PE", "PI", "PR", "RJ", "RN", "RO", "RR", "RS", "SC", "SE", "SP", "TO",
] as const;

/**
 * Consulta o ViaCEP com SÓ o CEP. Devolve os campos que conseguiu, ou null
 * (CEP inexistente, rede fora, resposta estranha) — o formulário segue
 * manual nesse caso.
 */
export async function buscarCep(
  cep: string,
  fetchImpl: typeof fetch = fetch,
): Promise<Partial<EnderecoForm> | null> {
  const digitos = cep.replace(/\D/g, "");
  if (digitos.length !== 8) return null;
  try {
    const res = await fetchImpl(`https://viacep.com.br/ws/${digitos}/json/`);
    if (!res.ok) return null;
    const j = (await res.json()) as Record<string, unknown>;
    if (j.erro) return null;
    const s = (k: string) => (typeof j[k] === "string" ? (j[k] as string) : "");
    const ibge = s("ibge");
    return {
      logradouro: s("logradouro"),
      bairro: s("bairro"),
      cidade: s("localidade"),
      uf: s("uf").toUpperCase(),
      codigoMunicipioIbge: /^\d{7}$/.test(ibge) ? ibge : "",
    };
  } catch {
    return null;
  }
}

/** Mesmo critério mínimo do servidor, para habilitar o botão. */
export function enderecoPreenchido(e: EnderecoForm): boolean {
  return (
    e.cep.replace(/\D/g, "").length === 8 &&
    e.logradouro.trim() !== "" &&
    e.numero.trim() !== "" &&
    e.bairro.trim() !== "" &&
    e.cidade.trim() !== "" &&
    (UFS_BR as readonly string[]).includes(e.uf) &&
    /^\d{7}$/.test(e.codigoMunicipioIbge.trim())
  );
}

export function DadosFiscaisForm({
  inicial = ENDERECO_VAZIO,
  enviando,
  erro,
  onSalvar,
  onCancelar,
  buscar = buscarCep,
}: {
  inicial?: EnderecoForm;
  enviando: boolean;
  erro: string | null;
  onSalvar: (e: EnderecoForm) => void;
  onCancelar: () => void;
  buscar?: (cep: string) => Promise<Partial<EnderecoForm> | null>;
}) {
  const id = useId();
  const [form, setForm] = useState<EnderecoForm>(inicial);
  const [buscando, setBuscando] = useState(false);
  const [cepAviso, setCepAviso] = useState<string | null>(null);
  const set = (campo: keyof EnderecoForm) => (valor: string) => setForm((f) => ({ ...f, [campo]: valor }));

  const aoSairDoCep = async () => {
    if (form.cep.replace(/\D/g, "").length !== 8) return;
    setBuscando(true);
    const achado = await buscar(form.cep);
    setBuscando(false);
    if (!achado) {
      setCepAviso("Não encontramos esse CEP automaticamente. Preencha o endereço à mão.");
      return;
    }
    setCepAviso(null);
    // Não sobrescreve o que a pessoa já digitou com vazio do ViaCEP.
    setForm((f) => ({
      ...f,
      logradouro: achado.logradouro || f.logradouro,
      bairro: achado.bairro || f.bairro,
      cidade: achado.cidade || f.cidade,
      uf: achado.uf || f.uf,
      codigoMunicipioIbge: achado.codigoMunicipioIbge || f.codigoMunicipioIbge,
    }));
  };

  const enviar = (ev: FormEvent) => {
    ev.preventDefault();
    if (!enderecoPreenchido(form) || enviando) return;
    onSalvar(form);
  };

  const campo = (
    nome: keyof EnderecoForm,
    rotulo: string,
    extra: { opcional?: boolean; inputMode?: "numeric"; maxLength?: number; onBlur?: () => void; ajuda?: string } = {},
  ) => (
    <label className="ex-field" htmlFor={`${id}-${nome}`} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <span className="ex-caps">
        {rotulo}
        {extra.opcional ? " (opcional)" : ""}
      </span>
      <input
        id={`${id}-${nome}`}
        name={nome}
        value={form[nome]}
        onChange={(e) => set(nome)(e.target.value)}
        onBlur={extra.onBlur}
        inputMode={extra.inputMode}
        maxLength={extra.maxLength}
        autoComplete="off"
        className="ex-input"
      />
      {extra.ajuda ? <small style={{ color: "var(--ink-mute)" }}>{extra.ajuda}</small> : null}
    </label>
  );

  return (
    <form onSubmit={enviar} noValidate data-testid="dados-fiscais-form" style={{ display: "grid", gap: 12 }}>
      <p className="ex-modal-text">
        Para transferir, precisamos do <strong>endereço do titular</strong>. Ele vai na nota fiscal da
        taxa da plataforma, junto com o CPF já cadastrado.
      </p>
      {campo("cep", "CEP", { inputMode: "numeric", maxLength: 9, onBlur: () => void aoSairDoCep() })}
      {buscando ? <small role="status">buscando CEP…</small> : null}
      {cepAviso ? <small role="status">{cepAviso}</small> : null}
      {campo("logradouro", "Rua / avenida", { maxLength: 255 })}
      {campo("numero", "Número", { maxLength: 60 })}
      {campo("complemento", "Complemento", { opcional: true, maxLength: 156 })}
      {campo("bairro", "Bairro", { maxLength: 60 })}
      {campo("cidade", "Cidade", { maxLength: 60 })}
      <label className="ex-field" htmlFor={`${id}-uf`} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <span className="ex-caps">UF</span>
        <select id={`${id}-uf`} value={form.uf} onChange={(e) => set("uf")(e.target.value)} className="ex-input">
          <option value="">—</option>
          {UFS_BR.map((uf) => (
            <option key={uf} value={uf}>
              {uf}
            </option>
          ))}
        </select>
      </label>
      {campo("codigoMunicipioIbge", "Código IBGE do município", {
        inputMode: "numeric",
        maxLength: 7,
        ajuda: "Preenchido pelo CEP. Se não vier, consulte em ibge.gov.br (7 dígitos).",
      })}
      {erro ? (
        <div role="alert" className="ex-modal-error">
          {erro}
        </div>
      ) : null}
      <div className="ex-modal-actions">
        <button type="button" className="ex-btn-ghost" onClick={onCancelar} disabled={enviando}>
          cancelar
        </button>
        <button type="submit" className="ex-btn-green" disabled={!enderecoPreenchido(form) || enviando}>
          {enviando ? "salvando…" : "salvar e continuar"}
        </button>
      </div>
    </form>
  );
}

/**
 * Modal do resgate: pede o endereço fiscal e, salvo, invalida o status do
 * recebedor — o TransferModal volta ao "confirmar transferência".
 */
export function DadosFiscaisModal({ idCampanha, onClose }: { idCampanha: string; onClose: () => void }) {
  const utils = trpc.useUtils();
  const salvar = trpc.recebedor.atualizarEnderecoFiscal.useMutation({
    onSuccess: async () => {
      await utils.recebedor.status.invalidate({ idCampanha });
    },
  });
  return (
    <>
      <div className="ex-scrim is-open" onClick={onClose} />
      <div className="ex-modal" role="dialog" aria-label="Dados fiscais pendentes">
        <header className="ex-modal-hd">
          <div>
            <span className="ex-caps">solicitar transferência</span>
            <h3 className="ex-modal-title">falta o endereço do titular</h3>
          </div>
        </header>
        <DadosFiscaisForm
          enviando={salvar.isPending}
          erro={salvar.error ? salvar.error.message : null}
          onCancelar={onClose}
          onSalvar={(e) =>
            salvar.mutate({
              idCampanha,
              enderecoFiscal: {
                cep: e.cep,
                logradouro: e.logradouro,
                numero: e.numero,
                complemento: e.complemento.trim() === "" ? null : e.complemento,
                bairro: e.bairro,
                cidade: e.cidade,
                uf: e.uf,
                codigoMunicipioIbge: e.codigoMunicipioIbge.trim(),
              },
            })
          }
        />
      </div>
    </>
  );
}
