import type { ReactNode } from "react";
import { useCampanhaEscrita } from "@/lib/campanha-escrita";
import type { AcaoCampanha } from "../../../../../../src/domain/arrecadacao/value-objects/permissao-campanha.js";
import { useAcessoCampanha } from "./useAcessoCampanha";

/**
 * aperture-1z18g — section-level gate for shared campanhas. Renders `children`
 * only when the caller holds `acao` on the routed campanha; otherwise a calm
 * "ask the owner" card. UI convenience only — the server enforces every
 * action independently.
 */
export function ComPermissao({
  acao,
  titulo,
  children,
}: {
  acao: AcaoCampanha;
  titulo: string;
  children: ReactNode;
}) {
  const idCampanha = useCampanhaEscrita();
  const acesso = useAcessoCampanha(idCampanha);
  if (!idCampanha || acesso.isLoading) {
    return (
      <div style={{ display: "flex", justifyContent: "center", padding: "48px 0" }}>
        <span className="perfil-spinner" aria-hidden="true" />
      </div>
    );
  }
  if (acesso.pode(acao)) return <>{children}</>;
  return <SemPermissao titulo={titulo} />;
}

export function SemPermissao({ titulo }: { titulo: string }) {
  return (
    <section
      className="painel-header-card"
      data-testid="sem-permissao"
      style={{ padding: "28px 22px", textAlign: "left" }}
    >
      <h1
        style={{
          fontFamily: "var(--font-patrick-hand), cursive",
          color: "var(--plum)",
          fontSize: 30,
          margin: 0,
        }}
      >
        {titulo}
      </h1>
      <p
        style={{
          fontFamily: "var(--font-dm-sans), system-ui, sans-serif",
          color: "var(--ink-soft)",
          fontSize: 15,
          lineHeight: 1.5,
          margin: "12px 0 0",
          maxWidth: 420,
        }}
      >
        Você ainda não tem permissão para esta parte da campanha. Peça para quem
        criou a campanha liberar o acesso.
      </p>
    </section>
  );
}
