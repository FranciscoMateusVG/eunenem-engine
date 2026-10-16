import { useEffect, useState } from "react";
// Deep-leaf import (zod-only, pg-free) — see BancariosBody.tsx (aperture-9abwt).
import {
  ACOES_CONCEDIVEIS,
  type AcaoConcedivel,
} from "../../../../../../src/domain/arrecadacao/value-objects/permissao-campanha.js";

/**
 * The per-action permission checkboxes of the sharing panel, grouped (lista /
 * FINANCEIRO). Used for members (MembroPermissoesToggles), the invite form and
 * pending invites (CompartilharBody, aperture-m3vx4), so the owner sees the
 * same choices before and after an invite is accepted.
 */

export const ROTULO_ACAO: Record<AcaoConcedivel, { titulo: string; grupo: "lista" | "financeiro" }> = {
  "presentes:gerenciar": { titulo: "editar a lista de presentes", grupo: "lista" },
  "perfil:editar": { titulo: "editar o perfil da campanha", grupo: "lista" },
  "mensagens:ver": { titulo: "ver os recados", grupo: "lista" },
  "mensagens:gerenciar": { titulo: "marcar recados como lidos", grupo: "lista" },
  "convidados:ver": { titulo: "ver a lista de convidados", grupo: "lista" },
  "convite:editar": { titulo: "editar o convite e os convidados", grupo: "lista" },
  "link:editar": { titulo: "alterar o link da página", grupo: "lista" },
  "extrato:ver": { titulo: "ver o extrato financeiro", grupo: "financeiro" },
  "recebedor:gerenciar": { titulo: "ver e editar os dados bancários", grupo: "financeiro" },
  "saque:solicitar": { titulo: "solicitar transferência", grupo: "financeiro" },
};

/** Plain-language summary of what a permission set allows. */
export function resumoPermissoes(permissoes: readonly AcaoConcedivel[]): string {
  const titulos = ACOES_CONCEDIVEIS.filter((a) => permissoes.includes(a)).map(
    (a) => ROTULO_ACAO[a].titulo,
  );
  if (titulos.length === 0)
    return "Nada marcado: a pessoa acessa a campanha, mas não pode alterar nem ver nada restrito.";
  const lista =
    titulos.length === 1
      ? titulos[0]
      : `${titulos.slice(0, -1).join(", ")} e ${titulos[titulos.length - 1]}`;
  return `Com o que está marcado, a pessoa poderá ${lista}.`;
}

export function PermissoesCheckboxes({
  legenda,
  permissoes,
  onChange,
  disabled,
  testId,
}: {
  legenda: string;
  permissoes: readonly AcaoConcedivel[];
  onChange: (proximas: AcaoConcedivel[]) => void;
  disabled?: boolean;
  testId?: string;
}) {
  // Reflect a click immediately; the parent's (possibly async, optimistic)
  // update or rollback re-syncs it through `permissoes`.
  const chave = permissoes.join(",");
  const [marcadas, setMarcadas] = useState<readonly AcaoConcedivel[]>(permissoes);
  // `chave` is the content of `permissoes` (a new array each render).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => setMarcadas(permissoes), [chave]);
  const atuais = new Set<AcaoConcedivel>(marcadas);
  const alternar = (acao: AcaoConcedivel, ligado: boolean) => {
    const proximo = new Set(atuais);
    if (ligado) proximo.add(acao);
    else proximo.delete(acao);
    const proximas = ACOES_CONCEDIVEIS.filter((a) => proximo.has(a));
    setMarcadas(proximas);
    onChange(proximas);
  };

  return (
    <fieldset
      data-testid={testId}
      style={{
        border: "none",
        margin: "10px 0 0",
        padding: 0,
        display: "grid",
        gap: 6,
        fontFamily: "var(--font-dm-sans), system-ui, sans-serif",
        fontSize: 14,
        color: "var(--ink-soft)",
      }}
    >
      <legend style={{ color: "var(--plum)", fontWeight: 600, marginBottom: 4 }}>{legenda}</legend>
      {(["lista", "financeiro"] as const).map((grupo) => (
        <div key={grupo} style={{ display: "grid", gap: 4 }}>
          {grupo === "financeiro" && (
            <span style={{ fontSize: 12, textTransform: "uppercase", letterSpacing: 0.4 }}>
              financeiro
            </span>
          )}
          {ACOES_CONCEDIVEIS.filter((a) => ROTULO_ACAO[a].grupo === grupo).map((acao) => (
            <label
              key={acao}
              style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}
            >
              <input
                type="checkbox"
                checked={atuais.has(acao)}
                disabled={disabled}
                onChange={(e) => alternar(acao, e.currentTarget.checked)}
                data-acao={acao}
              />
              {ROTULO_ACAO[acao].titulo}
            </label>
          ))}
        </div>
      ))}
    </fieldset>
  );
}
