// aperture-i01o — mock data for /painel/[slug] (Painel do Criador).
//
// In-memory, no persistence. Per Thacy's v3 mockup the page shows a
// snapshot of the event creator's dashboard — counts, recebido,
// menu groups, badges. Everything below is the "Helena" demo
// instance referenced in the mockup. Tweakable fields (babyName,
// targetDate, palette) flow from TweaksContext at render time.

export interface PainelEventSnapshot {
  /** "olá, {greetingTo} ♡" — first name of the logged-in creator. */
  greetingTo: string;
  /** Pretty event date string ("12 jun, sex · 16h"). */
  eventDateLabel: string;
  /** Public share URL fragment shown in the share-link pill. */
  shareUrl: string;
  /** Slug appearing at the tail of the share URL — bolded. */
  shareSlug: string;
  /** Total received in BRL cents (so the cents render is exact). */
  receivedCents: number;
  /** "9/130 presentes" → numerator vs denominator. */
  giftsClaimed: number;
  giftsTotal: number;
  /** RSVP totals for the convidados row. */
  guestsConfirmed: number;
  guestsTotal: number;
  /** Recados count for the mensagens row. */
  messagesTotal: number;
  /** "X novas" badge count on mensagens row. 0 hides the badge. */
  messagesNew: number;
  /**
   * aperture-kvpvf — strip-only PRESENTES count (one per
   * ItemDoPagamento on aprovado pagamentos, NOT one per pagamento).
   * Distinct from `giftsClaimed`, which counts distinct pagamentos
   * and drives the featured "presentes recebidos" card. Wired from
   * `recebedor.extrato.summary.totalPresentesItensCount`; falls back
   * to `giftsClaimed` for the loading/unauth path so the strip still
   * renders something sensible.
   */
  presentesStripCount: number;
  /**
   * aperture-kvpvf — strip-only RECADOS count. Distinct aprovado
   * pagamentos whose contribuinte carries a non-empty mensagem (same
   * predicate as B3's mural projection). Wired from
   * `recebedor.extrato.summary.totalRecadosCount`. Distinct from the
   * `messagesTotal` field used by the "mensagens recebidas" menu row.
   */
  recadosStripCount: number;
}

export const PAINEL_DEMO: PainelEventSnapshot = {
  greetingTo: "Mari",
  // Pretty-format is intentionally hard-coded here; the live countdown
  // numbers come from tweaks.targetDate via CountdownTimer.
  // TODO(aperture-uxv83): swap to campanha.dataEvento when the backend
  // exposes it on auth.me / a campanha-by-id query (currently no wire
  // surface for the event date).
  eventDateLabel: "12 jun, sex · 16h",
  shareUrl: "eunenem.com/",
  shareSlug: "helena",
  // R$ 2.840,00 — matches the v3 mockup's "recebido até agora" figure.
  // aperture-cihww: live values now flow through PainelPage from
  // `trpc.recebedor.extrato.summary` (totalRecebidoCents + totalPresentes).
  // Keep these as fallback for the loading/unauthenticated paths.
  receivedCents: 284000,
  giftsClaimed: 9,
  giftsTotal: 130,
  // TODO(aperture-7eamc): swap to real RSVP counts when the convidado
  // backend ships (no trpc.convidado.* procedure today).
  guestsConfirmed: 28,
  guestsTotal: 42,
  // TODO(aperture-mztrb): swap to real recados counters + "X novas"
  // unread badge when the mensagens backend ships.
  messagesTotal: 12,
  messagesNew: 3,
  // aperture-kvpvf — fallback values for the home stats strip while
  // the recebedor.extrato.summary query is loading / on the public
  // unauth path. Live values flow through PainelPage from
  // totalPresentesItensCount + totalRecadosCount.
  presentesStripCount: 2,
  recadosStripCount: 12,
};

export interface PainelMenuItem {
  id: string;
  label: string;
  sub: string;
  /** Tailwind-side icon-tint variant. Maps to a small palette pinned
   *  by the mockup (var-pink / var-green / var-blue / var-lilac /
   *  var-yellow). `null` = neutral cream tint. */
  variant:
    | "pink"
    | "green"
    | "blue"
    | "lilac"
    | "yellow"
    | null;
  /** Icon name (Lucide-equivalent) — resolved inside PainelMenuRow. */
  icon:
    | "gift"
    | "list"
    | "envelope"
    | "eye"
    | "users"
    | "messages"
    | "raffle"
    | "edit-profile"
    | "bank"
    | "phone";
  /** Optional pill badge ("soft" = lilac, "pink" = coral-pink,
   *  "soon" = dashed-outline, "verified" = blue). */
  badge?: {
    kind: "soft" | "pink" | "soon" | "verified";
    text: string;
  };
  /** Featured rows render slightly larger and with a pink gradient
   *  background — first row in each group. */
  featured?: boolean;
  /** "em breve" rows are visually striped and click-disabled. */
  soon?: boolean;
}

export interface PainelMenuGroup {
  id: string;
  title: string;
  items: PainelMenuItem[];
}

/**
 * Optional live overrides for the "minha lista de presentes" counts.
 * When supplied (aperture-cihww — sourced from `trpc.contribuicao.list`),
 * they replace the demo "9/24" pair. When omitted (loading / no
 * campanha), the snapshot fields are used.
 */
export interface PainelMenuOverrides {
  listaTotal?: number;
  listaClaimed?: number;
}

/**
 * Pure data — wired against PAINEL_DEMO at render time so the badge
 * counts ("9/24", "28/42", "3 novas") and the featured-row subtitle
 * ("9 mimos · R$ 2.840,00 · ver extrato") track the snapshot. Keeping
 * the data here lets PainelMenu stay layout-only.
 */
export function buildPainelMenu(
  snapshot: PainelEventSnapshot,
  overrides: PainelMenuOverrides = {},
): PainelMenuGroup[] {
  const reais = (snapshot.receivedCents / 100).toLocaleString("pt-BR", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  // aperture-cihww — real lista counts when available; fall back to the
  // historical "9/24" demo pair otherwise.
  const listaTotal = overrides.listaTotal ?? 24;
  const listaClaimed = overrides.listaClaimed ?? snapshot.giftsClaimed;

  return [
    {
      id: "evento",
      title: "seu evento",
      items: [
        {
          id: "presentes",
          label: "presentes recebidos",
          // aperture-9qu7k — "presentes" reads more direct than "mimos"
          // for the dashboard row sub (target screenshot 32).
          sub: `${snapshot.giftsClaimed} presentes · R$ ${reais} · ver extrato`,
          variant: "pink",
          icon: "gift",
          featured: true,
        },
        {
          id: "lista",
          label: "minha lista de presentes",
          sub: `${listaTotal} itens · ${listaClaimed} já escolhidos`,
          variant: "lilac",
          icon: "list",
          badge: { kind: "soft", text: `${listaClaimed}/${listaTotal}` },
        },
        {
          id: "convite",
          label: "ver meu convite",
          sub: "prévia do que os convidados veem",
          variant: "blue",
          icon: "envelope",
        },
        {
          id: "preview",
          label: "ver como convidado",
          sub: "teste a experiência de quem presenteia",
          variant: "yellow",
          icon: "eye",
        },
      ],
    },
    {
      id: "convidados",
      title: "convidados",
      items: [
        // TODO(aperture-7eamc): swap guestsTotal/guestsConfirmed to real
        // RSVP data once the convidado backend ships.
        {
          id: "lista-convidados",
          label: "lista de convidados",
          sub: `${snapshot.guestsTotal} convidados · ${snapshot.guestsConfirmed} confirmados`,
          variant: "green",
          icon: "users",
          badge: {
            kind: "soft",
            text: `${snapshot.guestsConfirmed}/${snapshot.guestsTotal}`,
          },
        },
        // TODO(aperture-mztrb): swap messagesTotal + messagesNew to real
        // recados counters when the mensagens backend ships.
        {
          id: "mensagens",
          label: "mensagens recebidas",
          sub: `${snapshot.messagesTotal} recados carinhosos`,
          variant: "pink",
          icon: "messages",
          badge:
            snapshot.messagesNew > 0
              ? { kind: "pink", text: `${snapshot.messagesNew} novas` }
              : undefined,
        },
      ],
    },
    {
      id: "novo",
      title: "novo",
      items: [
        {
          id: "rifa",
          label: "rifa",
          sub: "sorteie um mimo entre seus convidados",
          variant: "lilac",
          icon: "raffle",
          badge: { kind: "soon", text: "em breve" },
          soon: true,
        },
      ],
    },
    {
      id: "conta",
      title: "conta & ajuda",
      items: [
        // TODO(aperture-5q39i): wire to the real perfil edit backend
        // (nome/foto/história) when trpc.usuario.updateProfile ships.
        {
          id: "perfil",
          label: "editar meu perfil",
          sub: "nome, foto, história do bebê",
          variant: null,
          icon: "edit-profile",
        },
        // TODO(aperture-aqiu7): only render the "verificado" chip when
        // the Stripe Connect account is truly verified (charges_enabled
        // + payouts_enabled). Today it's hard-coded.
        {
          id: "bancarios",
          label: "dados bancários",
          sub: "para onde a gente envia",
          variant: null,
          icon: "bank",
          badge: { kind: "verified", text: "verificado" },
        },
        {
          id: "suporte",
          label: "fale com a gente",
          sub: "WhatsApp · seg a sex, 9h–18h",
          variant: null,
          icon: "phone",
        },
      ],
    },
  ];
}
