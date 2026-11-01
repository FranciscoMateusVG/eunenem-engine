// aperture-0vne4 — an admin of the campanha (owner, or member with
// presentes:gerenciar) viewing their own /pagina gets the painel's edit/remove
// buttons on each gift card, with the same modals and rules (removal blocked
// after the first purchase, legacy groups not editable). Guests never mount
// any of this: it is gated on the server projection's isOwner, then on
// campanhaMembros.meuAcesso; the server enforces the permission again on
// every write.

import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { CampanhaRotaProvider, useCampanhaRota } from '@/lib/campanha-rota';
import type { ContribuicaoDTO } from '@/lib/contribuicao.js';
import { trpc } from '@/lib/trpc';
import type { VisitorGift } from '@/lib/visitorGift';
import {
  GiftCardActions,
  type GroupedGift,
  groupContribuicoes,
  useGiftItemEditor,
} from './painel/ListaPresentesBody';
import { useAcessoCampanha } from './painel/useAcessoCampanha';

interface OwnerGiftEditor {
  itemFor: (gift: VisitorGift) => GroupedGift | null;
  edit: (item: GroupedGift) => void;
  remove: (item: GroupedGift) => void;
}

const OwnerGiftEditorContext = createContext<OwnerGiftEditor | null>(null);

export function PaginaOwnerGiftEditorProvider({
  idCampanha,
  isAdmin,
  children,
}: {
  idCampanha: string | null | undefined;
  /** perfil.getPerfilPublicoBySlug's isOwner: the session administers this campanha. */
  isAdmin: boolean;
  children: ReactNode;
}) {
  const rotaPublica = useCampanhaRota();
  if (!isAdmin || !idCampanha) return <>{children}</>;
  // Writes address the viewed campanha; the public list keeps its own route scope.
  return (
    <CampanhaRotaProvider idCampanha={idCampanha}>
      <AdminEditor idCampanha={idCampanha} rotaPublica={rotaPublica}>
        {children}
      </AdminEditor>
    </CampanhaRotaProvider>
  );
}

function AdminEditor({
  idCampanha,
  rotaPublica,
  children,
}: {
  idCampanha: string;
  rotaPublica: string | undefined;
  children: ReactNode;
}) {
  const acesso = useAcessoCampanha(idCampanha);
  const podeEditar = acesso.pode('presentes:gerenciar');
  const utils = trpc.useUtils();
  const listQuery = trpc.contribuicao.list.useQuery({ idCampanha }, { enabled: podeEditar });
  const refreshPublicList = () => void utils.pagina.obterListaPresentes.invalidate();
  const editor = useGiftItemEditor({
    onStale: () => {
      void listQuery.refetch();
      refreshPublicList();
    },
    onChanged: refreshPublicList,
  });
  const grouped = useMemo(
    () => groupContribuicoes((listQuery.data ?? []) as ContribuicaoDTO[]),
    [listQuery.data],
  );
  const { setEditItem, setRemoveItem } = editor;
  const value = useMemo<OwnerGiftEditor | null>(
    () =>
      podeEditar && listQuery.data
        ? {
            // Both lists group by nome; match on any shared contribuicao id.
            itemFor: (gift) => grouped.find((g) => g.ids.some((id) => gift.ids.includes(id))) ?? null,
            edit: setEditItem,
            remove: setRemoveItem,
          }
        : null,
    [podeEditar, listQuery.data, grouped, setEditItem, setRemoveItem],
  );
  return (
    <OwnerGiftEditorContext.Provider value={value}>
      <CampanhaRotaProvider idCampanha={rotaPublica}>{children}</CampanhaRotaProvider>
      {editor.modals}
    </OwnerGiftEditorContext.Provider>
  );
}

/** Edit/remove buttons for one public gift card; null for everyone but list editors. */
export function OwnerGiftActions({ gift }: { gift: VisitorGift }) {
  const editor = useContext(OwnerGiftEditorContext);
  const item = editor?.itemFor(gift);
  if (!editor || !item) return null;
  return <GiftCardActions item={item} onEdit={editor.edit} onRemove={editor.remove} />;
}
