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
}

export const PAINEL_DEMO: PainelEventSnapshot = {
  greetingTo: "Mari",
  // Pretty-format is intentionally hard-coded here; the live countdown
  // numbers come from tweaks.targetDate via CountdownTimer.
  eventDateLabel: "12 jun, sex · 16h",
  shareUrl: "eunenem.com/",
  shareSlug: "helena",
  // R$ 2.840,00 — matches the v3 mockup's "recebido até agora" figure.
  receivedCents: 284000,
  giftsClaimed: 9,
  giftsTotal: 130,
  guestsConfirmed: 28,
  guestsTotal: 42,
  messagesTotal: 12,
  messagesNew: 3,
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
 * Pure data — wired against PAINEL_DEMO at render time so the badge
 * counts ("9/24", "28/42", "3 novas") and the featured-row subtitle
 * ("9 mimos · R$ 2.840,00 · ver extrato") track the snapshot. Keeping
 * the data here lets PainelMenu stay layout-only.
 */
export function buildPainelMenu(
  snapshot: PainelEventSnapshot,
): PainelMenuGroup[] {
  const reais = (snapshot.receivedCents / 100).toLocaleString("pt-BR", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

  return [
    {
      id: "evento",
      title: "seu evento",
      items: [
        {
          id: "presentes",
          label: "presentes recebidos",
          sub: `${snapshot.giftsClaimed} mimos · R$ ${reais} · ver extrato`,
          variant: "pink",
          icon: "gift",
          featured: true,
        },
        {
          id: "lista",
          label: "minha lista de presentes",
          sub: `24 itens · ${snapshot.giftsClaimed} já escolhidos`,
          variant: "lilac",
          icon: "list",
          badge: { kind: "soft", text: `${snapshot.giftsClaimed}/24` },
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
        {
          id: "perfil",
          label: "editar meu perfil",
          sub: "nome, foto, história do bebê",
          variant: null,
          icon: "edit-profile",
        },
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
