import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { PermissoesEditor } from "./PermissoesEditor";
import { useAcessoCampanha } from "./useAcessoCampanha";

/**
 * aperture-1z18g — owner-only per-member permission toggles. Slotted into the
 * sharing panel (CompartilharBody), inside each member card's "Gerenciar"
 * panel. Renders NOTHING unless the viewer is the campanha's owner and the
 * target is a 'membro' (owners always have everything). Each toggle saves immediately; the server re-checks
 * ownership and the member's next request already sees the change.
 */

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

  return (
    <PermissoesEditor
      testId={`membro-permissoes-${idConta}`}
      legenda="O que essa pessoa pode fazer"
      permissoes={alvo.permissoes}
      disabled={definir.isPending}
      onChange={(permissoes) => definir.mutate({ idCampanha, idConta, permissoes })}
    />
  );
}
