import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import type { PainelSectionBodyProps } from "@/PainelSectionPage";
import { trpc } from "@/lib/trpc";
import {
  ACCOUNT_TYPES,
  BANKS,
  PIX_TYPES,
  accountTypeLabel,
  bankByCode,
  type BankOption,
  type BancariosForm,
  type BancariosMode,
  type PixType,
} from "@/lib/mocks/bancarios";
// aperture-4bf4j (V3) — client validation imports the SAME pure validators the
// domain VO uses, so the inline checks never drift from the server.
// aperture-9abwt: import from the DEEP leaf module (zod-only, pg-free), NOT the
// barrel src/index.js. The barrel statically re-exports the Postgres adapters
// (src/adapters/database.ts → `import pg from 'pg'`), so a runtime value-import
// of it drags `pg` + node built-ins into the browser bundle → esbuild fails to
// resolve fs/events/util/dns. Type-only barrel imports are fine (stripped at
// build); runtime values MUST come from the leaf.
import {
  cpfValido,
  type DadosRecebedor,
  mensagemChavePixInvalida,
  type TipoChavePix,
  type TipoConta,
  telefoneBrValido,
} from "../../../../../../src/domain/arrecadacao/value-objects/dados-recebedor.js";

// aperture-6xjcw — Dados Bancários body for /painel/:slug/bancarios.
//
// CONTENT ONLY: the topbar, 520/1200px shell and TweaksPanel come from
// PainelLayout. This is the standalone "Dados Bancários" export (app.jsx)
// ported into the painel foundation: a segmented mode toggle (conta completa
// vs chave pix), the matching form section, a holder card (locked CPF +
// celular), inline validation, a "vamos depositar em…" review summary and a
// lilás save CTA. Mock-first — saving just runs validation and fires a sonner
// toast; nothing persists.
//
// Styling is a scoped <style> block (bnc- prefix) so it never collides with
// the foundation's .input/.card/.field classes. It reuses the shared design
// tokens from tailwind.css and only inlines the four soft/tint shades the
// runtime token set doesn't expose yet (--green-tint / --blue-soft /
// --blue-deep / --yellow-soft).

// ── masks / helpers ─────────────────────────────────────────────────────────

const onlyDigits = (s: string): string => (s || "").replace(/\D/g, "");

const maskCPF = (s: string): string => {
  const d = onlyDigits(s).slice(0, 11);
  return d
    .replace(/(\d{3})(\d)/, "$1.$2")
    .replace(/(\d{3})\.(\d{3})(\d)/, "$1.$2.$3")
    .replace(/\.(\d{3})(\d)/, ".$1-$2");
};

const maskPhone = (s: string): string => {
  const d = onlyDigits(s).slice(0, 11);
  if (d.length <= 2) return d;
  if (d.length <= 7) return `(${d.slice(0, 2)}) ${d.slice(2)}`;
  return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
};

// Frontend pix-type label ⇄ domain TipoChavePix. The domain key is 'telefone';
// the UI calls it 'celular'. Bridge both directions so we never send 'celular'
// raw to the wire (the enum-alignment landmine flagged in design).
const PIX_TYPE_TO_DOMAIN: Record<PixType["v"], TipoChavePix> = {
  cpf: "cpf",
  email: "email",
  celular: "telefone",
  aleatoria: "aleatoria",
};
const DOMAIN_TO_PIX_TYPE: Record<TipoChavePix, PixType["v"]> = {
  cpf: "cpf",
  cnpj: "cpf", // frontend has no CNPJ pix chip; our UI never writes it
  email: "email",
  telefone: "celular",
  aleatoria: "aleatoria",
};

// Store the key the way the domain does: digits-only for cpf/cnpj/phone,
// trimmed text for email/random.
function normalizePixKey(domainType: TipoChavePix, raw: string): string {
  if (domainType === "cpf" || domainType === "cnpj" || domainType === "telefone") {
    return onlyDigits(raw);
  }
  return raw.trim();
}

const EMPTY_FORM: BancariosForm = {
  bankCode: "",
  agencia: "",
  agenciaDV: "",
  conta: "",
  contaDV: "",
  tipoConta: "cc",
  pixKey: "",
  nome: "",
  telefone: "",
};

// aperture-4a — placeholder shown until a bank is chosen (bankCode === "").
// bankByCode("") would fall back to Banco do Brasil; this keeps the flag neutral
// so the field doesn't pre-fill a bank the user never selected.
const NEUTRAL_BANK: BankOption = {
  code: "",
  name: "—",
  color: "#EDE7DE",
  text: "#A89E92",
  short: "",
};

interface ValidationError {
  k: string;
  msg: string;
}

// Mirrors DadosRecebedorSchema (same pure validators the server uses):
// pix → mensagemChavePixInvalida (per-type checksum/format); conta → COMPE
// 3 digits, numeric agência/conta, holder CPF checksum + E.164-ish celular.
// nomeTitular required in both modes.
function validate(
  modo: BancariosMode,
  s: BancariosForm,
  tipoPix: PixType["v"],
  cpfTitular: string,
): ValidationError[] {
  const errs: ValidationError[] = [];

  if (!s.nome || s.nome.trim().split(/\s+/).length < 2) {
    errs.push({
      k: "nome",
      msg: "o nome do titular precisa ser igual ao do documento (nome e sobrenome).",
    });
  }

  if (modo === "conta") {
    if (!/^\d{3}$/.test(s.bankCode))
      errs.push({ k: "bankCode", msg: "escolha o banco onde a sua conta foi aberta." });
    if (!/^\d{1,10}$/.test(s.agencia))
      errs.push({ k: "agencia", msg: "a agência deve ser numérica ✿" });
    if (!/^\d{1,20}$/.test(s.conta))
      errs.push({ k: "conta", msg: "o número da conta deve ser numérico." });
    if (!s.contaDV)
      errs.push({
        k: "contaDV",
        msg: "o dígito da conta é obrigatório — é o número depois do tracinho.",
      });
    if (!telefoneBrValido(s.telefone))
      errs.push({
        k: "telefone",
        msg: "o celular (com DDD) é obrigatório pra avisar você quando cair um mimo.",
      });
    if (!cpfValido(cpfTitular))
      errs.push({ k: "cpf", msg: "o cpf da sua conta parece inválido — confira e tente de novo." });
  } else {
    const domainType = PIX_TYPE_TO_DOMAIN[tipoPix];
    const msg = mensagemChavePixInvalida(domainType, normalizePixKey(domainType, s.pixKey));
    if (msg) {
      const tipoLbl = PIX_TYPES.find((p) => p.v === tipoPix)?.label ?? "chave";
      errs.push({ k: "pixKey", msg: `${msg} (chave ${tipoLbl}).` });
    }
  }
  return errs;
}

// ── form ⇄ DadosRecebedor (the wire union) ──
function toDadosRecebedor(
  modo: BancariosMode,
  s: BancariosForm,
  tipoPix: PixType["v"],
  cpfTitular: string,
): DadosRecebedor {
  const nomeTitular = s.nome.trim();
  if (modo === "pix") {
    const tipoChavePix = PIX_TYPE_TO_DOMAIN[tipoPix];
    return {
      metodo: "pix",
      nomeTitular,
      tipoChavePix,
      chavePix: normalizePixKey(tipoChavePix, s.pixKey),
    };
  }
  return {
    metodo: "conta",
    nomeTitular,
    cpfTitular: onlyDigits(cpfTitular),
    celularTitular: onlyDigits(s.telefone),
    codigoBanco: s.bankCode,
    agencia: s.agencia,
    agenciaDigito: s.agenciaDV ? s.agenciaDV : null,
    conta: s.conta,
    contaDigito: s.contaDV,
    tipoConta: s.tipoConta as TipoConta,
  };
}

function fromDadosRecebedor(d: DadosRecebedor): BancariosForm {
  if (d.metodo === "pix") {
    const uiType = DOMAIN_TO_PIX_TYPE[d.tipoChavePix];
    const pixKey =
      uiType === "cpf"
        ? maskCPF(d.chavePix)
        : uiType === "celular"
          ? maskPhone(d.chavePix)
          : d.chavePix;
    return { ...EMPTY_FORM, nome: d.nomeTitular, pixKey };
  }
  return {
    ...EMPTY_FORM,
    nome: d.nomeTitular,
    telefone: maskPhone(d.celularTitular),
    bankCode: d.codigoBanco,
    agencia: d.agencia,
    agenciaDV: d.agenciaDigito ?? "",
    conta: d.conta,
    contaDV: d.contaDigito,
    tipoConta: d.tipoConta,
  };
}

// ── tiny stroke icons (ported from the export's icons.jsx) ──────────────────

interface IconProps {
  size?: number;
}

const Svg = ({
  size = 22,
  strokeWidth = 1.8,
  children,
}: IconProps & { strokeWidth?: number; children: React.ReactNode }) => (
  <svg
    viewBox="0 0 24 24"
    width={size}
    height={size}
    fill="none"
    stroke="currentColor"
    strokeWidth={strokeWidth}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    {children}
  </svg>
);

const IBank = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3 10h18M5 10v9M19 10v9M9 10v9M15 10v9M3 21h18M12 3l9 4H3l9-4z" />
  </Svg>
);
const IUser = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="8" r="4" />
    <path d="M4 21c0-4.5 3.5-7 8-7s8 2.5 8 7" />
  </Svg>
);
const IPix = (p: IconProps) => (
  <Svg {...p}>
    <path d="M5 12l7-7 7 7-7 7-7-7z" />
    <path d="M8 9l2.5 2.5a2 2 0 0 0 2.8 0L16 9" />
    <path d="M8 15l2.5-2.5a2 2 0 0 1 2.8 0L16 15" />
  </Svg>
);
const IShield = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6l8-3z" />
    <path d="M9 12l2 2 4-4" />
  </Svg>
);
const ICheck = (p: IconProps) => (
  <Svg {...p} strokeWidth={2}>
    <path d="M5 12l5 5L20 7" />
  </Svg>
);
const ICheckCircle = (p: IconProps) => (
  <Svg {...p} strokeWidth={2.4}>
    <circle cx="12" cy="12" r="9" />
    <path d="M8.5 12.5l2.5 2.5 4.5-5" />
  </Svg>
);
const IInfo = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 11v5M12 8h.01" />
  </Svg>
);
const IMail = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3" y="5" width="18" height="14" rx="2" />
    <path d="M3 7l9 6 9-6" />
  </Svg>
);
const IPhone = (p: IconProps) => (
  <Svg {...p}>
    <path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2z" />
  </Svg>
);
const IDice = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3" y="3" width="18" height="18" rx="3" />
    <circle cx="8" cy="8" r="1.2" fill="currentColor" />
    <circle cx="16" cy="16" r="1.2" fill="currentColor" />
    <circle cx="12" cy="12" r="1.2" fill="currentColor" />
  </Svg>
);
const IID = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3" y="5" width="18" height="14" rx="2" />
    <circle cx="9" cy="12" r="2.2" />
    <path d="M14 10h4M14 13h3M5.5 17c.7-1.4 2-2.2 3.5-2.2s2.8.8 3.5 2.2" />
  </Svg>
);
const ILock = (p: IconProps) => (
  <Svg {...p}>
    <rect x="4" y="11" width="16" height="10" rx="2" />
    <path d="M8 11V8a4 4 0 0 1 8 0v3" />
  </Svg>
);

const PIX_ICON: Record<PixType["v"], (p: IconProps) => React.ReactNode> = {
  cpf: IID,
  email: IMail,
  celular: IPhone,
  aleatoria: IDice,
};

// ── component ───────────────────────────────────────────────────────────────

export function BancariosBody(_props: PainelSectionBodyProps) {
  const utils = trpc.useUtils();
  const [s, setS] = useState<BancariosForm>({ ...EMPTY_FORM });
  // PIX is the default tab (initially-selected mode); fields start empty and
  // only hydrate from real saved data below — no mock prefills.
  const [modo, setModo] = useState<BancariosMode>("pix");
  const [tipoPix, setTipoPix] = useState<PixType["v"]>("cpf");
  const [errors, setErrors] = useState<ValidationError[]>([]);

  const set = (patch: Partial<BancariosForm>) =>
    setS((prev) => ({ ...prev, ...patch }));
  const errorKeys = errors.map((e) => e.k);
  const hasErr = (k: string) => errorKeys.includes(k);

  // ── Load the saved receiving data (R4 dadosRecebimento.get). Hydrate once;
  // null = never saved → empty form. ──
  const dadosQuery = trpc.dadosRecebimento.get.useQuery(undefined, {
    staleTime: 30_000,
  });
  // Real saved CPF (locked) — only the "conta" payload carries it. Empty until
  // the user has a saved account; never a mock literal.
  const cpfTitular =
    dadosQuery.data?.metodo === "conta" ? maskCPF(dadosQuery.data.cpfTitular) : "";
  // aperture-3mlcw — the holder CPF is only immutable AFTER a real one is saved.
  // Until cpfTitular (the saved value) is non-empty, the field must be editable
  // so a new account can actually enter it. Previously the input was always
  // `disabled` and bound to cpfTitular ("" when unsaved) → a brand-new user
  // could never type a CPF and could never save conta data.
  const [cpfInput, setCpfInput] = useState("");
  const effectiveCpf = cpfTitular || cpfInput;
  const hydrated = useRef(false);
  useEffect(() => {
    if (hydrated.current || dadosQuery.isLoading) return;
    const d = dadosQuery.data;
    if (d) {
      setS(fromDadosRecebedor(d));
      if (d.metodo === "pix") {
        setModo("pix");
        setTipoPix(DOMAIN_TO_PIX_TYPE[d.tipoChavePix]);
      } else {
        setModo("conta");
      }
    }
    hydrated.current = true;
  }, [dadosQuery.data, dadosQuery.isLoading]);

  const salvar = trpc.dadosRecebimento.salvar.useMutation({
    onSuccess: () => {
      void utils.dadosRecebimento.get.invalidate();
      toast.success("dados salvos com carinho ♡");
    },
    onError: (err) => {
      toast.error(
        err.message || "não consegui salvar — confira os campos e tente de novo",
      );
    },
  });

  // Clear an error as soon as its field becomes valid.
  useEffect(() => {
    if (errors.length) {
      const live = validate(modo, s, tipoPix, effectiveCpf);
      setErrors((prev) => prev.filter((e) => live.some((x) => x.k === e.k)));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s, modo, tipoPix]);

  const isComplete = validate(modo, s, tipoPix, effectiveCpf).length === 0;

  const onSave = () => {
    const errs = validate(modo, s, tipoPix, effectiveCpf);
    setErrors(errs);
    if (errs.length > 0) return;
    salvar.mutate(toDadosRecebedor(modo, s, tipoPix, effectiveCpf));
  };

  const bank = useMemo(
    () => (s.bankCode ? bankByCode(s.bankCode) : NEUTRAL_BANK),
    [s.bankCode],
  );
  const tipo = PIX_TYPES.find((p) => p.v === tipoPix) ?? PIX_TYPES[0]!;

  const onPixKeyChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    let v = e.target.value;
    if (tipo.mask === "cpf") v = maskCPF(v);
    if (tipo.mask === "phone") v = maskPhone(v);
    set({ pixKey: v });
  };

  const errStyle = (k: string): React.CSSProperties | undefined =>
    hasErr(k)
      ? { borderColor: "var(--coral-pink)", boxShadow: "0 0 0 4px rgba(231,143,167,.18)" }
      : undefined;

  // Real loading state while the saved data loads (R4) — no demo flash.
  if (dadosQuery.isLoading) {
    return (
      <div className="bnc">
        <style>{BNC_CSS}</style>
        <header className="bnc-title">
          <span className="bnc-crumb">conta · pagamentos</span>
          <h1>
            <span className="hl">Dados Bancários</span>
          </h1>
        </header>
        <div style={{ display: "flex", justifyContent: "center", padding: "48px 0" }}>
          <span className="perfil-spinner" aria-hidden="true" />
        </div>
      </div>
    );
  }

  return (
    <div className="bnc">
      <style>{BNC_CSS}</style>

      <header className="bnc-title">
        <span className="bnc-crumb">conta · pagamentos</span>
        <h1>
          <span className="hl">Dados Bancários</span>
        </h1>
      </header>

      {/* Mode toggle */}
      <div className="bnc-mode-row">
        <div className="bnc-mode-eyebrow">como você prefere receber?</div>
        <div className={`bnc-mode-toggle ${modo === "pix" ? "pix" : ""}`} role="tablist">
          <div className="bnc-slider" />
          <button
            type="button"
            role="tab"
            aria-selected={modo === "conta"}
            className={modo === "conta" ? "active" : ""}
            onClick={() => setModo("conta")}
          >
            <IBank size={16} />
            conta completa
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={modo === "pix"}
            className={modo === "pix" ? "active" : ""}
            onClick={() => setModo("pix")}
          >
            <IPix size={16} />
            chave pix
          </button>
        </div>
      </div>

      {/* CPF callout */}
      <div className="bnc-callout" role="note">
        <span className="bnc-callout-ico">
          <IShield size={18} />
        </span>
        <strong>importante:</strong> os dados bancários ou a chave Pix cadastrada
        precisam estar vinculados ao mesmo CPF da sua conta
        {cpfTitular ? (
          <>
            {" "}—{" "}
            <span className="bnc-pill">
              <ILock size={12} />
              {cpfTitular}
            </span>
          </>
        ) : null}
        . essa regra protege você de fraudes e garante que o valor só caia na
        conta da pessoa cadastrada ♡
      </div>

      <div className="bnc-form-stack">
        {/* SECTION 2: holder */}
        <section className="bnc-card">
          <header className="bnc-card-head">
            <span className="bnc-card-chip blue">
              <IUser />
            </span>
            <div>
              <div className="bnc-card-title">dados do titular</div>
              <div className="bnc-card-title-sub">
                precisam bater com o cpf da sua conta EuNeném
              </div>
            </div>
          </header>

          <div className="bnc-grid" style={{ gap: 14 }}>
            <div className="bnc-field">
              <label>
                nome do titular <span className="req">*</span>
              </label>
              <input
                className="bnc-input"
                value={s.nome}
                style={errStyle("nome")}
                onChange={(e) => set({ nome: e.target.value })}
                placeholder="como está no documento"
                aria-label="nome do titular"
              />
            </div>
            <div className="bnc-grid c2">
              <div className={`bnc-field ${cpfTitular ? "locked" : ""}`}>
                <label>
                  cpf <span className="req">*</span>
                </label>
                <input
                  className="bnc-input"
                  value={cpfTitular || cpfInput}
                  style={cpfTitular ? undefined : errStyle("cpf")}
                  placeholder="000.000.000-00"
                  inputMode="numeric"
                  disabled={cpfTitular !== ""}
                  onChange={(e) => setCpfInput(maskCPF(e.target.value))}
                  aria-label="cpf"
                />
                {cpfTitular ? (
                  <span
                    className="bnc-helper"
                    style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
                  >
                    <ILock size={12} />o cpf não pode ser alterado após o cadastro inicial
                  </span>
                ) : (
                  <span className="bnc-helper">
                    use o mesmo cpf da sua conta bancária
                  </span>
                )}
              </div>
              {/* aperture-4biak — celular só existe no payload do modo CONTA
                  (celularTitular). No modo PIX ele não é coletado nem persistido,
                  então mostrá-lo como obrigatório era enganoso (sumia no reload). */}
              {modo === "conta" && (
                <div className="bnc-field">
                  <label>
                    celular <span className="req">*</span>
                  </label>
                  <input
                    className="bnc-input"
                    value={s.telefone}
                    style={errStyle("telefone")}
                    onChange={(e) => set({ telefone: maskPhone(e.target.value) })}
                    placeholder="(00) 00000-0000"
                    inputMode="numeric"
                    aria-label="celular"
                  />
                  <span className="bnc-helper">
                    usamos só pra avisar quando cair um mimo ♡
                  </span>
                </div>
              )}
            </div>
          </div>
        </section>

        {/* SECTION 1: account / pix */}
        <section className="bnc-card">
          <header className="bnc-card-head">
            <span className={`bnc-card-chip ${modo === "pix" ? "pink" : "lilac"}`}>
              {modo === "pix" ? <IPix /> : <IBank />}
            </span>
            <div>
              <div className="bnc-card-title">
                {modo === "pix" ? "sua chave pix" : "dados da conta"}
              </div>
              <div className="bnc-card-title-sub">
                {modo === "pix"
                  ? "uma chave só, vinculada ao seu cpf"
                  : "banco, agência e conta pra receber os mimos"}
              </div>
            </div>
          </header>

          {modo === "pix" ? (
            <div className="bnc-grid" style={{ gap: 16 }}>
              <div className="bnc-field">
                <label>tipo de chave</label>
                <div className="bnc-chip-row">
                  {PIX_TYPES.map((p) => {
                    const I = PIX_ICON[p.v];
                    return (
                      <button
                        key={p.v}
                        type="button"
                        className={`bnc-chip ${tipoPix === p.v ? "active" : ""}`}
                        onClick={() => setTipoPix(p.v)}
                      >
                        <I size={16} />
                        {p.label}
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="bnc-field">
                <label>
                  chave pix <span className="req">*</span>
                </label>
                <input
                  className="bnc-input"
                  placeholder={tipo.placeholder}
                  style={errStyle("pixKey")}
                  value={s.pixKey}
                  onChange={onPixKeyChange}
                  inputMode={
                    tipo.mask === "phone" || tipo.mask === "cpf" ? "numeric" : "text"
                  }
                  aria-label="chave pix"
                />
                <span className="bnc-helper">
                  {tipo.help}
                  {tipo.v === "cpf" && cpfTitular && (
                    <b style={{ color: "var(--plum)" }}>{cpfTitular}</b>
                  )}
                </span>
              </div>
            </div>
          ) : (
            <div className="bnc-grid" style={{ gap: 14 }}>
              <div className="bnc-grid c3">
                <div className="bnc-field">
                  <label>
                    banco <span className="req">*</span>
                  </label>
                  <div className="bnc-bank-pick">
                    <span
                      className="bnc-bank-flag"
                      style={{ background: bank.color, color: bank.text }}
                    >
                      {bank.short}
                    </span>
                    <select
                      className="bnc-input sel"
                      value={s.bankCode}
                      style={errStyle("bankCode")}
                      onChange={(e) => set({ bankCode: e.target.value })}
                      aria-label="banco"
                    >
                      <option value="" disabled>
                        Selecione o banco
                      </option>
                      {BANKS.map((b) => (
                        <option key={b.code} value={b.code}>
                          {b.name} ({b.code})
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
                <div className="bnc-field">
                  <label>
                    agência <span className="req">*</span>
                  </label>
                  <input
                    className="bnc-input"
                    inputMode="numeric"
                    maxLength={6}
                    style={errStyle("agencia")}
                    placeholder="0000"
                    value={s.agencia}
                    onChange={(e) =>
                      set({ agencia: onlyDigits(e.target.value).slice(0, 6) })
                    }
                    aria-label="agência"
                  />
                </div>
                <div className="bnc-field">
                  <label>dígito</label>
                  <input
                    className="bnc-input"
                    inputMode="numeric"
                    maxLength={2}
                    placeholder="0"
                    value={s.agenciaDV}
                    onChange={(e) =>
                      set({ agenciaDV: e.target.value.replace(/[^\dxX]/g, "").slice(0, 2) })
                    }
                    aria-label="dígito da agência"
                  />
                </div>
              </div>
              <div className="bnc-grid c3">
                <div className="bnc-field">
                  <label>
                    conta <span className="req">*</span>
                  </label>
                  <input
                    className="bnc-input"
                    inputMode="numeric"
                    maxLength={14}
                    style={errStyle("conta")}
                    placeholder="00000000"
                    value={s.conta}
                    onChange={(e) =>
                      set({ conta: onlyDigits(e.target.value).slice(0, 14) })
                    }
                    aria-label="conta"
                  />
                </div>
                <div className="bnc-field">
                  <label>
                    dígito <span className="req">*</span>
                  </label>
                  <input
                    className="bnc-input"
                    inputMode="numeric"
                    maxLength={2}
                    style={errStyle("contaDV")}
                    placeholder="0"
                    value={s.contaDV}
                    onChange={(e) =>
                      set({ contaDV: e.target.value.replace(/[^\dxX]/g, "").slice(0, 2) })
                    }
                    aria-label="dígito da conta"
                  />
                </div>
                <div className="bnc-field">
                  <label>
                    tipo de conta <span className="req">*</span>
                  </label>
                  <select
                    className="bnc-input sel"
                    value={s.tipoConta}
                    onChange={(e) => set({ tipoConta: e.target.value })}
                    aria-label="tipo de conta"
                  >
                    {ACCOUNT_TYPES.map((a) => (
                      <option key={a.v} value={a.v}>
                        {a.label}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            </div>
          )}
        </section>

        {/* Inline validation banner */}
        {errors.length > 0 && (
          <div className="bnc-form-errors" role="alert">
            <span className="bnc-form-errors-ico">
              <IInfo size={16} />
            </span>
            <strong>pera, faltou conferir uma coisinha ♡</strong>
            <ul>
              {errors.map((e, i) => (
                <li key={i}>{e.msg}</li>
              ))}
            </ul>
          </div>
        )}

        {/* Review summary */}
        {isComplete && (
          <section className="bnc-summary" aria-label="resumo dos dados">
            <span className="bnc-summary-eye">prontinho, vamos depositar em…</span>
            <h2 className="bnc-summary-h">
              {s.nome.split(" ").slice(0, 3).join(" ")}
            </h2>

            <div className="bnc-summary-row">
              <span className="k">{modo === "pix" ? "via" : "banco"}</span>
              <BankFlag bank={bank} />
              <span className="v">{bank.name}</span>
            </div>

            {modo === "pix" ? (
              <div className="bnc-summary-row">
                <span className="k">chave pix</span>
                <span className="v muted" style={{ fontVariantNumeric: "tabular-nums" }}>
                  {s.pixKey}
                </span>
              </div>
            ) : (
              <>
                <div className="bnc-summary-row">
                  <span className="k">agência</span>
                  <span className="v" style={{ fontVariantNumeric: "tabular-nums" }}>
                    {s.agencia}
                    {s.agenciaDV ? `-${s.agenciaDV}` : ""}
                  </span>
                </div>
                <div className="bnc-summary-row">
                  <span className="k">conta</span>
                  <span className="v" style={{ fontVariantNumeric: "tabular-nums" }}>
                    {s.conta}-{s.contaDV}
                  </span>
                  <span className="v muted bf">{accountTypeLabel(s.tipoConta)}</span>
                </div>
              </>
            )}
            <div className="bnc-summary-row">
              <span className="k">titular</span>
              <span className="v">{s.nome}</span>
              {cpfTitular && (
                <span className="bnc-verified-pill bf">
                  <ICheckCircle size={12} />
                  cpf {cpfTitular}
                </span>
              )}
            </div>
          </section>
        )}

        {/* Actions */}
        <div className="bnc-actions">
          {/* <button type="button" className="bnc-btn ghost" onClick={onSaveAndConfig}>
            salvar e configurar resgate <IArrowRight size={16} />
          </button> */}
          <button
            type="button"
            className="bnc-btn primary"
            onClick={onSave}
            disabled={salvar.isPending}
          >
            <ICheck size={16} />
            {salvar.isPending ? "salvando…" : "salvar dados bancários"}
          </button>
        </div>

        <div className="bnc-security-strip">
          <IShield size={14} />
          <span>seus dados ficam criptografados</span>
          <span className="dot" />
          <span>conformidade lgpd</span>
          <span className="dot" />
          <span>edições registradas no histórico</span>
        </div>
      </div>
    </div>
  );
}

function BankFlag({
  bank,
  size = 30,
}: {
  bank: { color: string; text: string; short: string };
  size?: number;
}) {
  return (
    <span
      className="bnc-bank-flag"
      style={{
        background: bank.color,
        color: bank.text,
        position: "static",
        transform: "none",
        width: size,
        height: size,
      }}
    >
      {bank.short}
    </span>
  );
}

// ── scoped CSS (bnc- prefix) ─────────────────────────────────────────────────
// Reuses the shared tokens declared in tailwind.css. Only the four soft/tint
// shades the runtime token set doesn't expose are inlined as literals here:
//   --green-tint #EEF4D1 · --blue-soft #DEF1F3 · --blue-deep #3F8B92
//   --yellow-soft #FCEFC1

const BNC_CSS = `
.bnc{--bnc-green-tint:#EEF4D1;--bnc-blue-soft:#DEF1F3;--bnc-blue-deep:#3F8B92;--bnc-yellow-soft:#FCEFC1}
.bnc *{box-sizing:border-box}

.bnc-title{display:flex;flex-direction:column;gap:6px;margin:6px 2px 4px}
.bnc-crumb{font-size:11px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:var(--ink-mute);display:inline-flex;align-items:center;gap:8px}
.bnc-crumb::after{content:"";flex:1;height:1px;background:linear-gradient(90deg,var(--line),transparent);margin-left:6px;max-width:120px}
.bnc-title h1{font-family:var(--font-patrick-hand),cursive;color:var(--plum);font-size:36px;line-height:1.05;letter-spacing:.01em;font-weight:600;margin:0}
.bnc-title h1 .hl{padding:0 8px}

.bnc-mode-row{display:flex;flex-direction:column;gap:10px;margin-top:18px}
.bnc-mode-eyebrow{font-size:11px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:var(--ink-mute)}
.bnc-mode-toggle{position:relative;display:flex;background:var(--cream-2);border-radius:999px;padding:5px;border:1px solid var(--line)}
.bnc-mode-toggle button{flex:1;border:0;background:transparent;padding:10px 14px;border-radius:999px;font-size:12px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--ink-soft);transition:color .2s;z-index:1;display:inline-flex;align-items:center;justify-content:center;gap:8px}
.bnc-mode-toggle button.active{color:#fff}
.bnc-slider{position:absolute;top:5px;bottom:5px;left:5px;width:calc(50% - 5px);background:var(--lilac);border-radius:999px;box-shadow:var(--shadow-cta);transition:transform .35s cubic-bezier(.34,1.56,.64,1)}
.bnc-mode-toggle.pix .bnc-slider{transform:translateX(100%)}

.bnc-callout{position:relative;margin-top:18px;padding:14px 16px 14px 52px;background:linear-gradient(135deg,var(--bnc-yellow-soft) 0%,#fff7df 60%,var(--cream) 100%);border:1px dashed #d8b53a;border-radius:18px;color:#7a5b15;font-size:13.5px}
.bnc-callout strong{color:#5c3e08}
.bnc-callout-ico{position:absolute;left:14px;top:50%;transform:translateY(-50%) rotate(-6deg);width:30px;height:30px;border-radius:9px;background:var(--yellow);display:inline-flex;align-items:center;justify-content:center;color:#5c3e08;box-shadow:0 3px 10px rgba(151,114,12,.18)}
.bnc-pill{display:inline-flex;align-items:center;gap:6px;padding:1px 8px;margin:0 2px;border-radius:6px;background:#fff;border:1px solid #e8c95a;font-weight:700;font-variant-numeric:tabular-nums;color:#5c3e08}

.bnc-form-stack{display:flex;flex-direction:column;gap:18px;margin-top:22px}
.bnc-card{background:var(--paper);border:1px solid var(--line);border-radius:24px;box-shadow:var(--shadow-sm);padding:20px 18px}
.bnc-card-head{display:flex;align-items:center;gap:14px;margin-bottom:18px}
.bnc-card-chip{width:44px;height:44px;border-radius:13px;display:inline-flex;align-items:center;justify-content:center;box-shadow:var(--shadow-sm)}
.bnc-card-chip.lilac{background:var(--lilac-soft);color:var(--lilac-deep)}
.bnc-card-chip.pink{background:var(--pink-soft);color:var(--coral-pink)}
.bnc-card-chip.blue{background:var(--bnc-blue-soft);color:var(--bnc-blue-deep)}
.bnc-card-chip svg{width:22px;height:22px}
.bnc-card-title{font-family:var(--font-patrick-hand),cursive;color:var(--plum);font-size:24px;line-height:1}
.bnc-card-title-sub{color:var(--ink-mute);font-size:12px;margin-top:3px}

.bnc-grid{display:grid;gap:14px}
.bnc-grid.c2{grid-template-columns:1fr 1fr}
.bnc-grid.c3{grid-template-columns:1fr 1fr 1fr}
@media (max-width:639px){.bnc-grid.c2,.bnc-grid.c3{grid-template-columns:1fr}}

.bnc-field{display:flex;flex-direction:column;gap:6px;min-width:0}
.bnc-field label{font-size:11px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:var(--ink-mute);display:inline-flex;gap:4px;align-items:center}
.bnc-field label .req{color:var(--coral-pink)}
.bnc-helper{font-size:11.5px;color:var(--ink-mute);margin-top:2px}
.bnc-field.locked .bnc-helper{color:#a07f25}

.bnc-input{width:100%;height:48px;padding:0 16px;background:#fff;border:1.5px solid var(--line);border-radius:14px;color:var(--ink);font-family:var(--font-dm-sans),sans-serif;font-size:15px;font-weight:500;outline:none;transition:border-color .18s,box-shadow .18s,background .18s;-webkit-appearance:none;appearance:none;font-variant-numeric:tabular-nums}
.bnc-input::placeholder{color:var(--ink-mute);font-weight:400}
.bnc-input:hover:not(:disabled){border-color:#e2c8d4}
.bnc-input:focus{border-color:var(--lilac-deep);box-shadow:0 0 0 4px rgba(167,123,190,.16);background:#fff}
.bnc-input:disabled{background:var(--cream-2);color:var(--ink-mute);cursor:not-allowed;border-style:dashed}
.bnc-input.sel{background-image:url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='12' height='8' viewBox='0 0 12 8' fill='none'><path d='M1 1.5L6 6.5L11 1.5' stroke='%236B3C5E' stroke-width='1.8' stroke-linecap='round' stroke-linejoin='round'/></svg>");background-repeat:no-repeat;background-position:right 16px center;padding-right:42px}

.bnc-bank-pick{position:relative}
.bnc-bank-flag{position:absolute;left:10px;top:50%;transform:translateY(-50%);width:30px;height:30px;border-radius:9px;display:inline-flex;align-items:center;justify-content:center;color:#fff;font-size:11px;font-weight:700;letter-spacing:.02em;box-shadow:var(--shadow-sm)}
.bnc-bank-pick .bnc-input{padding-left:52px}

.bnc-chip-row{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px}
.bnc-chip{display:inline-flex;align-items:center;justify-content:center;gap:6px;min-width:0;padding:9px 10px;border-radius:999px;background:#fff;border:1.5px solid var(--line);font-size:12px;font-weight:600;color:var(--ink-soft);white-space:nowrap;transition:all .2s;cursor:pointer}
.bnc-chip svg{width:16px;height:16px}
.bnc-chip:hover{border-color:var(--lilac-soft);color:var(--lilac-deep)}
.bnc-chip.active{background:var(--lilac-soft);border-color:var(--lilac);color:var(--lilac-deep);box-shadow:0 4px 14px rgba(167,123,190,.18)}

.bnc-verified-pill{display:inline-flex;align-items:center;gap:6px;padding:5px 10px;border-radius:999px;background:var(--bnc-blue-soft);color:var(--bnc-blue-deep);font-size:11px;font-weight:700;letter-spacing:.04em;text-transform:lowercase}
.bnc-verified-pill svg{width:12px;height:12px}

.bnc-saved-stamp{margin-top:0;padding:12px 16px;border-radius:16px;background:var(--cream-2);border:1px dashed var(--line);display:flex;align-items:center;gap:12px;color:var(--ink-soft);font-size:13px}
.bnc-saved-stamp .who{color:var(--plum);font-weight:600}

.bnc-autofill-strip{margin-top:0;display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:10px 14px;border-radius:14px;background:var(--bnc-blue-soft);color:var(--bnc-blue-deep);font-size:12.5px}
.bnc-autofill-strip .lbl{font-weight:600}
.bnc-autofill-strip button{margin-left:auto;border:1px solid rgba(63,139,146,.25);background:#fff;color:var(--bnc-blue-deep);padding:6px 12px;border-radius:999px;font-weight:700;font-size:11px;letter-spacing:.06em;text-transform:uppercase;cursor:pointer}
.bnc-autofill-strip button:hover{background:var(--cream)}

.bnc-form-errors{margin-top:0;padding:14px 16px 14px 50px;border-radius:16px;background:linear-gradient(135deg,var(--pink-soft) 0%,#fff5f9 100%);border:1px solid #f0c6d2;position:relative;color:#823753;font-size:13.5px}
.bnc-form-errors strong{color:#5c1f3a}
.bnc-form-errors-ico{position:absolute;left:12px;top:12px;width:28px;height:28px;border-radius:9px;background:var(--coral-pink);color:#fff;display:inline-flex;align-items:center;justify-content:center;transform:rotate(-4deg)}
.bnc-form-errors ul{margin:6px 0 0;padding-left:18px;display:grid;gap:2px}

.bnc-summary{margin-top:0;padding:18px 20px 18px 22px;border-radius:22px;background:linear-gradient(180deg,#fff 0%,var(--cream) 100%);border:1.5px solid var(--lilac-soft);box-shadow:var(--shadow-sm);position:relative;overflow:hidden}
.bnc-summary::before{content:"";position:absolute;top:-30px;right:-30px;width:140px;height:140px;border-radius:50%;background:radial-gradient(circle,var(--bnc-green-tint) 0%,transparent 70%);opacity:.65;pointer-events:none}
.bnc-summary-eye{font-family:var(--font-caveat),cursive;color:var(--lilac-deep);font-size:21px;transform:rotate(-2deg);display:inline-block;transform-origin:left;line-height:1;margin-bottom:2px}
.bnc-summary-h{font-family:var(--font-patrick-hand),cursive;color:var(--plum);font-size:24px;line-height:1.1;margin:0 0 12px}
.bnc-summary-row{display:flex;align-items:center;gap:14px;padding:10px 0;border-top:1px dashed var(--line);color:var(--ink);font-size:14px}
.bnc-summary-row:first-of-type{border-top:0;padding-top:6px}
.bnc-summary-row .k{font-size:11px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:var(--ink-mute);min-width:84px}
.bnc-summary-row .v{font-weight:600;color:var(--plum);font-family:var(--font-patrick-hand),cursive;font-size:18px}
.bnc-summary-row .v.muted{color:var(--ink-soft);font-family:var(--font-dm-sans),sans-serif;font-size:14px;font-weight:500}
.bnc-summary-row .bf{margin-left:auto}

.bnc-actions{margin-top:24px;display:flex;flex-direction:column;gap:10px;align-items:stretch}
@media (min-width:640px){.bnc-actions{flex-direction:row;justify-content:flex-end;align-items:center;gap:14px}}
.bnc-btn{border:0;display:inline-flex;align-items:center;justify-content:center;gap:10px;padding:14px 22px;border-radius:999px;font-family:var(--font-dm-sans),sans-serif;font-weight:700;font-size:13px;letter-spacing:.06em;text-transform:uppercase;transition:transform .2s,box-shadow .2s,background .2s,color .2s;cursor:pointer}
.bnc-btn svg{width:16px;height:16px}
.bnc-btn.primary{background:var(--lilac);color:#fff;box-shadow:var(--shadow-cta)}
.bnc-btn.primary:hover{background:var(--lilac-deep);transform:translateY(-1px);box-shadow:0 16px 32px rgba(167,123,190,.45)}
.bnc-btn.primary:active{transform:scale(.985)}
.bnc-btn.ghost{background:transparent;color:var(--ink-soft);border:1.5px solid var(--line)}
.bnc-btn.ghost:hover{background:var(--cream-2);color:var(--plum)}

.bnc-security-strip{margin-top:14px;display:flex;align-items:center;gap:10px;color:var(--ink-mute);font-size:12px;justify-content:center;flex-wrap:wrap}
.bnc-security-strip svg{width:14px;height:14px;color:var(--green-deep)}
.bnc-security-strip .dot{width:3px;height:3px;border-radius:50%;background:var(--ink-mute);opacity:.4}

@media (min-width:900px){
  .bnc-title h1{font-size:48px}
  .bnc-card{padding:26px 30px;border-radius:28px}
  .bnc-form-stack{gap:22px}
}
`;
