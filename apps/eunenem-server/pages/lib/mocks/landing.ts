// aperture-q1j2 — mock copy for the marketing Landing page (/).
//
// Ported verbatim (pt-BR) from the Next.js prototype components. Static,
// no persistence, no backend: the landing is a pure marketing surface.
// SVGs / decorative JSX stay in the section components; only the textual
// copy + structural data live here, mirroring painelDemo.ts conventions.

import { templateSelectionPatch } from '../convite';
import { DEFAULT_STATE, type ConviteState } from './convite';
import { TEMPLATE_BY_ID } from './templates';

/** Navbar anchor links (label → in-page href). */
export const NAV_LINKS: ReadonlyArray<readonly [string, string]> = [
  ['como funciona', '#como-funciona'],
  ['convites', '#convites'],
  ['depoimentos', '#depoimentos'],
  ['dúvidas', '/faq'],
];

/** Top stat band — number markup kept in component; here is the raw copy. */
export interface LandingStat {
  /** Prefix before the emphasised token (may be empty). */
  pre: string;
  /** Emphasised token (rendered in lilac-deep). */
  em: string;
  /** Suffix after the emphasised token (may be empty). */
  post: string;
  label: string;
}

export const LANDING_STATS: ReadonlyArray<LandingStat> = [
  { pre: '', em: '+300', post: ' mil', label: 'famílias atendidas' },
  { pre: 'desde ', em: '2014', post: '', label: 'no mercado' },
  { pre: '', em: '#1', post: ' no Brasil', label: 'plataforma de chá online' },
];

/** "Como funciona" — 3-step flow. */
export interface LandingStep {
  n: number;
  /** Tailwind bg colour utility for the tile. */
  color: string;
  /** Tailwind rotation utility for the scrapbook tilt. */
  rot: string;
  title: string;
  desc: string;
}

export const LANDING_STEPS: ReadonlyArray<LandingStep> = [
  {
    n: 1,
    color: 'bg-pink',
    rot: '-rotate-3',
    title: 'crie sua lista',
    desc: 'Cadastre-se grátis e monte com os itens que quer, ou use uma lista pronta sugerida pela equipe.',
  },
  {
    n: 2,
    color: 'bg-green',
    rot: 'rotate-2',
    title: 'compartilhe',
    desc: 'Envie o link pelo WhatsApp ou crie um convite digital personalizado para o seu evento.',
  },
  {
    n: 3,
    color: 'bg-blue',
    rot: '-rotate-2',
    title: 'receba em dinheiro',
    desc: 'Seus convidados presenteiam online e você saca direto na sua conta bancária, quando quiser.',
  },
];

/** "O diferencial" — why money is better, 3 cards. */
export interface LandingDifferential {
  /** Tailwind bg colour utility for the icon chip. */
  bg: string;
  /** SVG stroke colour (matches the chip contrast). */
  stroke: string;
  title: string;
  desc: string;
}

export const LANDING_DIFFERENTIALS: ReadonlyArray<LandingDifferential> = [
  {
    bg: 'bg-green',
    stroke: '#fff',
    title: 'compre o que o bebê precisa',
    desc: 'Sem depender de marcas ou modelos que alguém escolheu por você. Liberdade total para acertar.',
  },
  {
    bg: 'bg-yellow',
    stroke: '#5C3A4F',
    title: 'convidados de onde estiverem',
    desc: 'Sem filas, sem presente repetido, sem frete. Família e amigos colaboram em segundos pelo celular.',
  },
  {
    bg: 'bg-blue',
    stroke: '#fff',
    title: 'dinheiro direto na sua conta',
    desc: 'Transparência total em cada presente, em cada taxa. Você acompanha tudo e saca quando quiser.',
  },
];

/** Watercolor template ids showcased on the landing invites gallery. */
export const LANDING_INVITE_TEMPLATE_IDS = [
  'aviao-nas-nuvens',
  'balao-rosa',
  'baloes-no-ceu',
] as const;

const LANDING_INVITE_CLEAN: Pick<
  ConviteState,
  'address' | 'hashtag' | 'showHashtag' | 'rsvp' | 'gifts' | 'bgUpload'
> = {
  address: '',
  hashtag: '',
  showHashtag: false,
  rsvp: false,
  gifts: false,
  bgUpload: null,
};

/** Real template previews — rendered via InvitePreview on the landing. */
export const LANDING_INVITE_DEMOS: ReadonlyArray<ConviteState> = [
  {
    ...DEFAULT_STATE,
    ...templateSelectionPatch(TEMPLATE_BY_ID['urso-nas-nuvens']!),
    ...LANDING_INVITE_CLEAN,
    eventType: 'batizado',
    mode: 'presencial',
    babyName: 'Pedro',
    host: 'Beatriz',
    date: '2027-07-20',
    time: '18:00',
    message: 'Consagro minha vida ao Senhor',
  },
  {
    ...DEFAULT_STATE,
    ...templateSelectionPatch(TEMPLATE_BY_ID['balao-dourado']!),
    ...LANDING_INVITE_CLEAN,
    eventType: 'cha-bebe',
    mode: 'presencial',
    babyName: 'Miguel',
    host: 'Luciana',
    date: '2027-07-20',
    time: '18:00',
    message: 'Estou chegando para completar a família!',
  },
  {
    ...DEFAULT_STATE,
    ...templateSelectionPatch(TEMPLATE_BY_ID['balao-rosa']!),
    ...LANDING_INVITE_CLEAN,
    eventType: 'cha-bebe',
    mode: 'presencial',
    babyName: 'Maria Júlia',
    host: 'César & Camila',
    date: '2027-07-20',
    time: '18:00',
    address: 'Rua Curitiba, 123',
  },
  {
    ...DEFAULT_STATE,
    ...templateSelectionPatch(TEMPLATE_BY_ID['patinho-laco-azul']!),
    ...LANDING_INVITE_CLEAN,
    eventType: 'cha-fraldas',
    mode: 'presencial',
    babyName: 'Joaquim',
    host: 'Mariana e Jorge',
    date: '2026-08-15',
    time: '15:00',
  },
  {
    ...DEFAULT_STATE,
    ...templateSelectionPatch(TEMPLATE_BY_ID['margaridas']!),
    ...LANDING_INVITE_CLEAN,
    eventType: 'aniversario',
    mode: 'presencial',
    babyName: 'Ana Laura',
    host: 'Poliana',
    date: '2026-08-15',
    time: '15:00',
    message: 'Venha comemorar o primeiro aninho',
    address: 'Rua Curitiba, 123',
  },
  {
    ...DEFAULT_STATE,
    ...templateSelectionPatch(TEMPLATE_BY_ID['varal-classico']!),
    ...LANDING_INVITE_CLEAN,
    eventType: 'cha-bebe',
    mode: 'presencial',
    babyName: 'Ana Catarina',
    host: 'Bruna',
    date: '2026-08-15',
    time: '15:00',
    message: 'Venha celebrar com a gente a chegada da nossa princesa!',
    address: 'Rua das Acácias, 142, Vila Mariana - São Paulo',
  },
];

/** "Como visto em" press logos (rendered as text wordmarks). */
export const LANDING_MEDIA: ReadonlyArray<string> = [
  'Estadão',
  'Globo / PEGN',
  'R7',
  'O Tempo',
  'SEBRAE',
  'StartSe',
];

/** Testimonial card (used by both highlight + full grid). */
export interface LandingTestimonial {
  quote: string;
  img: string;
  name: string;
  meta: string;
}

/** Two featured testimonials (TestimonialsHighlight). */
export const LANDING_TESTIMONIALS_HIGHLIGHT: ReadonlyArray<LandingTestimonial> = [
  {
    quote:
      '"A experiência foi muito positiva. Preferia receber em dinheiro, para comprar o que realmente precisasse e do meu gosto."',
    img: '/public/dep-luciana.jpg',
    name: 'Luciana Jardim',
    meta: 'mãe de primeira viagem',
  },
  {
    quote:
      '"A plataforma foi simplesmente incrível! Meus familiares puderam colaborar mesmo estando longe. Facilitaram demais a vida desse pai de primeira viagem! ❤️"',
    img: '/public/dep-rodrigo.jpg',
    name: 'Rodrigo Pitta',
    meta: 'pai de primeira viagem',
  },
];

/** Aggregate rating shown above the testimonial grid. */
export const LANDING_TESTIMONIALS_RATING = {
  score: '4,9',
  countLabel: '2.847 avaliações',
  fiveStarLabel: '91% deram 5 estrelas',
} as const;

/** Three-up testimonial grid (Testimonials). */
export const LANDING_TESTIMONIALS: ReadonlyArray<LandingTestimonial> = [
  {
    quote:
      '"O site me disponibilizou ótimas ferramentas. Para mim que moro fora do Estado, evitou o desgaste de enviar presentes, que tomaria tempo e geraria gastos desnecessários."',
    img: '/public/dep-ana-paula.jpg',
    name: 'Ana Paula Mesquita',
    meta: 'convidada · Recife',
  },
  {
    quote:
      '"Pesquisei várias plataformas e gostei da EuNeném porque permite edição das sugestões, assim não fica um preço fechado."',
    img: '/public/dep-janaina.jpg',
    name: 'Janaína e Leonardo',
    meta: 'pais do Davi',
  },
  {
    quote:
      '"É fácil de usar, cada presente e mensagem são avisados com rapidez e o valor arrecadado é entregue corretamente."',
    img: '/public/dep-maite.jpg',
    name: 'Maitê Martinelle',
    meta: 'mãe da Liz',
  },
  {
    quote:
      '" Fazer o chá de bebê pela EuNenem contribuiu para que pudéssemos chamar um maior número de convidados e contribuir para que todos pudessem compartilhar dessa alegria. A plataforma é fácil de mexer. Meus convidados amaram!"',
    img: '/public/dep-ana-flavia.jpg',
    name: 'Flávia Albuquerque',
    meta: 'Mãe da Ana Flávia',
  },
  {
    quote:
      '"Eu e meu marido moramos em SP e fizemos o nosso chá no RJ. Com receio de receber muitos presentes e com pouco espaço no carro, começamos a pesquisar uma solução. Foi aí que conhecemos a EuNeném. Um site super simples, que na hora supriu nossas necessidades e nos deu a tranquilidade de escolher os melhores presentinhos para o nosso filho. Como mãe de primeira viagem o site ajudou muito a indicar o que faria sentido incluir na lista. Amamos a experiência. Obrigada EuNeném."',
    img: '/public/dep-baby-mattos.jpg',
    name: 'Livia Felix de Mattos',
    meta: 'Mãe da Baby Mattos',
  }
];

/** Footer link columns. */
export interface LandingFooterCol {
  title: string;
  links: ReadonlyArray<readonly [string, string]>;
}

export const LANDING_FOOTER_COLS: ReadonlyArray<LandingFooterCol> = [
  {
    title: 'dúvidas',
    links: [
      ['perguntas frequentes', '/faq'],
      ['status dos serviços', '/faq'],
      ['taxas', '/faq'],
      ['termos de uso', '/termos-de-uso'],
    ],
  },
  {
    title: 'conteúdo',
    links: [
      ['blog da EuNeném', 'https://blog.eunenem.com'],
      ['instagram', 'https://www.instagram.com/eu_nenem'],
      ['pinterest', 'https://br.pinterest.com/eunenem'],
    ],
  },
  {
    title: 'fale conosco',
    links: [
      ['whatsapp', 'https://eunenem.com/minha-area/fale-com-a-gente'],
      ['oi@eunenem.com', 'mailto:oi@eunenem.com'],
    ],
  },
];

/** Footer social icons (href → label; first char rendered in the chip). */
export const LANDING_FOOTER_SOCIALS: ReadonlyArray<readonly [string, string]> = [
  ['https://www.instagram.com/eu_nenem', 'Instagram'],
  ['https://www.facebook.com/eunenem', 'Facebook'],
  ['https://br.pinterest.com/eunenem', 'Pinterest'],
  ['https://eunenem.com/minha-area/fale-com-a-gente', 'WhatsApp'],
];

/** FAQ — question + answer. Answers with inline links carry a `link` field. */
export const LANDING_CTA_FINAL_PERKS = [
  'Pronto em 5 min',
  'Sem mensalidade',
  'Suporte humano no WhatsApp',
] as const;

export interface LandingFaq {
  q: string;
  a: string;
  /** Optional trailing inline link rendered after the answer text. */
  link?: { label: string; href: string };
}

export const LANDING_FAQS: ReadonlyArray<LandingFaq> = [
  {
    q: 'A EuNeném cobra taxa?',
    a: `Sim. As taxas da EuNeném são cobradas do convidado no momento da compra do presente. Isso significa que o valor que você adiciona à sua lista é exatamente o valor que você receberá. Por exemplo, se você cadastrar um presente de R$ 100, receberá integralmente os R$ 100.

Para viabilizar o funcionamento da plataforma, é cobrada uma taxa de serviço de 7,8% sobre cada presente, destinada a cobrir os custos de operação, manutenção da plataforma e processamento dos pagamentos.

Além disso, para pagamentos realizados por cartão de crédito, há um acréscimo de 3,99%, referente às taxas da operadora de pagamento.

Dessa forma, os futuros pais recebem o valor integral definido na lista, enquanto os custos da transação são pagos por quem realiza a compra do presente.`,
  },
  {
    q: 'Quando posso sacar o dinheiro?',
    a: `O prazo começa a contar assim que o convidado realiza o pagamento do presente.

Pagamentos via Pix: o valor fica disponível para solicitação de resgate em até 10 minutos.

Pagamentos via cartão de crédito: o valor fica disponível para solicitação de resgate em 31 dias corridos.

Depois que você solicitar o resgate, a transferência será realizada para a sua conta em até 3 dias úteis.

Você pode acompanhar todos os presentes recebidos e os valores disponíveis diretamente em seu extrato na EuNeném.`,
  },
  {
    q: 'Como os convidados compram os presentes?',
    a: `Comprar um presente na EuNeném é simples, rápido e seguro:

Seu convidado acessa o link do seu chá de bebê.

Escolhe o presente virtual que deseja dar entre as opções da sua lista.

É direcionado para um ambiente seguro de pagamento, com proteção dos dados da transação.

Escolhe a forma de pagamento, podendo pagar por Pix ou cartão de crédito.

Após a confirmação do pagamento, o valor do presente é creditado em sua conta EuNeném de acordo com os prazos da forma de pagamento escolhida.`,
  },
];
