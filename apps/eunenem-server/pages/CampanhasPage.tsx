/**
 * aperture-g7l09 — /campanhas: the multicampanha migration bridge (POC).
 *
 * Mixed grid of the user's campaigns across BOTH platforms:
 *   - 2.0 cards → /painel/<slug> (the new-platform dashboard)
 *   - 1.0 cards → https://eunenem.com/minha-area (legacy; Clerk resolves by
 *     email — real <a href>, per Izzy's testability + a11y request)
 *   - NOVA LISTA card → POC stub (warm toast; swaps to the real creation
 *     flow when campanhas.criar ships — GLaDOS follow-up bead)
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
import {
  CAMPANHAS_WELCOME_STORAGE_KEY,
  LEGACY_DASHBOARD_URL,
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

  const [menuOpen, setMenuOpen] = useState(false);
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
  // is meaningless for pure-2.0 accounts) and only until dismissed once.
  useEffect(() => {
    if (!listQ.data || listQ.data.legado.length === 0) return;
    if (window.localStorage.getItem(CAMPANHAS_WELCOME_STORAGE_KEY)) return;
    setWelcomeOpen(true);
  }, [listQ.data]);

  const dismissWelcome = useCallback((openTourAfter: boolean) => {
    window.localStorage.setItem(CAMPANHAS_WELCOME_STORAGE_KEY, '1');
    setWelcomeOpen(false);
    if (openTourAfter) {
      setTourStep(0);
      setTourOpen(true);
    }
  }, []);

  const openTour = useCallback(() => {
    setTourStep(0);
    setTourOpen(true);
  }, []);

  useEscape(tourOpen, () => setTourOpen(false));
  useEscape(welcomeOpen && !tourOpen, () => dismissWelcome(false));

  // POC stub — no user-facing "create a 2nd campanha" flow exists yet
  // (creation happens inside the signup saga only). A warm toast beats
  // bouncing a logged-in user to the marketing landing. Swap to real
  // navigation when campanhas.criar ships.
  const onNovaLista = useCallback(() => {
    toast('criar uma nova lista chega já já ♡', {
      description: 'estamos preparando esse cantinho — sua lista atual continua aqui.',
    });
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
      {/* ── Topbar ── */}
      <header className="camp-topbar">
        <div className="camp-topbar-inner">
          <a className="camp-brand" href="/" aria-label="EuNeném — página inicial">
            <span className="camp-brand-mark" aria-hidden="true">e</span>
            <span className="camp-brand-text">
              <span className="camp-brand-name">euneném</span>
              <span className="camp-brand-sub">listas de mimos</span>
            </span>
          </a>

          {cards.length > 0 && (
            <nav className="camp-switch" aria-label="Ir para uma lista">
              <button
                type="button"
                className="camp-switch-btn"
                aria-expanded={menuOpen}
                aria-haspopup="menu"
                onClick={() => setMenuOpen((v) => !v)}
              >
                <span className="camp-switch-lbl">ir para</span>
                <span className="camp-switch-val">minhas listas</span>
                <span className={`camp-switch-caret${menuOpen ? ' open' : ''}`} aria-hidden="true">▾</span>
              </button>
              {menuOpen && (
                <>
                  <div className="camp-switch-backdrop" onClick={() => setMenuOpen(false)} aria-hidden="true" />
                  <div className="camp-switch-menu" role="menu">
                    <div className="camp-switch-menu-eyebrow" aria-hidden="true">acessar uma lista ♡</div>
                    {cards.map(({ tipo, c, i }) => (
                      <a
                        key={tipo === 'nova' ? (c as CampanhaNovaDTO).id : `legado-${i}`}
                        role="menuitem"
                        className="camp-switch-item"
                        href={tipo === 'nova' ? `/painel/${(c as CampanhaNovaDTO).slug}` : LEGACY_DASHBOARD_URL}
                      >
                        <span className="camp-switch-item-ini" style={{ background: TINTS[i % TINTS.length] }} aria-hidden="true">
                          {(tipo === 'nova' ? (c as CampanhaNovaDTO).titulo : (c as CampanhaLegadoDTO).nome).charAt(0).toLowerCase()}
                        </span>
                        <span className="camp-switch-item-body">
                          <span className="camp-switch-item-name">
                            {tipo === 'nova' ? (c as CampanhaNovaDTO).titulo : (c as CampanhaLegadoDTO).nome}
                          </span>
                          <span className="camp-switch-item-sub">
                            {tipo === 'nova' ? 'euneném 2.0' : 'euneném 1.0'}
                          </span>
                        </span>
                      </a>
                    ))}
                  </div>
                </>
              )}
            </nav>
          )}

          <div className="camp-topbar-spacer" />

          <div className="camp-user">
            <span className="camp-user-text">
              <span className="camp-user-greet">olá, {nome} ♡</span>
              <span className="camp-user-sub">que bom te ver de novo</span>
            </span>
            <span className="camp-avatar" aria-hidden="true">
              {nome.charAt(0).toUpperCase()}
            </span>
          </div>
        </div>
      </header>

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
                <CardNova key={(c as CampanhaNovaDTO).id} campanha={c as CampanhaNovaDTO} index={i} />
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
                <div className="camp-tour-stage">
                  <span className="camp-tour-pill">
                    <span className="camp-tour-pill-lbl">ir para</span>
                    <span className="camp-tour-pill-val">minhas listas</span>
                    <span aria-hidden="true">▾</span>
                  </span>
                  <span className="camp-tour-note">↑ o menu lá no topo abre qualquer lista</span>
                  <span className="camp-tour-cta" aria-hidden="true">acessar lista ♡</span>
                </div>
                <p className="camp-tour-copy">
                  toque em <b>acessar lista</b> no quadrinho que você quer abrir — ou use o
                  menu <b>ir para</b> no topo pra pular direto pra qualquer uma ♡
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
              <span className="camp-topbar-spacer" />
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
function CardNova({ campanha, index }: { campanha: CampanhaNovaDTO; index: number }) {
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
        <a className="camp-cta" href={`/painel/${campanha.slug}`}>
          acessar lista ♡
        </a>
      </div>
    </article>
  );
}

/** 1.0 card — real anchor out to the legacy dashboard (Clerk resolves by email). */
function CardLegado({ campanha, index }: { campanha: CampanhaLegadoDTO; index: number }) {
  return (
    <article
      className="camp-card"
      data-testid="card-legado"
      style={{ transform: TILTS[index % TILTS.length] }}
    >
      <span className="camp-tape" style={{ background: TAPES[index % TAPES.length] }} aria-hidden="true" />
      <span className="camp-selo camp-selo-10" title="lista na EuNeném 1.0">1.0</span>
      <div className="camp-cover" style={{ background: TINTS[index % TINTS.length] }}>
        <span className="camp-cover-ini" aria-hidden="true">{campanha.nome.charAt(0).toLowerCase()}</span>
      </div>
      <div className="camp-card-body">
        <h3 className="camp-card-name">{campanha.nome}</h3>
        {campanha.mimos !== null && (
          <div className="camp-card-mimos">{mimosLabel(campanha.mimos)}</div>
        )}
        <a className="camp-cta camp-cta-legado" href={LEGACY_DASHBOARD_URL}>
          continuar na 1.0 <span aria-hidden="true">↗</span>
        </a>
      </div>
    </article>
  );
}
