// aperture-6xjcw — mock data for /painel/[slug]/bancarios (Dados Bancários).
//
// In-memory, no persistence. Mirrors the standalone "Dados Bancários" export
// (app.jsx) where the creator chooses between a full bank account or a single
// Pix key for payout, both bound to the same CPF. Saving just updates local
// React state + fires a sonner toast — the real Pix DICT lookup / persistence
// is a later backend epic. Everything below is the "Thacyane" demo instance
// referenced in the mockup.

export interface BankOption {
  /** Compe code ("001", "260", …). */
  code: string;
  /** Display name shown in the picker. */
  name: string;
  /** Flag background colour (brand). */
  color: string;
  /** Flag text colour. */
  text: string;
  /** 2-letter short label on the flag chip. */
  short: string;
}

/** Banks offered in the picker — Compe codes + brand colours per the export. */
export const BANKS: BankOption[] = [
  { code: "001", name: "Banco do Brasil S.A.", color: "#FAE128", text: "#003B7A", short: "BB" },
  { code: "033", name: "Santander", color: "#EC0000", text: "#fff", short: "ST" },
  { code: "077", name: "Banco Inter", color: "#FF7A00", text: "#fff", short: "IN" },
  { code: "104", name: "Caixa Econômica Federal", color: "#0070AF", text: "#fff", short: "CX" },
  { code: "237", name: "Bradesco", color: "#CC092F", text: "#fff", short: "BR" },
  { code: "260", name: "Nubank", color: "#820AD1", text: "#fff", short: "NU" },
  { code: "290", name: "PagBank", color: "#048948", text: "#fff", short: "PG" },
  { code: "336", name: "C6 Bank", color: "#1C1C1C", text: "#fff", short: "C6" },
  { code: "341", name: "Itaú Unibanco", color: "#EC7000", text: "#003F8A", short: "IT" },
  { code: "380", name: "PicPay", color: "#11C76F", text: "#fff", short: "PP" },
];

export const bankByCode = (code: string): BankOption =>
  BANKS.find((b) => b.code === code) ?? BANKS[0]!;

export interface AccountType {
  v: string;
  label: string;
}

/** Account kinds (corrente / poupança / pagamento / salário). */
export const ACCOUNT_TYPES: AccountType[] = [
  { v: "cc", label: "Conta Corrente" },
  { v: "cp", label: "Conta Poupança" },
  { v: "pg", label: "Conta de Pagamento" },
  { v: "csl", label: "Conta Salário" },
];

export const accountTypeLabel = (v: string): string =>
  (ACCOUNT_TYPES.find((a) => a.v === v) ?? ACCOUNT_TYPES[0]!).label;

export type PixMask = "cpf" | "email" | "phone" | "rand";

export interface PixType {
  v: "cpf" | "email" | "celular" | "aleatoria";
  label: string;
  placeholder: string;
  help: string;
  mask: PixMask;
}

/** The four Pix key kinds + their input masks/helper copy (pt-BR). */
export const PIX_TYPES: PixType[] = [
  {
    v: "cpf",
    label: "CPF",
    placeholder: "000.000.000-00",
    help: "deve ser exatamente o cpf da conta — ",
    mask: "cpf",
  },
  {
    v: "email",
    label: "e-mail",
    placeholder: "voce@email.com",
    help: "e-mail vinculado a uma conta com este cpf",
    mask: "email",
  },
  {
    v: "celular",
    label: "celular",
    placeholder: "(00) 00000-0000",
    help: "celular vinculado a uma conta com este cpf",
    mask: "phone",
  },
  {
    v: "aleatoria",
    label: "aleatória",
    placeholder: "abc12345-67de-89fg-hijk-lmnop1234567",
    help: "chave aleatória gerada pelo seu banco",
    mask: "rand",
  },
];

/**
 * Fake "resolve Pix key → bank account" map. In production this is a Pix DICT
 * lookup; here it pretends the saved key points to Banco do Brasil so the
 * "preencher pra mim" auto-fill demo has something to write.
 */
export const PIX_RESOLVED = {
  bankCode: "001",
  agencia: "0983",
  agenciaDV: "0",
  conta: "28312",
  contaDV: "6",
  tipoConta: "cc",
  titular: "Thacyane Martinelli Maciel",
  finalDigits: "312-6",
} as const;

/** Recebimento mode — full account vs single Pix key. */
export type BancariosMode = "conta" | "pix";

/** The mutable form shape. */
export interface BancariosForm {
  bankCode: string;
  agencia: string;
  agenciaDV: string;
  conta: string;
  contaDV: string;
  tipoConta: string;
  pixKey: string;
  nome: string;
  telefone: string;
}

/** The creator's CPF — fixed at signup, can't be edited here. */
export const CPF_FIXO = "121.557.206-96";

/** Prefilled demo state ("Thacyane"), matching app.jsx's useState seed. */
export const BANCARIOS_DEMO: BancariosForm = {
  bankCode: "001",
  agencia: "0983",
  agenciaDV: "0",
  conta: "28312",
  contaDV: "6",
  tipoConta: "cc",
  pixKey: "121.557.206-96",
  nome: "Thacyane Martinelli Maciel",
  telefone: "(31) 99443-4155",
};

/** Default recebimento mode shown on load. */
export const BANCARIOS_DEFAULT_MODE: BancariosMode = "pix";
export const BANCARIOS_DEFAULT_PIX_TYPE: PixType["v"] = "cpf";
