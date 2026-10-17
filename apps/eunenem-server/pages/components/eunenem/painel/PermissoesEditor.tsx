import { type ReactNode, useEffect, useId, useState } from "react";
// Deep-leaf import (zod-only, pg-free) — see BancariosBody.tsx (aperture-9abwt).
import {
  ACOES_CONCEDIVEIS,
  type AcaoConcedivel,
  PERMISSOES_PADRAO_MEMBRO,
} from "../../../../../../src/domain/arrecadacao/value-objects/permissao-campanha.js";

/**
 * The permission editor of the sharing panel (aperture-e06nr redesign): a
 * three-way preset (Ajudante / Acesso total / Personalizar) over the per-action
 * switches, grouped Evento / Financeiro. Used for the invite form, pending
 * invites (CompartilharBody, aperture-m3vx4) and members
 * (MembroPermissoesToggles), so the owner sees the same choices before and
 * after an invite is accepted. Styles live in CompartilharBody's CMP_CSS.
 */

type Grupo = "evento" | "financeiro";

export const ROTULO_ACAO: Record<AcaoConcedivel, { titulo: string; grupo: Grupo; icone: ReactNode }> = {
  "presentes:gerenciar": { titulo: "Editar a lista de presentes", grupo: "evento", icone: <IGift /> },
  "perfil:editar": { titulo: "Editar o perfil da página", grupo: "evento", icone: <IPencil /> },
  "mensagens:ver": { titulo: "Ler os recados", grupo: "evento", icone: <IChat /> },
  "mensagens:gerenciar": { titulo: "Marcar recados como lidos", grupo: "evento", icone: <IChatCheck /> },
  "convidados:ver": { titulo: "Ver a lista de convidados", grupo: "evento", icone: <IPeople /> },
  "convite:editar": { titulo: "Editar o convite e os convidados", grupo: "evento", icone: <IEnvelope /> },
  "link:editar": { titulo: "Mudar o link da página", grupo: "evento", icone: <ILink /> },
  "extrato:ver": { titulo: "Ver o extrato", grupo: "financeiro", icone: <IReceipt /> },
  "recebedor:gerenciar": { titulo: "Ver e editar os dados bancários", grupo: "financeiro", icone: <IBank /> },
  "saque:solicitar": { titulo: "Pedir transferência do saldo", grupo: "financeiro", icone: <IArrows /> },
};

const GRUPOS: { id: Grupo; titulo: string }[] = [
  { id: "evento", titulo: "Evento" },
  { id: "financeiro", titulo: "Financeiro" },
];

export type Preset = "ajudante" | "total" | "personalizado";

export const ROTULO_PRESET: Record<Preset, string> = {
  ajudante: "Ajudante",
  total: "Acesso total",
  personalizado: "Personalizado",
};

const mesmoConjunto = (a: readonly AcaoConcedivel[], b: readonly AcaoConcedivel[]) =>
  a.length === b.length && a.every((acao) => b.includes(acao));

/** Which preset a permission set corresponds to (anything else is custom). */
export function presetDe(permissoes: readonly AcaoConcedivel[]): Preset {
  if (mesmoConjunto(permissoes, PERMISSOES_PADRAO_MEMBRO)) return "ajudante";
  if (mesmoConjunto(permissoes, ACOES_CONCEDIVEIS)) return "total";
  return "personalizado";
}

/** One short line describing what the chosen set allows. */
export function resumoPermissoes(permissoes: readonly AcaoConcedivel[], preset: Preset): string {
  if (preset === "ajudante")
    return "Cuida da lista, do perfil, dos recados e do convite. Não mexe no link nem no dinheiro.";
  if (preset === "total")
    return "Pode tudo, inclusive ver o extrato, editar os dados bancários e pedir transferências.";
  const conta = (grupo: Grupo) => {
    const doGrupo = ACOES_CONCEDIVEIS.filter((a) => ROTULO_ACAO[a].grupo === grupo);
    return `${doGrupo.filter((a) => permissoes.includes(a)).length} de ${doGrupo.length}`;
  };
  if (permissoes.length === 0) return "Nada marcado: a pessoa só vê a página no painel.";
  return `${conta("evento")} no evento, ${conta("financeiro")} no financeiro.`;
}

const OPCOES: { id: Preset; rotulo: string }[] = [
  { id: "ajudante", rotulo: "Ajudante" },
  { id: "total", rotulo: "Acesso total" },
  { id: "personalizado", rotulo: "Personalizar" },
];

export function PermissoesEditor({
  legenda,
  permissoes,
  onChange,
  disabled,
  testId,
  resumoTestId,
}: {
  legenda: string;
  permissoes: readonly AcaoConcedivel[];
  onChange: (proximas: AcaoConcedivel[]) => void;
  disabled?: boolean;
  testId?: string;
  resumoTestId?: string;
}) {
  // Reflect a click immediately; the parent's (possibly async, optimistic)
  // update or rollback re-syncs it through `permissoes`.
  const chave = permissoes.join(",");
  const [marcadas, setMarcadas] = useState<readonly AcaoConcedivel[]>(permissoes);
  // `chave` is the content of `permissoes` (a new array each render).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => setMarcadas(permissoes), [chave]);
  // "Personalizar" is sticky while open, even if the switches happen to land
  // on a preset's exact set; a custom set always shows the switches.
  const [personalizando, setPersonalizando] = useState(presetDe(permissoes) === "personalizado");
  const derivado = presetDe(marcadas);
  const preset: Preset = personalizando || derivado === "personalizado" ? "personalizado" : derivado;
  const nome = useId();

  const aplicar = (proximas: AcaoConcedivel[]) => {
    setMarcadas(proximas);
    onChange(proximas);
  };
  const escolher = (opcao: Preset) => {
    if (opcao === "personalizado") return setPersonalizando(true);
    setPersonalizando(false);
    const alvo = opcao === "ajudante" ? PERMISSOES_PADRAO_MEMBRO : ACOES_CONCEDIVEIS;
    if (!mesmoConjunto(alvo, marcadas)) aplicar([...alvo]);
  };
  const alternar = (acao: AcaoConcedivel, ligado: boolean) => {
    const proximo = new Set(marcadas);
    if (ligado) proximo.add(acao);
    else proximo.delete(acao);
    aplicar(ACOES_CONCEDIVEIS.filter((a) => proximo.has(a)));
  };

  return (
    <fieldset className="cmp-perm" data-testid={testId} disabled={disabled}>
      <legend className="cmp-perm-legend">{legenda}</legend>
      <div className="cmp-seg">
        {OPCOES.map((opcao) => (
          <label key={opcao.id} className={`cmp-seg-opt${preset === opcao.id ? " on" : ""}`}>
            <input
              type="radio"
              name={nome}
              value={opcao.id}
              checked={preset === opcao.id}
              onChange={() => escolher(opcao.id)}
            />
            {opcao.rotulo}
          </label>
        ))}
      </div>
      <p className="cmp-perm-resumo" data-testid={resumoTestId}>
        {resumoPermissoes(marcadas, preset)}
      </p>
      {preset === "personalizado" && (
        <div className="cmp-perm-grupos">
          {GRUPOS.map((grupo) => (
            <div key={grupo.id} className={`cmp-perm-grupo ${grupo.id}`}>
              <p className="cmp-perm-grupo-titulo">
                {grupo.titulo}
                {grupo.id === "financeiro" && <span>envolve dinheiro</span>}
              </p>
              {ACOES_CONCEDIVEIS.filter((a) => ROTULO_ACAO[a].grupo === grupo.id).map((acao) => (
                <label key={acao} className="cmp-switch-row">
                  <span className="cmp-switch-ico" aria-hidden="true">
                    {ROTULO_ACAO[acao].icone}
                  </span>
                  <span className="cmp-switch-txt">{ROTULO_ACAO[acao].titulo}</span>
                  <input
                    className="cmp-switch"
                    type="checkbox"
                    role="switch"
                    checked={marcadas.includes(acao)}
                    onChange={(e) => alternar(acao, e.currentTarget.checked)}
                    data-acao={acao}
                  />
                </label>
              ))}
            </div>
          ))}
        </div>
      )}
    </fieldset>
  );
}

// Line icons, 24px grid, stroke = currentColor (same idiom as BancariosBody).
function Icon({ children }: { children: ReactNode }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {children}
    </svg>
  );
}
function IGift() {
  return (
    <Icon>
      <rect x="3" y="8" width="18" height="4" rx="1" />
      <path d="M5 12v8h14v-8M12 8v12M12 8S10.5 4 8 4a2 2 0 0 0 0 4M12 8s1.5-4 4-4a2 2 0 0 1 0 4" />
    </Icon>
  );
}
function IPencil() {
  return (
    <Icon>
      <path d="M4 20h4L19 9l-4-4L4 16v4zM13.5 6.5l4 4" />
    </Icon>
  );
}
function IChat() {
  return (
    <Icon>
      <path d="M4 5h16v11H9l-5 4V5z" />
    </Icon>
  );
}
function IChatCheck() {
  return (
    <Icon>
      <path d="M4 5h16v11H9l-5 4V5z" />
      <path d="M9 10.5l2 2 4-4" />
    </Icon>
  );
}
function IPeople() {
  return (
    <Icon>
      <circle cx="9" cy="8" r="3" />
      <path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6M16 5a3 3 0 0 1 0 6M18 14c1.8.8 3 2.7 3 5" />
    </Icon>
  );
}
function IEnvelope() {
  return (
    <Icon>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="M3 7l9 6 9-6" />
    </Icon>
  );
}
function ILink() {
  return (
    <Icon>
      <path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" />
    </Icon>
  );
}
function IReceipt() {
  return (
    <Icon>
      <path d="M6 3h12v18l-3-2-3 2-3-2-3 2V3zM9 8h6M9 12h6" />
    </Icon>
  );
}
function IBank() {
  return (
    <Icon>
      <path d="M3 10l9-6 9 6M5 10v8M9.5 10v8M14.5 10v8M19 10v8M3 20h18" />
    </Icon>
  );
}
function IArrows() {
  return (
    <Icon>
      <path d="M4 8h14l-3-3M20 16H6l3 3" />
    </Icon>
  );
}
