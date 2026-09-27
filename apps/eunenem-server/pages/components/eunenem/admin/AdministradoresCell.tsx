import { paginaSharePath } from "@/lib/painelRoutes";

/**
 * Administradores reais de uma campanha + links da campanha (aperture-9bpre).
 *
 * "Usuário" aqui é quem ADMINISTRA a campanha (`campanha_administradores`) —
 * nunca o pagador nem o titular bancário. A lista exibida pode estar
 * truncada; `total` e `publicOwnerSlug` vêm do servidor, calculados sobre a
 * campanha inteira, então a lista curta nunca decide se o link público
 * existe.
 */

export interface AdministradorExibido {
  idConta: string;
  displayName: string | null;
  email: string | null;
  hasUserRow: boolean;
}

export interface AdministradoresResumo {
  shown: readonly AdministradorExibido[];
  total: number;
}

const LINK =
  "text-plum underline underline-offset-2 hover:text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-plum";

function contaCurta(idConta: string): string {
  return `conta ${idConta.slice(0, 8)}…`;
}

/** Um administrador: link ao detalhe quando há cadastro; texto puro quando não. */
export function AdministradorItem({ admin }: { admin: AdministradorExibido }) {
  if (!admin.hasUserRow) {
    return (
      <>
        <span className="font-mono text-[11px] text-ink-soft">{contaCurta(admin.idConta)}</span>
        <span className="block text-[10px] text-ink-mute">sem cadastro nesta plataforma</span>
      </>
    );
  }
  return (
    <>
      <a className={`font-medium ${LINK}`} href={`/admin/usuario/${admin.idConta}`}>
        {admin.displayName ?? contaCurta(admin.idConta)}
      </a>
      {admin.email ? (
        <span className="block break-all text-[10px] text-ink-mute">{admin.email}</span>
      ) : null}
    </>
  );
}

export function AdministradoresCell({
  administrators,
  campaignId,
}: {
  administrators: AdministradoresResumo;
  campaignId: string;
}) {
  if (administrators.total === 0) {
    return <span className="italic text-ink-mute">sem administrador registrado</span>;
  }
  const ocultos = administrators.total - administrators.shown.length;
  return (
    <div className="min-w-[11rem] space-y-1.5">
      <ul className="space-y-1.5">
        {administrators.shown.map((admin) => (
          <li key={admin.idConta}>
            <AdministradorItem admin={admin} />
          </li>
        ))}
      </ul>
      {ocultos > 0 ? (
        <a className={`block text-[11px] ${LINK}`} href={`/admin/campanha/${campaignId}`}>
          +{ocultos} · ver os {administrators.total} administradores
        </a>
      ) : null}
    </div>
  );
}

/** Caminho público canônico, ou null quando nenhum administrador é elegível. */
export function campanhaPublicaPath(input: {
  publicOwnerSlug: string | null;
  campaignId: string;
  campaignSlug: string | null;
}): string | null {
  if (input.publicOwnerSlug === null) return null;
  return paginaSharePath(input.publicOwnerSlug, input.campaignId, input.campaignSlug);
}

/**
 * Links de uma campanha numa célula de tabela. `paymentId` presente adiciona
 * "Ver pagamento" — o destino que o título da campanha tinha antes.
 */
export function CampanhaLinks({
  campaignId,
  campaignSlug,
  publicOwnerSlug,
  paymentId,
}: {
  campaignId: string;
  campaignSlug: string | null;
  publicOwnerSlug: string | null;
  paymentId?: string;
}) {
  const publica = campanhaPublicaPath({ publicOwnerSlug, campaignId, campaignSlug });
  return (
    <ul className="mt-1 space-y-0.5 text-[11px]">
      {paymentId ? (
        <li>
          <a className={LINK} href={`/admin/pagamento/${paymentId}`}>
            Ver pagamento
          </a>
        </li>
      ) : null}
      <li>
        <a className={LINK} href={`/admin/campanha/${campaignId}`}>
          Campanha no admin
        </a>
      </li>
      <li>
        {publica ? (
          <a className={LINK} href={publica} target="_blank" rel="noopener noreferrer">
            Abrir campanha pública
            <span className="sr-only"> (abre em nova aba)</span>
            <span aria-hidden> ↗</span>
          </a>
        ) : (
          <span className="italic text-ink-mute">página pública indisponível</span>
        )}
      </li>
    </ul>
  );
}
