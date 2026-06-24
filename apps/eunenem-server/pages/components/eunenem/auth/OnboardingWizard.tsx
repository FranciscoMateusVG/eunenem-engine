// aperture-84a21 — post-signup onboarding capture.
//
// Fires right AFTER a successful signUp (session present), opened by
// AuthModalProvider in place of the immediate redirect-to-painel. Captures the
// fields a brand-new account would otherwise leave null (→ the mock "15 jun
// 2026" date + "página da bebê" fallback the operator kept hitting):
//
//   step 1 — nome do bebê (nomeBebe)
//   step 2 — data do evento (dataEvento) + tipo de evento (tipoEvento)
//
// Wiring is ZERO-new-backend: perfil.atualizar (the same use-case the painel
// editor uses). On finish → /painel/<slug> (the auto-derived slug, unchanged).
//
// NOTE (aperture-84a21 decision, option B): the vanity SLUG picker is held
// under aperture-4y1y4 (operator A/B onboarding approval pending), so it is
// intentionally NOT part of this wizard — the account keeps its auto-derived
// slug. dataEvento is optional here (no trap if the user doesn't know the date
// yet); a null date is handled gracefully on the painel (no fake date), per the
// companion PainelHeaderCard fix in this same bead.
//
// A new account has every profile field null except nomeExibicao (set at
// signup), so perfil.atualizar is sent with the other fields as null — correct
// for the onboarding context (the wizard only ever runs post-signup).
import { useState } from "react";
import { toast } from "sonner";

import { trpc } from "@/lib/trpc";
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

export function OnboardingWizard({ onDone }: { onDone: (slug: string) => void }) {
  const me = trpc.auth.me.useQuery(undefined, { staleTime: 0 });
  const utils = trpc.useUtils();
  const atualizarPerfil = trpc.perfil.atualizar.useMutation();

  const [step, setStep] = useState<1 | 2>(1);
  const [babyName, setBabyName] = useState("");
  const [eventDate, setEventDate] = useState("");
  const [eventType, setEventType] = useState<EventTypeSlug>("cha-bebe");
  const [submitting, setSubmitting] = useState(false);

  const finish = async () => {
    if (submitting) return;
    setSubmitting(true);
    try {
      // Fresh account → the non-captured fields are null. nomeExibicao is
      // required by the schema; carry the one set at signup.
      await atualizarPerfil.mutateAsync({
        nomeExibicao: me.data?.nomeExibicao || babyName.trim() || "Família",
        nomeBebe: babyName.trim() || null,
        relacao: null,
        historia: null,
        dataNascimento: null,
        tipoEvento: eventType,
        dataEvento: eventDate ? new Date(`${eventDate}T12:00:00`) : null,
        fotoPerfilKey: null,
        fotoCapaKey: null,
        fotoHistoriaKey: null,
      });
      await utils.auth.me.invalidate();
      onDone(me.data?.slug ?? "");
    } catch {
      toast.error("não consegui salvar agora — tenta de novo ♡");
      setSubmitting(false);
    }
  };

  const canNext1 = babyName.trim().length > 0;

  return (
    <div className="auth-backdrop" role="dialog" aria-modal="true" aria-label="Vamos montar sua página">
      <style>{AUTH_CSS}</style>
      <div className="auth-card">
        <span aria-hidden="true" className="auth-tape" />
        <header className="auth-head">
          <p className="auth-eyebrow">passo {step} de 2 ♡</p>
          <h2 className="auth-title">
            {step === 1 ? "como vamos chamar o bebê?" : "quando é o grande dia?"}
          </h2>
        </header>

        {step === 1 && (
          <>
            <label className="auth-label" htmlFor="ob-baby">
              nome do bebê
            </label>
            <div className="auth-input-wrap">
              <input
                id="ob-baby"
                className="auth-input"
                value={babyName}
                onChange={(e) => setBabyName(e.target.value)}
                placeholder="Maria Helena"
                autoFocus
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
            <p className="auth-fineprint">você pode ajustar isso depois no seu perfil ♡</p>
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
          {step === 2 ? (
            <button
              type="button"
              onClick={() => setStep(1)}
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
          {step === 1 ? (
            <button
              type="button"
              className="auth-cta"
              style={{ width: "auto", flex: "0 0 auto" }}
              onClick={() => setStep(2)}
              disabled={!canNext1}
            >
              próximo <span aria-hidden="true">→</span>
            </button>
          ) : (
            <button
              type="button"
              className="auth-cta"
              style={{ width: "auto", flex: "0 0 auto" }}
              onClick={finish}
              disabled={submitting}
            >
              {submitting ? "salvando…" : "criar minha página ♡"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
