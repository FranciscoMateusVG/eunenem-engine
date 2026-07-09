import { useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';

import type { Genero } from '@/lib/concordancia';
import { paginaShareDisplayPrefix } from '@/lib/pagina-share';
import { trpc } from '@/lib/trpc';

// aperture-1yx1n Phase B (§1.5 + operator decision) — per-campanha setup
// wizard. Opens right after campanhas.criar (NOVA LISTA) and from a card's
// "completar" affordance. ONE cozy screen — the moment after a mother names
// her lista should feel like unwrapping tissue paper, not filling a form:
// nome do bebê, gênero, tipo/data do evento, and the USER-CHOSEN campanha
// slug (pre-filled from the titulo, editable, live-validated).
//
// Contract (aperture-aphk8, FROZEN + amendments): submits
// campanhas.definirSlug({idCampanha, slug}) first (slug conflicts abort the
// save with the field error — same order as OnboardingWizard's slug-then-
// perfil), then perfilCampanha.atualizar({idCampanha, ...FULL baby-half}).
// WHOLE-CONTENT REPLACEMENT: every field ships explicitly (nulls included) —
// an omitted field is a silent wipe, not a no-op (the 7sb1h lesson).
// validarSlug is advisory UX (350ms debounce + on-blur, NOT rate-limited per
// amendment #1); definirSlug errors are the final truth.
//
// Skip is a first-class path: "pular por enquanto" closes without writing;
// the card then shows "completar" (nomeBebe === null, amendment #2).

const SLUG_RE = /^[a-z][a-z0-9-]{2,59}$/;

type TipoEventoSlug =
  | 'cha-bebe'
  | 'cha-fraldas'
  | 'cha-surpresa'
  | 'cha-revelacao'
  | 'aniversario'
  | 'batizado';

const EVENT_TYPES: ReadonlyArray<{ value: TipoEventoSlug; label: string }> = [
  { value: 'cha-bebe', label: 'Chá de bebê' },
  { value: 'cha-fraldas', label: 'Chá de fraldas' },
  { value: 'cha-surpresa', label: 'Chá surpresa' },
  { value: 'cha-revelacao', label: 'Chá revelação' },
  { value: 'aniversario', label: 'Aniversário' },
  { value: 'batizado', label: 'Batizado' },
];

const GENEROS: ReadonlyArray<{ value: Genero; label: string }> = [
  { value: 'menina', label: 'Menina' },
  { value: 'menino', label: 'Menino' },
  { value: 'surpresa', label: 'Ainda é surpresa ✨' },
  { value: 'neutro', label: 'Prefiro não dizer' },
];

/** titulo → slug suggestion: strip accents, kebab, clamp to the VO bounds. */
export function deriveCampanhaSlug(titulo: string): string {
  const base = titulo
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
    .slice(0, 60)
    .replace(/-+$/, '');
  // Must start with a letter (VO rule) — drop leading non-letters.
  const fromLetter = base.replace(/^[^a-z]+/, '');
  return fromLetter.length >= 3 ? fromLetter : '';
}

const MOTIVO_TEXT: Record<string, string> = {
  formato: 'formato inválido: 3–60 caracteres, começa com letra, só a–z, números e hífen',
  reservado: 'esse nome é reservado — escolha outro ♡',
  em_uso: 'você já usa esse endereço em outra lista ♡',
};

export function SetupCampanhaWizard({
  campanha,
  onClose,
}: {
  campanha: {
    id: string;
    titulo: string;
    /**
     * aperture-y8e9w — the campanha's CURRENT slug, when already chosen
     * (completar re-entry). Drives the prefill AND the own-slug copy:
     * re-confirming your existing slug is not a fresh grab, and 'disponível'
     * read as one (operator's walk — validating Ameno's own 'francisco'
     * looked like it was claiming a new address).
     */
    campanhaSlug?: string | null;
  };
  onClose: () => void;
}) {
  const utils = trpc.useUtils();
  const slugAtual = campanha.campanhaSlug ?? null;
  const [babyName, setBabyName] = useState('');
  const [genero, setGenero] = useState<Genero | null>(null);
  const [eventType, setEventType] = useState<TipoEventoSlug | ''>('');
  const [eventDate, setEventDate] = useState('');
  // Prefill: the campanha's OWN slug when it has one, else the titulo
  // suggestion (fresh campanha / never chosen).
  const [slug, setSlug] = useState(() => slugAtual ?? deriveCampanhaSlug(campanha.titulo));
  const [slugError, setSlugError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // ── Live slug validation: 350ms debounce (amendment #1 — no rate limit,
  // definirSlug is the enforcement point; this line is pure reassurance). ──
  const [debouncedSlug, setDebouncedSlug] = useState(slug);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => setDebouncedSlug(slug), 350);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [slug]);

  // aperture-y8e9w — re-confirming the campanha's OWN current slug needs no
  // server round-trip and must not read as a fresh grab.
  const isOwnCurrentSlug = slugAtual !== null && debouncedSlug === slugAtual;
  const formatoOk = SLUG_RE.test(debouncedSlug);
  const validar = trpc.campanhas.validarSlug.useQuery(
    { idCampanha: campanha.id, slug: debouncedSlug },
    { enabled: formatoOk && !isOwnCurrentSlug, staleTime: 10_000, retry: false },
  );

  const slugStatus = useMemo(() => {
    if (slugError) return { tone: 'bad' as const, text: slugError };
    if (!slug.trim())
      return { tone: 'muted' as const, text: 'sem endereço por enquanto — dá pra escolher depois ♡' };
    if (slug !== debouncedSlug) return { tone: 'muted' as const, text: 'conferindo…' };
    // aperture-y8e9w — own-slug copy: 'disponível ♡' on your own current
    // address reads like a fresh claim (operator confusion). Name the truth.
    if (isOwnCurrentSlug)
      return { tone: 'good' as const, text: 'essa já é a slug dessa lista ♡' };
    if (!formatoOk) return { tone: 'bad' as const, text: MOTIVO_TEXT.formato };
    if (validar.isFetching) return { tone: 'muted' as const, text: 'conferindo…' };
    if (validar.data) {
      if (validar.data.disponivel) return { tone: 'good' as const, text: 'disponível ♡' };
      return {
        tone: 'bad' as const,
        text: MOTIVO_TEXT[validar.data.motivo ?? 'formato'] ?? MOTIVO_TEXT.formato,
      };
    }
    // Shim window (backend not deployed yet) or transient error — stay
    // neutral; definirSlug adjudicates at submit either way.
    return { tone: 'muted' as const, text: '' };
  }, [slug, debouncedSlug, formatoOk, isOwnCurrentSlug, validar.isFetching, validar.data, slugError]);

  // aperture-1yx1n — real inference post-#359 (shim swap point fired).
  const definirSlug = trpc.campanhas.definirSlug.useMutation();
  const atualizar = trpc.perfilCampanha.atualizar.useMutation();

  const canSubmit = babyName.trim().length > 0 && !submitting;

  const submit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setSlugError(null);

    // 1. Slug first — a conflict keeps the modal open with the field error
    //    and NOTHING written (same order as the account OnboardingWizard).
    //    aperture-y8e9w — unchanged own slug → skip the write (no-op).
    const slugTrim = slug.trim();
    if (slugTrim && slugTrim !== slugAtual) {
      try {
        await definirSlug.mutateAsync({ idCampanha: campanha.id, slug: slugTrim });
      } catch (err) {
        const msg = (err as { message?: string })?.message ?? '';
        setSlugError(
          MOTIVO_TEXT[
            msg.includes('em_uso') ? 'em_uso' : msg.includes('reservado') ? 'reservado' : 'formato'
          ] ?? 'não consegui reservar esse endereço — tenta de novo?',
        );
        setSubmitting(false);
        return;
      }
    }

    // 2. Perfil — WHOLE-CONTENT replacement: every baby-half field ships
    //    explicitly. Fresh campanha → nulls are the true state.
    try {
      await atualizar.mutateAsync({
        idCampanha: campanha.id,
        nomeBebe: babyName.trim() || null,
        relacao: null,
        historia: null,
        dataNascimento: null,
        tipoEvento: eventType || null,
        genero,
        dataEvento: eventDate ? new Date(`${eventDate}T12:00:00`) : null,
        fotoPerfilKey: null,
        fotoCapaKey: null,
        fotoHistoriaKey: null,
      });
      void utils.campanhas.list.invalidate();
      toast.success('prontinho ♡ o cantinho já tem nome');
      onClose();
    } catch {
      // Slug (if any) already committed — don't strand the user; they can
      // finish from the card's "completar" affordance.
      void utils.campanhas.list.invalidate();
      toast.error('salvei seu endereço, mas o resto não foi — complete pela lista ♡');
      onClose();
    }
  };

  const skip = () => {
    if (submitting) return;
    toast('tudo bem ♡ — complete quando quiser, pela própria lista');
    onClose();
  };

  return (
    <div className="camp-overlay" onClick={skip}>
      <div
        className="camp-modal camp-setup-modal"
        data-testid="setup-wizard-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="camp-setup-title"
        onClick={(e) => e.stopPropagation()}
      >
        <span className="camp-modal-tape" style={{ background: 'var(--yellow)' }} aria-hidden="true" />
        <span className="camp-modal-eyebrow">{campanha.titulo} ♡</span>
        <h2 id="camp-setup-title" className="camp-modal-title camp-modal-title-sm">
          conta pra gente <span className="hl">quem vem aí</span>
        </h2>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <label className="camp-setup-label" htmlFor="setup-nome-bebe">
            nome do bebê
          </label>
          <input
            id="setup-nome-bebe"
            type="text"
            className="camp-nova-input"
            data-testid="setup-wizard-nome-bebe"
            placeholder="Aurora, Miguel, Alice…"
            value={babyName}
            maxLength={120}
            autoFocus
            disabled={submitting}
            onChange={(e) => setBabyName(e.target.value)}
          />

          <span className="camp-setup-label">é menina, menino…?</span>
          <div className="camp-setup-chips" role="radiogroup" aria-label="gênero do bebê">
            {GENEROS.map((g) => (
              <button
                key={g.value}
                type="button"
                role="radio"
                aria-checked={genero === g.value}
                className={'camp-setup-chip' + (genero === g.value ? ' is-on' : '')}
                data-testid={`setup-wizard-genero-${g.value}`}
                disabled={submitting}
                onClick={() => setGenero((cur) => (cur === g.value ? null : g.value))}
              >
                {g.label}
              </button>
            ))}
          </div>

          <div className="camp-setup-row">
            <div className="camp-setup-col">
              <label className="camp-setup-label" htmlFor="setup-tipo">
                tipo de evento
              </label>
              <select
                id="setup-tipo"
                className="camp-nova-input camp-setup-select"
                data-testid="setup-wizard-tipo"
                value={eventType}
                disabled={submitting}
                onChange={(e) => setEventType(e.target.value as TipoEventoSlug | '')}
              >
                <option value="">escolher depois…</option>
                {EVENT_TYPES.map((t) => (
                  <option key={t.value} value={t.value}>
                    {t.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="camp-setup-col">
              <label className="camp-setup-label" htmlFor="setup-data">
                data do evento
              </label>
              <input
                id="setup-data"
                type="date"
                className="camp-nova-input"
                data-testid="setup-wizard-data"
                value={eventDate}
                disabled={submitting}
                onChange={(e) => setEventDate(e.target.value)}
              />
            </div>
          </div>

          <label className="camp-setup-label" htmlFor="setup-slug">
            endereço da página
          </label>
          <div className="camp-setup-slug-row">
            <span className="camp-setup-slug-prefix">{paginaShareDisplayPrefix()}…/</span>
            <input
              id="setup-slug"
              type="text"
              className="camp-nova-input camp-setup-slug-input"
              data-testid="setup-wizard-slug"
              placeholder="cha-da-aurora"
              value={slug}
              maxLength={60}
              disabled={submitting}
              onChange={(e) => {
                setSlugError(null);
                setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''));
              }}
              onBlur={() => setDebouncedSlug(slug)}
            />
          </div>
          <span
            className={`camp-setup-slug-status is-${slugStatus.tone}`}
            data-testid="setup-wizard-slug-status"
            role={slugStatus.tone === 'bad' ? 'alert' : undefined}
          >
            {slugStatus.text}
          </span>

          <div className="camp-modal-actions">
            <button
              type="button"
              className="camp-btn-outline"
              data-testid="setup-wizard-skip"
              disabled={submitting}
              onClick={skip}
            >
              pular por enquanto
            </button>
            <button
              type="submit"
              className="camp-btn-fill"
              data-testid="setup-wizard-submit"
              disabled={!canSubmit}
            >
              {submitting ? 'guardando ♡…' : 'guardar ♡'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
