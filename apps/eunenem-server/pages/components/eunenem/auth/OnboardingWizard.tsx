// aperture-84a21 / aperture-4y1y4 — post-signup onboarding capture.
//
// Fires right AFTER a successful signUp (session present), opened by
// AuthModalProvider in place of the immediate redirect-to-painel. Captures the
// fields a brand-new account would otherwise leave null (→ the mock "15 jun
// 2026" date + "página da bebê" fallback the operator kept hitting):
//
//   step 1 — nome do bebê (nomeBebe)
//   step 2 — data do evento (dataEvento) + tipo de evento (tipoEvento)
//   step 3 — link da página (vanity slug)               ← aperture-4y1y4
//
// aperture-4y1y4 — the vanity SLUG picker (operator-approved 2026-06-24). Today
// the page slug is auto-derived from the display name's first word, and a 2nd
// "Francisco" gets an ugly auto-suffix ("francisco-2"). Step 3 lets the creator
// CLAIM their page URL (Instagram @-handle style) at signup. Decisions (locked):
//   • OPTIONAL + pre-filled with the auto-derived slug (lowest friction — the
//     user can just hit "criar minha página" with the default).
//   • real-time availability via usuario.verificarDisponibilidadeSlug (debounced).
//   • reserved-words denylist enforced BACKEND-side (Rex #269); the picker
//     surfaces a "reservado" motivo gracefully + relies on atualizarSlug's
//     CONFLICT/BAD_REQUEST codes as the authoritative gate on save.
//
// Wiring (aperture-qmaoi, fblrt W2-c1): the BABY-half (nomeBebe/genero/
// tipoEvento/dataEvento/…) goes to perfilCampanha.atualizar addressed to the
// auto-created FIRST campanha (auth.me.idCampanha) — the needsOnboarding gate
// reads perfil_campanhas.nome_bebe (aperture-3vc12), so this write is what
// flips it. perfil.atualizar keeps ONLY the user-half (nomeExibicao) +
// usuario.atualizarSlug (existing use-case, same guarded UNIQUE(plataforma,slug)
// constraint the PerfilBody editor uses) for the chosen slug. On finish →
// /painel/<finalSlug> (the chosen slug if changed, else the auto-derived one).
//
// A new account has every profile field null except nomeExibicao (set at
// signup), so perfil.atualizar sends the baby fields as null — correct for the
// onboarding context (the wizard only ever runs post-signup).
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { trpc } from "@/lib/trpc";
import { paginaShareDisplayPrefix } from "@/lib/pagina-share";
import type { Genero } from "@/lib/concordancia";
import { sendEvent, identifyWithUtm } from "@/lib/analytics";
import { AUTH_CSS } from "./AuthModalShell";

// aperture-84a21 — tipoEvento canonical kebab slugs (mirror PerfilBody +
// TipoEventoPerfilSchema). NB: pages/lib/mocks/perfil's PERFIL_EVENT_TYPES
// carries DISPLAY labels ("Chá de bebê"), not these slugs — the backend
// expects the slugs.
type EventTypeSlug =
  | "cha-bebe"
  | "cha-fraldas"
  | "cha-surpresa"
  | "cha-revelacao"
  | "batizado"
  | "aniversario";
const EVENT_TYPES: ReadonlyArray<{ value: EventTypeSlug; label: string }> = [
  { value: "cha-bebe", label: "Chá de bebê" },
  { value: "cha-fraldas", label: "Chá de fraldas" },
  { value: "cha-surpresa", label: "Chá surpresa" },
  { value: "cha-revelacao", label: "Chá revelação" },
  { value: "aniversario", label: "Aniversário" },
  { value: "batizado", label: "Batizado" },
];

// aperture-neiwx — baby gender, drives PT-BR article agreement (do/da/de)
// across the owner painel + guest page. "neutro"/"surpresa" both render the
// neutral "de" article; kept distinct so the copy can diverge later if needed.
const GENEROS: ReadonlyArray<{ value: Genero; label: string }> = [
  { value: "menina", label: "Menina" },
  { value: "menino", label: "Menino" },
  { value: "surpresa", label: "Ainda é surpresa ✨" },
  { value: "neutro", label: "Prefiro não dizer" },
];

// aperture-4y1y4 — slug VO regex (mirror App.tsx SLUG_REGEX + PerfilBody
// SLUG_RE): starts with a letter, a–z/0–9/hyphen, 3–30 chars total.
const SLUG_RE = /^[a-z][a-z0-9-]{2,29}$/;
// aperture-1yx1n / ugttj — legacy "eunenem.com/" replaced by the real
// public-page prefix (pagina-share seam). Fresh account = default campanha,
// so the bare (un-addressed) display form is correct here.

export function OnboardingWizard({ onDone }: { onDone: (slug: string) => void }) {
  const me = trpc.auth.me.useQuery(undefined, { staleTime: 0 });
  const utils = trpc.useUtils();
  const atualizarPerfil = trpc.perfil.atualizar.useMutation();
  // aperture-qmaoi — the baby-half's real home: the first campanha's perfil.
  const atualizarPerfilCampanha = trpc.perfilCampanha.atualizar.useMutation();
  const atualizarSlug = trpc.usuario.atualizarSlug.useMutation();

  const [step, setStep] = useState<1 | 2 | 3>(1);
  // aperture-b2gac — editable display name (= nomeExibicao = creatorName), seeded
  // ONCE from the best server source (Google profile name → email local-part) so
  // the painel greeting stops showing a raw email local-part. `displayNameTouched`
  // keeps the seed from clobbering a user edit (mirrors the slug seed below).
  const [displayName, setDisplayName] = useState("");
  const [displayNameTouched, setDisplayNameTouched] = useState(false);
  const [babyName, setBabyName] = useState("");
  const [eventDate, setEventDate] = useState("");
  const [eventType, setEventType] = useState<EventTypeSlug>("cha-bebe");
  // aperture-neiwx — baby gender, default neutro (→ neutral "de" article).
  const [genero, setGenero] = useState<Genero>("neutro");
  const [submitting, setSubmitting] = useState(false);

  const defaultDisplayName = me.data?.nomeExibicao ?? "";
  useEffect(() => {
    if (!displayNameTouched && defaultDisplayName) setDisplayName(defaultDisplayName);
  }, [defaultDisplayName, displayNameTouched]);

  // aperture-4y1y4 — slug picker state. `slug` is the editable draft; it's
  // seeded ONCE from the auto-derived me.slug when that lands (the seed effect
  // honours `slugTouched` so it never clobbers a user edit). `slugError` carries
  // a graceful inline message from atualizarSlug's CONFLICT/BAD_REQUEST codes.
  const defaultSlug = me.data?.slug ?? "";
  const [slug, setSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const [slugError, setSlugError] = useState<string | null>(null);

  useEffect(() => {
    if (!slugTouched && defaultSlug) setSlug(defaultSlug);
  }, [defaultSlug, slugTouched]);

  // Debounce the availability check so it doesn't fire on every keystroke.
  const [debouncedSlug, setDebouncedSlug] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSlug(slug), 350);
    return () => clearTimeout(t);
  }, [slug]);

  const slugChanged = slug !== defaultSlug;
  const slugFormatOk = SLUG_RE.test(slug);

  // Only hit the network when the slug is a VALID, CHANGED value and the
  // debounce has settled — mirrors the PerfilBody SlugEditor gate.
  const disponibilidade = trpc.usuario.verificarDisponibilidadeSlug.useQuery(
    { slug: debouncedSlug },
    {
      enabled: slugChanged && slugFormatOk && debouncedSlug === slug,
      staleTime: 0,
      retry: false,
    },
  );

  // motivo is read loosely so a backend addition like "reservado" (Rex #269)
  // is handled at runtime without a strict-union TS mismatch.
  const motivo = disponibilidade.data?.motivo as string | undefined;
  const checking = disponibilidade.isFetching || debouncedSlug !== slug;
  const slugAvailable = disponibilidade.data?.disponivel === true;

  let slugStatus: { text: string; tone: "ok" | "bad" | "muted" };
  if (slugError) {
    slugStatus = { text: slugError, tone: "bad" };
  } else if (!slugChanged) {
    slugStatus = {
      text: "esse vai ser o link público da sua página — dá pra trocar quando quiser ♡",
      tone: "muted",
    };
  } else if (!slugFormatOk) {
    slugStatus = {
      text: "3–30 caracteres, começa com letra, só a–z, números e hífen",
      tone: "bad",
    };
  } else if (checking) {
    slugStatus = { text: "verificando disponibilidade…", tone: "muted" };
  } else if (slugAvailable) {
    slugStatus = { text: "disponível ♡", tone: "ok" };
  } else if (motivo === "reservado") {
    slugStatus = { text: "esse endereço é reservado — escolha outro ♡", tone: "bad" };
  } else if (motivo === "em_uso") {
    slugStatus = { text: "esse endereço já está em uso — escolha outro ♡", tone: "bad" };
  } else {
    slugStatus = { text: "esse endereço não tá disponível ♡", tone: "bad" };
  }

  const slugToneColor =
    slugStatus.tone === "ok"
      ? "var(--lilac-deep)"
      : slugStatus.tone === "bad"
        ? "var(--coral-pink)"
        : "var(--ink-soft)";

  // Finishing is allowed when the slug is either the untouched default (use it
  // as-is, no atualizarSlug call) OR a valid+available custom value.
  const slugOkToFinish = !slugChanged || (slugFormatOk && slugAvailable);

  const finish = async () => {
    if (submitting) return;
    setSubmitting(true);
    setSlugError(null);

    // 1. Claim the chosen slug FIRST (riskiest — UNIQUE conflict). On failure we
    //    abort BEFORE touching the profile, so there's no half-committed state
    //    and the user just picks another slug. Untouched default → skip (it's
    //    already theirs from the auto-derive at signup).
    let finalSlug = defaultSlug;
    if (slugChanged) {
      try {
        await atualizarSlug.mutateAsync({ novoSlug: slug });
        finalSlug = slug;
      } catch (err) {
        const code = (err as { data?: { code?: string } })?.data?.code;
        if (code === "CONFLICT") {
          setSlugError("esse endereço já está em uso — escolha outro ♡");
        } else if (code === "BAD_REQUEST") {
          setSlugError(
            "formato inválido: 3–30 caracteres, começa com letra, só a–z, números e hífen",
          );
        } else {
          setSlugError("não consegui reservar esse link — tenta de novo?");
        }
        setSubmitting(false);
        return;
      }
    }

    // 2. Save the profile. aperture-qmaoi — the baby-half targets the
    //    auto-created FIRST campanha via perfilCampanha.atualizar (per-campanha
    //    isolation; the needsOnboarding gate reads perfil_campanhas.nome_bebe,
    //    aperture-3vc12). perfil.atualizar keeps ONLY the user-half
    //    (nomeExibicao). ORDER MATTERS during Rex's transitional shim window:
    //    perfil.atualizar whole-content-writes its baby-half to the OLDEST
    //    campanha, so it runs FIRST and the perfilCampanha write lands LAST —
    //    the wizard's fresh values win. No-campanha edge (me.idCampanha
    //    absent): send the baby-half through perfil.atualizar as before —
    //    never invent an id (aperture-1kbyx guardrail).
    try {
      const idCampanha = me.data?.idCampanha ?? null;
      const babyHalf = {
        nomeBebe: babyName.trim() || null,
        genero,
        relacao: null,
        historia: null,
        dataNascimento: null,
        tipoEvento: eventType,
        dataEvento: eventDate ? new Date(`${eventDate}T12:00:00`) : null,
        fotoPerfilKey: null,
        fotoCapaKey: null,
        fotoHistoriaKey: null,
        papais: null,
        corPrimaria: null,
        corAcento: null,
      };
      const nullBabyHalf = {
        nomeBebe: null,
        genero: null,
        relacao: null,
        historia: null,
        dataNascimento: null,
        tipoEvento: null,
        dataEvento: null,
        fotoPerfilKey: null,
        fotoCapaKey: null,
        fotoHistoriaKey: null,
        papais: null,
        corPrimaria: null,
        corAcento: null,
      };
      await atualizarPerfil.mutateAsync({
        nomeExibicao:
          displayName.trim() || me.data?.nomeExibicao || babyName.trim() || "Família",
        ...(idCampanha ? nullBabyHalf : babyHalf),
      });
      if (idCampanha) {
        await atualizarPerfilCampanha.mutateAsync({ idCampanha, ...babyHalf });
      }
      await utils.auth.me.invalidate();
      sendEvent("onboarding_concluido");
      // aperture-ppuay — signup-path identify. The login branch in
      // AuthModalProvider returns early into this wizard for brand-new accounts,
      // so this is the first point a new account gets identified on Mixpanel
      // (distinct_id = idConta) + first-touch utm_source. No-op when dark.
      if (me.data?.idConta) identifyWithUtm(me.data.idConta);
      onDone(finalSlug);
    } catch {
      // aperture-5ho5j — a profile write FAILED (perfil.atualizar or the
      // perfilCampanha.atualizar baby-half): keep the wizard OPEN so the user
      // can retry. (Previously we fired onDone here anyway, which closed the
      // wizard with the profile still empty → needsOnboarding stayed true →
      // the wizard reappeared on the next painel load in a silent loop.)
      // Retry re-runs BOTH writes — each is an idempotent whole-content
      // replacement, so a half-committed first attempt heals on retry.
      //
      // Retry-safety of the slug half: if the slug was changed, atualizarSlug
      // already committed it above — and re-running it with the same value is
      // a backend no-op for the same owner (postgres adapter is a plain UPDATE
      // on the user's own row, no self-conflict on UNIQUE(id_plataforma, slug);
      // memory adapter explicitly allows owner === idUsuario), so no
      // client-side "slugCommitted" guard is needed. We still invalidate
      // auth.me so me.slug refreshes to the committed value → defaultSlug
      // catches up → slugChanged goes false and the retry skips the slug
      // mutation entirely.
      await utils.auth.me.invalidate();
      toast.error("não consegui salvar agora — tenta de novo? ♡");
      setSubmitting(false);
    }
  };

  const canNext1 = babyName.trim().length > 0 && displayName.trim().length > 0;

  const title =
    step === 1
      ? "como vamos chamar o bebê?"
      : step === 2
        ? "quando é o grande dia?"
        : "qual vai ser o link da sua página?";

  return (
    <div className="auth-backdrop" role="dialog" aria-modal="true" aria-label="Vamos montar sua página">
      <style>{AUTH_CSS}</style>
      <div className="auth-card">
        <span aria-hidden="true" className="auth-tape" />
        <header className="auth-head">
          <p className="auth-eyebrow">passo {step} de 3 ♡</p>
          <h2 className="auth-title">{title}</h2>
        </header>

        {step === 1 && (
          <>
            <label className="auth-label" htmlFor="ob-name">
              seu nome
            </label>
            <div className="auth-input-wrap">
              <input
                id="ob-name"
                className="auth-input"
                value={displayName}
                onChange={(e) => {
                  setDisplayNameTouched(true);
                  setDisplayName(e.target.value);
                }}
                placeholder="Luciana Martins"
                autoFocus
              />
            </div>
            <p className="auth-fineprint">é assim que vamos te chamar no seu painel ♡</p>
            <label className="auth-label" htmlFor="ob-baby" style={{ marginTop: 14 }}>
              nome do bebê
            </label>
            <div className="auth-input-wrap">
              <input
                id="ob-baby"
                className="auth-input"
                value={babyName}
                onChange={(e) => setBabyName(e.target.value)}
                placeholder="Maria Helena"
              />
            </div>
            <p className="auth-fineprint">é o nome que aparece na sua página ♡</p>
          </>
        )}

        {step === 2 && (
          <>
            <label className="auth-label" htmlFor="ob-date">
              data do evento
            </label>
            <div className="auth-input-wrap">
              <input
                id="ob-date"
                type="date"
                className="auth-input"
                value={eventDate}
                onChange={(e) => setEventDate(e.target.value)}
              />
            </div>
            <label className="auth-label" htmlFor="ob-type" style={{ marginTop: 14 }}>
              tipo de evento
            </label>
            <div className="auth-input-wrap">
              <select
                id="ob-type"
                className="auth-input"
                value={eventType}
                onChange={(e) => setEventType(e.target.value as EventTypeSlug)}
              >
                {EVENT_TYPES.map((t) => (
                  <option key={t.value} value={t.value}>
                    {t.label}
                  </option>
                ))}
              </select>
            </div>
            <label className="auth-label" htmlFor="ob-genero" style={{ marginTop: 14 }}>
              é menino ou menina?
            </label>
            <div className="auth-input-wrap">
              <select
                id="ob-genero"
                className="auth-input"
                value={genero}
                onChange={(e) => setGenero(e.target.value as Genero)}
              >
                {GENEROS.map((g) => (
                  <option key={g.value} value={g.value}>
                    {g.label}
                  </option>
                ))}
              </select>
            </div>
            <p className="auth-fineprint">você pode ajustar isso depois no seu perfil ♡</p>
          </>
        )}

        {step === 3 && (
          <>
            <label className="auth-label" htmlFor="ob-slug">
              link da sua página
            </label>
            <div className="auth-input-wrap">
              <input
                id="ob-slug"
                className="auth-input"
                value={slug}
                placeholder="seu-link"
                inputMode="url"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                autoFocus
                onChange={(e) => {
                  setSlugTouched(true);
                  setSlugError(null);
                  // sanitize live: lowercase + drop anything outside a–z 0–9 -
                  setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""));
                }}
              />
            </div>
            <p className="auth-fineprint" style={{ marginBottom: 4 }}>
              sua página:{" "}
              <strong style={{ color: "var(--ink)" }}>
                {paginaShareDisplayPrefix()}
                {slug || "seu-link"}
              </strong>
            </p>
            <span
              className="auth-fineprint"
              role={slugStatus.tone === "bad" ? "alert" : undefined}
              style={{ color: slugToneColor, fontWeight: slugStatus.tone === "muted" ? 400 : 600 }}
            >
              {slugStatus.text}
            </span>
          </>
        )}

        <div
          style={{
            display: "flex",
            gap: 10,
            alignItems: "center",
            justifyContent: "space-between",
            marginTop: 20,
          }}
        >
          {step > 1 ? (
            <button
              type="button"
              onClick={() => setStep((s) => (s === 3 ? 2 : 1))}
              disabled={submitting}
              style={{
                background: "none",
                border: "none",
                color: "var(--ink-soft)",
                fontWeight: 600,
                fontSize: 14,
                cursor: submitting ? "default" : "pointer",
              }}
            >
              ← voltar
            </button>
          ) : (
            <span />
          )}

          {step === 1 && (
            <button
              type="button"
              className="auth-cta"
              style={{ width: "auto", flex: "0 0 auto" }}
              onClick={() => setStep(2)}
              disabled={!canNext1}
            >
              próximo <span aria-hidden="true">→</span>
            </button>
          )}
          {step === 2 && (
            <button
              type="button"
              className="auth-cta"
              style={{ width: "auto", flex: "0 0 auto" }}
              onClick={() => setStep(3)}
            >
              próximo <span aria-hidden="true">→</span>
            </button>
          )}
          {step === 3 && (
            <button
              type="button"
              className="auth-cta"
              style={{ width: "auto", flex: "0 0 auto" }}
              onClick={finish}
              disabled={submitting || !slugOkToFinish}
            >
              {submitting ? "salvando…" : "criar minha página ♡"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
