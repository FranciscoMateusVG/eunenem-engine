// aperture-7nius — 9-step config for the painel tutorial overlay.
//
// Source-of-truth: plans/0018-first-time-tutorial.md §Step config (verbatim
// transcription of the 18 operator-approved screenshots dated 2026-06-04
// 12:55–12:57). targetIds match painelDemo.ts row ids so the overlay can
// locate each step's DOM node via
//
//     document.querySelector(`[data-tutorial-target="${id}"]`)
//
// Step count is FIXED at 9. Adding/removing/reordering steps is a content
// change with operator + bead approval — not a "just edit the array" call.

export interface TutorialStep {
  /** Matches the row's `data-tutorial-target` attribute (= painelDemo id). */
  readonly targetId: string;
  /** Popover title — lowercase per the screenshots. */
  readonly titulo: string;
  /** Popover body copy. */
  readonly descricao: string;
  /** Preferred popover side relative to the target rect. The overlay falls
   *  back to the opposite side if the preferred placement would clip the
   *  viewport edge. */
  readonly defaultPosition: "top" | "bottom";
}

export const PAINEL_TUTORIAL_STEPS: readonly TutorialStep[] = [
  {
    targetId: "presentes",
    titulo: "presentes recebidos",
    descricao:
      "Acompanhe cada presente em dinheiro que chega e abra o extrato completo, com datas e quem enviou.",
    defaultPosition: "bottom",
  },
  {
    targetId: "lista",
    titulo: "minha lista de presentes",
    descricao:
      "Monte e edite a lista de itens que você sonha para o bebê — a gente cuida da conversão em dinheiro.",
    defaultPosition: "top",
  },
  {
    targetId: "convite",
    titulo: "ver meu convite",
    descricao:
      "Veja a prévia do convite exatamente como seus convidados vão recebê-lo.",
    defaultPosition: "top",
  },
  {
    targetId: "preview",
    titulo: "ver como convidado",
    descricao:
      "Navegue na sua página como se fosse um convidado, para testar toda a experiência de presentear.",
    defaultPosition: "top",
  },
  {
    targetId: "lista-convidados",
    titulo: "lista de convidados",
    descricao:
      "Veja quem foi convidado e acompanhe quem já confirmou presença no chá.",
    defaultPosition: "bottom",
  },
  {
    targetId: "mensagens",
    titulo: "mensagens recebidas",
    descricao:
      "Leia os recados carinhosos que seus convidados deixaram para a sua página.",
    defaultPosition: "bottom",
  },
  {
    targetId: "perfil",
    titulo: "editar meu perfil",
    descricao:
      "Atualize seu nome, a foto e a história do seu bebê que aparece na página.",
    defaultPosition: "top",
  },
  {
    targetId: "bancarios",
    titulo: "dados bancários",
    descricao:
      "Cadastre e confira a conta para onde enviamos o valor dos presentes recebidos.",
    defaultPosition: "top",
  },
  {
    targetId: "suporte",
    titulo: "fale com a gente",
    descricao:
      "Precisa de ajuda? Fale com o nosso time por WhatsApp ou e-mail, de segunda a sexta.",
    defaultPosition: "top",
  },
] as const;

export const PAINEL_TUTORIAL_TOTAL_STEPS = PAINEL_TUTORIAL_STEPS.length;
