import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
// Deep-leaf import (zod-only, pg-free) — see BancariosBody.tsx (aperture-9abwt).
import {
  ACOES_CONCEDIVEIS,
  type AcaoConcedivel,
} from "../../../../../../src/domain/arrecadacao/value-objects/permissao-campanha.js";
import { useAcessoCampanha } from "./useAcessoCampanha";

/**
 * aperture-1z18g — owner-only per-member permission toggles. Slotted into the
 * sharing panel (CompartilharBody) once per member row. Renders NOTHING unless
 * the viewer is the campanha's owner and the target is a 'membro' (owners
 * always have everything). Each toggle saves immediately; the server re-checks
 * ownership and the member's next request already sees the change.
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

export function MembroPermissoesToggles({
  idCampanha,
  idConta,
}: {
  idCampanha: string;
  idConta: string;
}) {
  const acesso = useAcessoCampanha(idCampanha);
  const souOwner = acesso.papel === "owner";
  const utils = trpc.useUtils();
  const membros = trpc.campanhaMembros.listar.useQuery({ idCampanha }, { enabled: souOwner });
  const definir = trpc.campanhaMembros.definirPermissoes.useMutation({
    onMutate: async ({ permissoes }) => {
      await utils.campanhaMembros.listar.cancel({ idCampanha });
      const anterior = utils.campanhaMembros.listar.getData({ idCampanha });
      utils.campanhaMembros.listar.setData({ idCampanha }, (lista) =>
        lista?.map((m) => (m.idConta === idConta ? { ...m, permissoes } : m)),
      );
      return { anterior };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.anterior) utils.campanhaMembros.listar.setData({ idCampanha }, ctx.anterior);
      toast.error("não consegui salvar a permissão — tente de novo");
    },
    onSettled: () => {
      void utils.campanhaMembros.listar.invalidate({ idCampanha });
    },
  });

  if (!souOwner) return null;
  const alvo = membros.data?.find((m) => m.idConta === idConta);
  if (!alvo || alvo.papel !== "membro") return null;

  const atuais = new Set<AcaoConcedivel>(alvo.permissoes);
  const alternar = (acao: AcaoConcedivel, ligado: boolean) => {
    const proximo = new Set(atuais);
    if (ligado) proximo.add(acao);
    else proximo.delete(acao);
    definir.mutate({
      idCampanha,
      idConta,
      permissoes: ACOES_CONCEDIVEIS.filter((a) => proximo.has(a)),
    });
  };

  return (
    <fieldset
      data-testid={`membro-permissoes-${idConta}`}
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
      <legend style={{ color: "var(--plum)", fontWeight: 600, marginBottom: 4 }}>
        o que essa pessoa pode fazer
      </legend>
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
                disabled={definir.isPending}
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
