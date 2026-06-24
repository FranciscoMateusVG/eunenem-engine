import type {
  FonteConvite,
  ModeloConvite,
  ModalidadeEvento,
  PaletaConvite,
  TipoEvento,
} from '../../../../src/index.js';
import { DEFAULT_STATE, type ConviteState } from './mocks/convite.js';

export interface EventoConviteSnapshot {
  id: string;
  tipoEvento: TipoEvento;
  modalidade: ModalidadeEvento;
  dataHoraIso: string;
  endereco: string | null;
}

export interface ConviteSnapshot {
  id: string;
  remetente: string;
  nomeExibido: string;
  mensagem: string;
  paleta: PaletaConvite;
  fonte: FonteConvite;
  modelo: ModeloConvite;
  imagemUrl: string | null;
}

export interface EventoConviteQueryData {
  evento: EventoConviteSnapshot | null;
  convite: ConviteSnapshot | null;
}

export interface SaveConvitePayload {
  tipoEvento: TipoEvento;
  modalidade: ModalidadeEvento;
  dataHoraIso: string;
  endereco: string | null;
  remetente: string;
  nomeExibido: string;
  mensagem: string;
  paleta: PaletaConvite;
  fonte: FonteConvite;
  modelo: ModeloConvite;
  /** aperture-j4zjw — custom-photo background URL (null for template/paper). */
  imagemUrl: string | null;
}

const UI_TO_DOMAIN_PALETTE = {
  lilas: 'lilas',
  coral: 'rosa-coral',
  lime: 'verde-limao',
  azul: 'azul-claro',
  butter: 'amarelo',
  cream: 'cream',
} satisfies Record<string, PaletaConvite>;

const DOMAIN_TO_UI_PALETTE = {
  lilas: 'lilas',
  'rosa-coral': 'coral',
  'verde-limao': 'lime',
  'azul-claro': 'azul',
  amarelo: 'butter',
  cream: 'cream',
  surpresa: DEFAULT_STATE.palette,
} satisfies Record<PaletaConvite, ConviteState['palette']>;

const UI_TO_DOMAIN_TEMPLATE = {
  none: 'scrapbook',
  'varal-classico': 'varal-de-mimos',
  'balao-rosa': 'balao-de-ar',
  'jardim-romantico': 'jardim-romantico',
  lavanda: 'lavanda',
  'floresta-magica': 'floresta-magica',
  'varal-coracoes': 'roupinhas-e-coracoes',
  'berco-floral': 'berco-floral',
  'arco-iris-boho': 'arco-iris-boho',
  margaridas: 'margaridas',
  'girafa-bailarina': 'girafinha-bailarina',
  'safari-girafa': 'safari',
  'elefante-balao': 'elefantinho',
} satisfies Record<string, ModeloConvite>;

const DOMAIN_TO_UI_TEMPLATE = {
  scrapbook: 'none',
  'varal-de-mimos': 'varal-classico',
  'balao-de-ar': 'balao-rosa',
  'jardim-romantico': 'jardim-romantico',
  lavanda: 'lavanda',
  'floresta-magica': 'floresta-magica',
  'roupinhas-e-coracoes': 'varal-coracoes',
  'berco-floral': 'berco-floral',
  'arco-iris-boho': 'arco-iris-boho',
  margaridas: 'margaridas',
  'girafinha-bailarina': 'girafa-bailarina',
  safari: 'safari-girafa',
  elefantinho: 'elefante-balao',
} satisfies Record<ModeloConvite, string>;

export function conviteStateFromData(data: EventoConviteQueryData | undefined): ConviteState {
  if (!data?.evento) {
    return { ...DEFAULT_STATE };
  }

  const { date, time } = splitIsoToLocalFields(data.evento.dataHoraIso);
  const convite = data.convite;

  const bgTemplate = convite ? templateFromDomain(convite.modelo) : DEFAULT_STATE.bgTemplate;
  // aperture-j4zjw — rehydrate the custom photo ONLY when the modelo maps to the
  // "none" (scrapbook) slot, since bgTemplate and bgUpload are mutually
  // exclusive in state and a watercolor template must win over any stale
  // imagemUrl. A saved photo lives as modelo=scrapbook + imagemUrl set; the
  // plain paper choice is modelo=scrapbook + imagemUrl null.
  const bgUpload =
    bgTemplate === 'none' && convite?.imagemUrl ? convite.imagemUrl : null;

  return {
    ...DEFAULT_STATE,
    eventType: data.evento.tipoEvento,
    mode: data.evento.modalidade,
    date,
    time,
    address: data.evento.modalidade === 'presencial' ? (data.evento.endereco ?? '') : '',
    babyName: convite?.nomeExibido ?? DEFAULT_STATE.babyName,
    host: convite?.remetente ?? DEFAULT_STATE.host,
    message: convite?.mensagem ?? DEFAULT_STATE.message,
    palette: convite ? paletteFromDomain(convite.paleta) : DEFAULT_STATE.palette,
    nameFont: convite?.fonte ?? DEFAULT_STATE.nameFont,
    bgTemplate,
    bgUpload,
    onlineLink: '',
  };
}

export function savePayloadFromConviteState(state: ConviteState): SaveConvitePayload {
  return {
    tipoEvento: state.eventType,
    modalidade: state.mode,
    dataHoraIso: combineLocalDateAndTime(state.date, state.time),
    endereco: state.mode === 'presencial' ? normalizeNullableString(state.address) : null,
    remetente: state.host,
    nomeExibido: state.babyName,
    mensagem: state.message,
    paleta: paletteToDomain(state.palette),
    fonte: state.nameFont,
    modelo: templateToDomain(state.bgTemplate),
    // aperture-j4zjw — bgUpload now holds an uploaded http(s) URL (the upload
    // flow PUTs the photo to storage and stores the public URL, not a base64
    // dataUrl). Send it as imagemUrl so the custom photo persists; null when a
    // template/paper is chosen (bgUpload is cleared on template/paper select).
    imagemUrl: state.bgUpload && state.bgUpload.length > 0 ? state.bgUpload : null,
  };
}

export function paletteToDomain(paletteId: string): PaletaConvite {
  return UI_TO_DOMAIN_PALETTE[paletteId as keyof typeof UI_TO_DOMAIN_PALETTE] ?? 'lilas';
}

export function paletteFromDomain(palette: PaletaConvite): ConviteState['palette'] {
  return DOMAIN_TO_UI_PALETTE[palette] ?? DEFAULT_STATE.palette;
}

export function templateToDomain(templateId: string): ModeloConvite {
  return UI_TO_DOMAIN_TEMPLATE[templateId as keyof typeof UI_TO_DOMAIN_TEMPLATE] ?? 'scrapbook';
}

export function templateFromDomain(modelo: ModeloConvite): string {
  return DOMAIN_TO_UI_TEMPLATE[modelo] ?? 'none';
}

function splitIsoToLocalFields(dataHoraIso: string): { date: string; time: string } {
  const date = new Date(dataHoraIso);
  if (Number.isNaN(date.getTime())) {
    return {
      date: DEFAULT_STATE.date,
      time: DEFAULT_STATE.time,
    };
  }

  return {
    date: [
      date.getFullYear(),
      String(date.getMonth() + 1).padStart(2, '0'),
      String(date.getDate()).padStart(2, '0'),
    ].join('-'),
    time: [String(date.getHours()).padStart(2, '0'), String(date.getMinutes()).padStart(2, '0')].join(
      ':',
    ),
  };
}

function combineLocalDateAndTime(date: string, time: string): string {
  const normalizedTime = time.trim().length > 0 ? time : '00:00';
  const combined = new Date(`${date}T${normalizedTime}:00`);
  if (Number.isNaN(combined.getTime())) {
    throw new Error('Data ou hora do convite invalida');
  }
  return combined.toISOString();
}

function normalizeNullableString(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}
