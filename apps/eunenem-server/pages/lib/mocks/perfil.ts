// aperture-1z6xa — mock data for /painel/[slug]/perfil (Editar Perfil).
//
// In-memory, no persistence. Per the "Editar Perfil" export the page is a
// profile-edit form for the event creator: page link (slug), important dates,
// baby + creator info, and the "minha história" free-text. PerfilBody seeds
// its controlled inputs from this snapshot; "salvar" is a mock (sonner toast,
// no backend) per the mock-first constraint. On reload everything resets to
// these defaults.

export interface PerfilEventType {
  /** Stable value stored on the form. */
  value: string;
  /** pt-BR label shown in the <select>. */
  label: string;
}

export interface PerfilRelation {
  value: string;
  label: string;
}

export interface PerfilSnapshot {
  /** Slug at the tail of the public page URL (eunenem.com/<slug>). */
  profileSlug: string;
  /** Public base shown before the slug in the link field + share row. */
  shareBase: string;
  /** Baby/event name (required field). */
  babyName: string;
  /** Creator's display name ("seu nome" + greeting). */
  creatorName: string;
  /** Relationship to the baby (Mãe, Pai, …). */
  relation: string;
  /** Event type (Aniversário, Chá de bebê, …). */
  eventType: string;
  /** Tea/party date — Brazilian dd/mm/aaaa string. */
  teaDate: string;
  /** Expected birth date — dd/mm/aaaa (may be empty). */
  birthDate: string;
  /** "minha história" free-text body. */
  story: string;
  /** Hard cap on the story textarea. */
  storyMax: number;
}

export const PERFIL_DEMO: PerfilSnapshot = {
  profileSlug: "helena",
  shareBase: "eunenem.com/",
  babyName: "Helena",
  creatorName: "Thacyane",
  relation: "Mãe",
  eventType: "Chá de bebê",
  teaDate: "23/07/2026",
  birthDate: "",
  story:
    "A gente esperou tanto por ela ♡ Quando vimos aquele segundo risquinho no teste, " +
    "o mundo ficou cor-de-rosa. A Helena chega cheia de sonhos da família inteira — " +
    "e a gente queria dividir essa alegria com quem a gente ama.",
  storyMax: 600,
};

/** Relationship options ("parentesco"). */
export const PERFIL_RELATIONS: PerfilRelation[] = [
  { value: "Mãe", label: "Mãe" },
  { value: "Pai", label: "Pai" },
  { value: "Madrinha", label: "Madrinha" },
  { value: "Padrinho", label: "Padrinho" },
  { value: "Avó", label: "Avó" },
  { value: "Avô", label: "Avô" },
  { value: "Tia", label: "Tia" },
  { value: "Tio", label: "Tio" },
  { value: "Outro", label: "Outro" },
];

/** Event-type options. */
export const PERFIL_EVENT_TYPES: PerfilEventType[] = [
  { value: "Chá de bebê", label: "Chá de bebê" },
  { value: "Chá revelação", label: "Chá revelação" },
  { value: "Maternidade", label: "Maternidade" },
  { value: "Aniversário", label: "Aniversário" },
];
