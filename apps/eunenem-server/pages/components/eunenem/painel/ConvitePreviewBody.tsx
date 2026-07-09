import { useMe } from '@/lib/auth';
import { conviteStateFromData, useConvitePreviewData } from '@/lib/convite';
import { menuItemHref, painelConvitePreviewHref, painelHref } from '@/lib/painelRoutes';
import { InvitePreview } from './ConviteBody';
import { useCampanhaRota } from "@/lib/campanha-rota";

const PREVIEW_CSS = `
.cv-preview-btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;padding:11px 18px;border-radius:999px;border:1px solid transparent;background:var(--lilac);color:#fff;font-family:var(--font-dm-sans),sans-serif;font-weight:600;font-size:12.5px;letter-spacing:.08em;text-transform:uppercase;cursor:pointer;transition:transform .12s,box-shadow .15s,background .15s;color-scheme:light;text-decoration:none;box-shadow:var(--shadow-cta);white-space:nowrap}
.cv-preview-btn:hover:not(:disabled){transform:translateY(-1px);background:var(--lilac-deep)}
.cv-preview-btn:disabled{opacity:.4;cursor:not-allowed;box-shadow:none}
.cv-preview-btn.sm{padding:8px 13px;font-size:11px}
.cv-preview-btn.ghost{background:transparent;color:var(--ink);border-color:var(--cv-line-strong);box-shadow:none}
.cv-preview-btn.ghost:hover:not(:disabled){background:var(--cream-2);color:var(--plum)}
@media (prefers-reduced-motion: reduce){
  .cv-preview-btn{transition:none}
}
`;

export function ConvitePreviewBody({
  slug,
}: {
  slug: string;
}) {
  const idCampanha = useCampanhaRota();
  const conviteQuery = useConvitePreviewData(slug);
  // aperture — same ownership probe as Navbar.tsx: the signed-in user owns
  // this convite iff their session slug matches the slug being previewed.
  // Anonymous visitors (me.data null) or a different account never satisfy
  // this, so they get the "ver lista de presentes" CTA instead of "editar".
  const me = useMe();
  const isOwner = me.data?.slug === slug;

  if (conviteQuery.isLoading) {
    return (
      <section className="mx-auto flex w-full max-w-[1080px] flex-col gap-4 px-4 py-8 md:px-6">
        <style>{PREVIEW_CSS}</style>
        <span className="text-sm text-[var(--ink-soft)]">carregando seu convite...</span>
      </section>
    );
  }

  if (conviteQuery.error) {
    return (
      <section className="mx-auto flex w-full max-w-[1080px] flex-col gap-4 px-4 py-8 md:px-6">
        <style>{PREVIEW_CSS}</style>
        <span className="text-sm text-[var(--ink-soft)]">
          não consegui carregar o convite salvo agora.
        </span>
        <div className="flex flex-wrap gap-3">
          <a href={painelHref(slug, 'convite', idCampanha)} className="cv-preview-btn ghost sm">
            voltar para editar
          </a>
          <button type="button" className="cv-preview-btn ghost sm" onClick={() => void conviteQuery.refetch()}>
            tentar de novo
          </button>
        </div>
      </section>
    );
  }

  if (!conviteQuery.data?.evento || !conviteQuery.data?.convite) {
    return (
      <section className="mx-auto flex w-full max-w-[1080px] flex-col gap-4 px-4 py-8 md:px-6">
        <style>{PREVIEW_CSS}</style>
        <span className="text-sm text-[var(--ink-soft)]">ainda não existe convite salvo para esse painel.</span>
        <div className="flex flex-wrap gap-3">
          <a href={painelHref(slug, 'convite', idCampanha)} className="cv-preview-btn ghost sm">
            criar convite
          </a>
          <a href={painelConvitePreviewHref(slug, idCampanha)} className="cv-preview-btn ghost sm">
            atualizar página
          </a>
        </div>
      </section>
    );
  }

  const state = conviteStateFromData(conviteQuery.data);

  return (
    <section
      data-testid="convite-saved-state"
      className="mx-auto flex w-full max-w-[1080px] flex-col items-center gap-6 px-4 py-8 md:px-6"
    >
      <style>{PREVIEW_CSS}</style>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'minmax(0, 1fr)',
          gap: 24,
          alignItems: 'start',
        }}
      >
        <div
          style={{
            display: 'flex',
            justifyContent: 'center',
            padding: '16px',
            background: 'rgba(255,255,255,.72)',
            border: '1px solid var(--line)',
            borderRadius: 24,
          }}
        >
          <InvitePreview
            state={state}
            format="story"
            fidelity="scrapbook"
            scale={0.78}
          />
        </div>
      </div>

      {!me.isLoading &&
        (isOwner ? (
          <a href={painelHref(slug, 'convite')} className="cv-preview-btn ghost sm">
            editar convite
          </a>
        ) : (
          <a href={menuItemHref(slug, 'preview')} className="cv-preview-btn sm">
            Ver lista de presentes
          </a>
        ))}
    </section>
  );
}
