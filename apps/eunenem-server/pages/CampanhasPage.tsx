/**
 * aperture-g7l09 — /campanhas: the multicampanha migration bridge (POC).
 *
 * Mixed grid of the user's campaigns across BOTH platforms:
 *   - 2.0 cards → /painel/<slug> (the new-platform dashboard)
 *   - 1.0 cards → https://eunenem.com/migracao (the old site's explainer
 *     page: re-login is intentional → Clerk modal → /minha-area; real
 *     <a href>, per Izzy's testability + a11y request)
 *   - NOVA LISTA card → name-only create modal → campanhas.criar
 *     (aperture-rurre; V1 stays on /campanhas — no per-campanha routing)
 *
 * First visit + user HAS legacy entries → welcome modal explaining the
 * 1.0/2.0 split (the two platforms are separate — no data transfer). The
 * modal is skipped for pure-2.0 users: the copy is about "sua conta
 * anterior", which they don't have. Dismissal persists via localStorage
 * (CAMPANHAS_WELCOME_STORAGE_KEY). "SABER MAIS" (and the hero's "como
 * funciona? ♡") open a 2-step tour — both straight from the operator's
 * Multicampanhas.pdf reference.
 *
 * Design source of truth: ~/Downloads/Multicampanhas.pdf (operator artifact,
 * 2026-07-01). Visual vocabulary: the modal's rotated 1.0/2.0 squircle selos
 * are carried onto every grid card (top-right, countering the tape's tilt)
 * so the user always knows which platform a card belongs to — WCAG 1.4.1
 * satisfied by the text inside the selo, not color alone.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { SetupCampanhaWizard } from './components/eunenem/campanhas/SetupCampanhaWizard.js';
import { PainelTopbar } from './components/eunenem/painel/PainelTopbar.js';
import {
  CAMPANHAS_WELCOME_STORAGE_KEY,
  LEGACY_MIGRACAO_URL,
  useCampanhasCriar,
  useCampanhasList,
  type CampanhaLegadoDTO,
  type CampanhaNovaDTO,
} from './lib/campanhas.js';
import { trpc } from './lib/trpc.js';

/* Scrapbook cycles — same rotation the reference artifact uses. */
const TINTS = ['var(--lilac-soft)', 'var(--pink-soft)', '#def1f3', '#eef3d6'];
const TAPES = ['var(--yellow)', 'var(--green)', 'var(--coral-pink)', 'var(--blue)'];
const TILTS = ['rotate(-1deg)', 'rotate(1deg)'];

function firstName(nomeExibicao: string | undefined): string {
  const first = (nomeExibicao ?? '').trim().split(/\s+/)[0];
  return first || 'você';
}

function mimosLabel(n: number): string {
  return `${n} ${n === 1 ? 'mimo' : 'mimos'} ♡`;
}

/** Escape closes whichever modal layer is on top. */
function useEscape(active: boolean, onEscape: () => void) {
  useEffect(() => {
    if (!active) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onEscape();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [active, onEscape]);
}

export function CampanhasPage() {
  const meQ = trpc.auth.me.useQuery();
  const listQ = useCampanhasList();

  const [welcomeOpen, setWelcomeOpen] = useState(false);
  const [tourOpen, setTourOpen] = useState(false);
  const [tourStep, setTourStep] = useState(0);

  const me = meQ.data;
  const nome = firstName(me?.nomeExibicao);
  const novas = listQ.data?.novas ?? [];
  const legado = listQ.data?.legado ?? [];
  const temLegado = legado.length > 0;

  // Logged-out visitors have nothing to see here — back to the landing.
  // auth.me resolves to null (not an error) for anonymous sessions.
  useEffect(() => {
    if (meQ.isLoading || meQ.data !== null) return;
    window.location.assign('/');
  }, [meQ.isLoading, meQ.data]);

  // First-visit welcome modal — only for users with 1.0 history (the copy
  // is meaningless for pure-2.0 accounts). Shows on every visit until the
  // user EXPLICITLY opts out via the checkbox (aperture-opfsj) — a plain
  // dismiss no longer persists anything.
  useEffect(() => {
    if (!listQ.data || listQ.data.legado.length === 0) return;
    if (window.localStorage.getItem(CAMPANHAS_WELCOME_STORAGE_KEY)) return;
    setWelcomeOpen(true);
  }, [listQ.data]);

  // aperture-opfsj — opt-out consent, default unchecked. All four dismiss
  // paths (OK, SABER MAIS, overlay-click, Escape) funnel through
  // dismissWelcome below, so the checkbox is honored everywhere by
  // construction.
  const [naoVerNovamente, setNaoVerNovamente] = useState(false);

  const dismissWelcome = useCallback(
    (openTourAfter: boolean) => {
      // Persist ONLY on explicit opt-out — an unchecked dismiss lets the
      // recadinho greet the user again next visit (operator request).
      if (naoVerNovamente) {
        window.localStorage.setItem(CAMPANHAS_WELCOME_STORAGE_KEY, '1');
      }
      setWelcomeOpen(false);
      if (openTourAfter) {
        setTourStep(0);
        setTourOpen(true);
      }
    },
    [naoVerNovamente],
  );

  const openTour = useCallback(() => {
    setTourStep(0);
    setTourOpen(true);
  }, []);

  useEscape(tourOpen, () => setTourOpen(false));
  useEscape(welcomeOpen && !tourOpen, () => dismissWelcome(false));

  // aperture-rurre — NOVA LISTA V1: real create flow (replaces the POC
  // stub toast). Name-only modal → campanhas.criar({titulo}) → invalidate
  // campanhas.list → the new card appears in the grid; we STAY on
  // /campanhas (campanhas have no slug / per-campanha routing in V1).
  const [novaOpen, setNovaOpen] = useState(false);
  const [novoTitulo, setNovoTitulo] = useState('');
  // aperture-1yx1n §1.5 — the setup wizard opens right after criar (and from
  // a card's "completar" affordance). null = closed.
  const [setupCampanha, setSetupCampanha] = useState<{
    id: string;
    titulo: string;
    // aperture-y8e9w — the campanha's current slug (completar re-entry):
    // the wizard prefills it and re-confirming it says so, instead of the
    // misleading fresh-grab 'disponível'.
    campanhaSlug?: string | null;
  } | null>(null);
  const utils = trpc.useUtils();
  const criarM = useCampanhasCriar({
    onSuccess: (data) => {
      void utils.campanhas.list.invalidate();
      setNovaOpen(false);
      setNovoTitulo('');
      // The wizard IS the continuation — no toast between the two moments.
      setSetupCampanha({ id: data.id, titulo: data.titulo });
    },
    onError: () => {
      // Saga-compensated backend — nothing half-created. Keep the modal
      // open so the typed name isn't lost.
      toast.error('não conseguimos criar sua lista agora — tenta de novo?');
    },
  });

  const onNovaLista = useCallback(() => {
    setNovoTitulo('');
    setNovaOpen(true);
  }, []);

  const fecharNova = useCallback(() => {
    if (criarM.isPending) return; // don't yank the modal mid-flight
    setNovaOpen(false);
  }, [criarM.isPending]);

  const submitNova = useCallback(() => {
    const titulo = novoTitulo.trim();
    if (!titulo || criarM.isPending) return;
    criarM.mutate({ titulo });
  }, [novoTitulo, criarM]);

  useEscape(novaOpen && !tourOpen, fecharNova);

  const fecharSetup = useCallback(() => setSetupCampanha(null), []);
  useEscape(setupCampanha !== null, fecharSetup);
  const abrirSetupDoCard = useCallback((c: CampanhaNovaDTO) => {
    setSetupCampanha({ id: c.id, titulo: c.titulo, campanhaSlug: c.campanhaSlug });
  }, []);

  // One shared scrapbook sequence across BOTH platforms so tints/tapes/tilts
  // alternate through the whole grid instead of restarting per group.
  const cards = useMemo(() => {
    const nova = novas.map((c, i) => ({ tipo: 'nova' as const, c, i }));
    const antiga = legado.map((c, i) => ({ tipo: 'legado' as const, c, i: novas.length + i }));
    return [...nova, ...antiga];
  }, [novas, legado]);

  const carregando = meQ.isLoading || listQ.isLoading;

  return (
    <div className="camp-scope">
      {/* ── Topbar ──
       *  aperture-hdftp — the canonical shared app header (PainelTopbar),
       *  replacing the PDF-derived custom header (operator: header
       *  consistency across surfaces). On this surface MINHAS LISTAS is
       *  the active you-are-here chip; the greeting lives on in the hero
       *  eyebrow below. Rendered once auth.me resolves (needs the slug
       *  for the MINHA PÁGINA chip). */}
      {me?.slug ? <PainelTopbar slug={me.slug} surface="campanhas" /> : null}

      {/* ── Hero ── */}
      <main className="camp-main">
        <div className="camp-hero">
          <span className="camp-hero-eyebrow">
            {temLegado ? `olá de novo, ${nome} ♡` : `olá, ${nome} ♡`}
          </span>
          <h1 className="camp-hero-title">
            em qual <span className="hl">lista</span> você quer entrar?
          </h1>
          <button type="button" className="camp-hero-help" onClick={openTour}>
            como funciona? ♡
          </button>
        </div>

        {/* ── Grid ── */}
        {carregando ? (
          <div className="camp-grid" data-testid="campanhas-grid" aria-busy="true">
            {[0, 1, 2].map((i) => (
              <div key={i} className="camp-card camp-card-skel anim-skeleton-pulse" style={{ transform: TILTS[i % TILTS.length] }}>
                <div className="camp-cover camp-skel-block" />
                <div className="camp-card-body">
                  <div className="camp-skel-line" />
                  <div className="camp-skel-line camp-skel-line-sm" />
                  <div className="camp-skel-btn" />
                </div>
              </div>
            ))}
          </div>
        ) : listQ.isError ? (
          <div className="camp-error" role="alert">
            <span className="camp-error-eyebrow">ops ♡</span>
            <p className="camp-error-text">
              não conseguimos carregar suas listas agora. respira fundo e tenta de novo?
            </p>
            <button type="button" className="btn-lilac" onClick={() => void listQ.refetch()}>
              tentar de novo ♡
            </button>
          </div>
        ) : (
          <div className="camp-grid" data-testid="campanhas-grid">
            {cards.map(({ tipo, c, i }) =>
              tipo === 'nova' ? (
                <CardNova
                  key={(c as CampanhaNovaDTO).id}
                  campanha={c as CampanhaNovaDTO}
                  index={i}
                  onCompletar={abrirSetupDoCard}
                />
              ) : (
                <CardLegado key={`legado-${i}`} campanha={c as CampanhaLegadoDTO} index={i} />
              ),
            )}

            {/* NOVA LISTA — dashed scrapbook slot, per the PDF's page 2. */}
            <button
              type="button"
              className="camp-nova"
              data-testid="card-nova-lista"
              onClick={onNovaLista}
            >
              <span className="camp-nova-plus" aria-hidden="true">
                <span>+</span>
              </span>
              <span className="camp-nova-lbl">nova lista</span>
            </button>
          </div>
        )}

        {!carregando && !listQ.isError && cards.length === 0 && (
          <p className="camp-empty-note">comece criando sua primeira lista ♡</p>
        )}
      </main>

      {/* ── NOVA LISTA create modal (aperture-rurre) ── */}
      {/* ── Setup wizard (aperture-1yx1n §1.5) — post-criar + "completar" ── */}
      {setupCampanha && (
        <SetupCampanhaWizard campanha={setupCampanha} onClose={fecharSetup} />
      )}

      {novaOpen && (
        <div className="camp-overlay" onClick={fecharNova}>
          <div
            className="camp-modal camp-modal-nova"
            data-testid="nova-lista-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="camp-nova-title"
            onClick={(e) => e.stopPropagation()}
          >
            <span className="camp-modal-tape" style={{ background: 'var(--blue)' }} aria-hidden="true" />
            <span className="camp-modal-eyebrow">um cantinho novo ♡</span>
            <h2 id="camp-nova-title" className="camp-modal-title camp-modal-title-sm">
              dê um nome pro novo <span className="hl">cantinho</span>
            </h2>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                submitNova();
              }}
            >
              <input
                type="text"
                className="camp-nova-input"
                data-testid="nova-lista-input"
                placeholder="chá da aurora, enxoval, quartinho…"
                aria-label="Nome da nova lista"
                value={novoTitulo}
                maxLength={200}
                autoFocus
                disabled={criarM.isPending}
                onChange={(e) => setNovoTitulo(e.target.value)}
              />
              <div className="camp-modal-actions">
                <button
                  type="button"
                  className="camp-btn-outline"
                  data-testid="nova-lista-cancel"
                  disabled={criarM.isPending}
                  onClick={fecharNova}
                >
                  cancelar
                </button>
                <button
                  type="submit"
                  className="camp-btn-fill"
                  data-testid="nova-lista-submit"
                  disabled={!novoTitulo.trim() || criarM.isPending}
                >
                  {criarM.isPending ? 'criando ♡…' : 'criar lista ♡'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ── Welcome modal (first visit, legacy users only) ── */}
      {welcomeOpen && (
        <div className="camp-overlay" onClick={() => dismissWelcome(false)}>
          <div
            className="camp-modal"
            data-testid="welcome-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="camp-welcome-title"
            onClick={(e) => e.stopPropagation()}
          >
            <span className="camp-modal-tape" style={{ background: 'var(--yellow)' }} aria-hidden="true" />
            <span className="camp-modal-eyebrow">um recadinho pra você ♡</span>
            <h2 id="camp-welcome-title" className="camp-modal-title">
              Bem-vindo à nova <span className="hl">EuNeném</span>! ✨
            </h2>
            <p className="camp-modal-copy">
              Enquanto construímos uma experiência ainda melhor, sua conta anterior
              continua disponível exatamente como você a deixou.
            </p>

            <div className="camp-modal-kicker">você pode acessar</div>

            <div className="camp-versoes">
              <div className="camp-versao camp-versao-10">
                <span className="camp-selo camp-selo-10 camp-selo-modal" aria-hidden="true">1.0</span>
                <div>
                  <div className="camp-versao-name">EuNeném 1.0</div>
                  <div className="camp-versao-desc">
                    sua conta atual, com listas, presentes, imagens, contribuições e saldo existentes.
                  </div>
                </div>
              </div>
              <div className="camp-versao camp-versao-20">
                <span className="camp-selo camp-selo-20 camp-selo-modal" aria-hidden="true">2.0</span>
                <div>
                  <div className="camp-versao-name camp-versao-name-20">EuNeném 2.0</div>
                  <div className="camp-versao-desc camp-versao-desc-20">
                    uma nova conta para começar uma nova lista na nova plataforma.
                  </div>
                </div>
              </div>
            </div>

            <div className="camp-aviso">
              <span className="camp-aviso-heart" aria-hidden="true">♡</span>
              <p>
                As duas versões funcionam separadamente. Por isso, listas, contribuições,
                saldos, taxas e demais informações não podem ser transferidos ou
                compartilhados entre elas.
              </p>
            </div>

            {/* aperture-opfsj — opt-out consent. Hidden-but-focusable native
             *  input + tilted scrapbook square; copy echoes the modal's own
             *  "um recadinho pra você" eyebrow. */}
            <label className="camp-optout">
              <input
                type="checkbox"
                className="camp-optout-input"
                data-testid="welcome-modal-optout"
                checked={naoVerNovamente}
                onChange={(e) => setNaoVerNovamente(e.target.checked)}
              />
              <span className="camp-optout-box" aria-hidden="true">
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={3}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  width={14}
                  height={14}
                >
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              </span>
              <span className="camp-optout-lbl">não quero ver esse recadinho de novo</span>
            </label>

            <div className="camp-modal-actions">
              <button
                type="button"
                className="camp-btn-outline"
                data-testid="welcome-modal-saber-mais"
                onClick={() => dismissWelcome(true)}
              >
                saber mais
              </button>
              <button
                type="button"
                className="camp-btn-fill"
                data-testid="welcome-modal-ok"
                autoFocus
                onClick={() => dismissWelcome(false)}
              >
                ok ♡
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── 2-step tour ("como funciona?" / SABER MAIS) ── */}
      {tourOpen && (
        <div className="camp-overlay camp-overlay-tour" onClick={() => setTourOpen(false)}>
          <div
            className="camp-modal camp-modal-tour"
            role="dialog"
            aria-modal="true"
            aria-labelledby="camp-tour-title"
            onClick={(e) => e.stopPropagation()}
          >
            <span className="camp-modal-tape" style={{ background: 'var(--green)' }} aria-hidden="true" />
            <span className="camp-modal-eyebrow">rapidinho, passo {tourStep + 1} de 2 ♡</span>

            {tourStep === 0 ? (
              <>
                <h2 id="camp-tour-title" className="camp-modal-title camp-modal-title-sm">
                  como <span className="hl">alternar</span> entre listas
                </h2>
                {/* aperture-hdftp — step reteaches the canonical header:
                 *  MINHAS LISTAS in the topbar is the way back here from
                 *  inside any list (the old IR PARA dropdown is gone). */}
                <div className="camp-tour-stage">
                  <span className="camp-tour-cta" aria-hidden="true">acessar lista ♡</span>
                  <span className="camp-tour-note">↑ entra na lista que você escolher</span>
                  <span className="camp-tour-pill">
                    <span aria-hidden="true">←</span>
                    <span className="camp-tour-pill-val">minhas listas</span>
                  </span>
                  <span className="camp-tour-note camp-tour-note-green">
                    ↑ e esse botão no topo te traz de volta pra cá
                  </span>
                </div>
                <p className="camp-tour-copy">
                  toque em <b>acessar lista</b> no quadrinho que você quer abrir — e quando
                  quiser trocar, <b>minhas listas</b> lá no topo te traz de volta ♡
                </p>
              </>
            ) : (
              <>
                <h2 id="camp-tour-title" className="camp-modal-title camp-modal-title-sm">
                  como <span className="hl">criar</span> uma nova lista
                </h2>
                <div className="camp-tour-stage camp-tour-stage-center">
                  <span className="camp-tour-nova" aria-hidden="true">
                    <span className="camp-tour-nova-plus"><span>+</span></span>
                    <span className="camp-tour-nova-lbl">nova lista</span>
                  </span>
                  <span className="camp-tour-note camp-tour-note-green">fica no fim dos quadrinhos ♡</span>
                </div>
                <p className="camp-tour-copy">
                  quer começar do zero? toque no quadrinho pontilhado <b>+ nova lista</b> e
                  dê um nome pro novo cantinho de mimos ♡
                </p>
              </>
            )}

            <div className="camp-tour-controls">
              <span className="camp-tour-dots" aria-hidden="true">
                <span className={`camp-tour-dot${tourStep === 0 ? ' on' : ''}`} />
                <span className={`camp-tour-dot${tourStep === 1 ? ' on' : ''}`} />
              </span>
              <span className="camp-spacer" />
              {tourStep > 0 && (
                <button type="button" className="camp-tour-back" onClick={() => setTourStep(0)}>
                  voltar
                </button>
              )}
              <button
                type="button"
                className="camp-btn-fill camp-btn-fill-sm"
                onClick={() => (tourStep >= 1 ? setTourOpen(false) : setTourStep(1))}
              >
                {tourStep >= 1 ? 'entendi ♡' : 'próximo →'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** 2.0 card — navigates into the new-platform painel. */
function CardNova({
  campanha,
  index,
  onCompletar,
}: {
  campanha: CampanhaNovaDTO;
  index: number;
  onCompletar: (c: CampanhaNovaDTO) => void;
}) {
  // aperture-1yx1n — the canonical blank-perfil signal (aphk8 amendment #2):
  // nomeBebe === null EXACTLY (real DTO field post-#359).
  const precisaCompletar = campanha.nomeBebe === null;
  return (
    <article
      className="camp-card"
      data-testid="card-campanha"
      style={{ transform: TILTS[index % TILTS.length] }}
    >
      <span className="camp-tape" style={{ background: TAPES[index % TAPES.length] }} aria-hidden="true" />
      <span className="camp-selo camp-selo-20" title="lista na EuNeném 2.0">2.0</span>
      <div className="camp-cover" style={{ background: TINTS[index % TINTS.length] }}>
        <span className="camp-cover-ini" aria-hidden="true">{campanha.titulo.charAt(0).toLowerCase()}</span>
      </div>
      <div className="camp-card-body">
        <h3 className="camp-card-name">{campanha.titulo}</h3>
        {campanha.quantidadeMimos !== null && (
          <div className="camp-card-mimos">{mimosLabel(campanha.quantidadeMimos)}</div>
        )}
        {precisaCompletar && (
          <button
            type="button"
            className="camp-card-completar"
            data-testid="card-completar"
            onClick={() => onCompletar(campanha)}
          >
            completar ♡
          </button>
        )}
        {/* aperture-h0hom — each card opens ITS OWN campanha's painel
         *  (/c/:idCampanha), not the oldest-resolving bare URL. */}
        <a className="camp-cta" href={`/painel/${campanha.slug}/c/${campanha.id}`}>
          acessar lista ♡
        </a>
      </div>
    </article>
  );
}

/** 1.0 card — real anchor out to the old site's /migracao explainer
 *  (aperture-pjd74): expectation-setting page, then Clerk login → the
 *  email-resolved 1.0 panel. Cross-origin → rel=noopener. */
function CardLegado({ index }: { campanha: CampanhaLegadoDTO; index: number }) {
  // aperture-49l6j (operator): the legacy snapshot's `nome` is unreliable
  // (test-y values like 'Teste') and the real export carries no trustworthy
  // mimo count — show a stable 'EuNeném Legado' label and NO count line.
  // The DTO stays in the props signature (the grid maps legado entries and
  // future exports may restore per-entry display data).
  return (
    <article
      className="camp-card"
      data-testid="card-legado"
      style={{ transform: TILTS[index % TILTS.length] }}
    >
      <span className="camp-tape" style={{ background: TAPES[index % TAPES.length] }} aria-hidden="true" />
      <span className="camp-selo camp-selo-10" title="lista na EuNeném 1.0">1.0</span>
      <div className="camp-cover" style={{ background: TINTS[index % TINTS.length] }}>
        <span className="camp-cover-ini" aria-hidden="true">1.0</span>
      </div>
      <div className="camp-card-body">
        <h3 className="camp-card-name">EuNeném Legado</h3>
        <a className="camp-cta camp-cta-legado" href={LEGACY_MIGRACAO_URL} rel="noopener">
          continuar na 1.0 <span aria-hidden="true">↗</span>
        </a>
      </div>
    </article>
  );
}
