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
  // aperture-mu1v9: the eventos row may be PARTIAL (wizard-seeded via
  // perfilCampanha.atualizar — tipo/data only). tipoEvento/modalidade are
  // nullable on read; the SAVE payload below stays strict.
  tipoEvento: TipoEvento | null;
  modalidade: ModalidadeEvento | null;
  dataHoraIso: string | null;
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
  dataHoraIso: string | null;
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
  'aviao-nas-nuvens': 'aviao-nas-nuvens',
  'balao-dourado': 'balao-dourado',
  'baloes-no-ceu': 'baloes-no-ceu',
  'bandeirinhas-ursinho': 'bandeirinhas-ursinho',
  'bichinhos-do-bosque': 'bichinhos-do-bosque',
  'bola-na-rede': 'bola-na-rede',
  'borboleta-encantada': 'borboleta-encantada',
  'campo-de-futebol': 'campo-de-futebol',
  'coelhinho-e-bebe': 'coelhinho-e-bebe',
  'dinossauro-aviador': 'dinossauro-aviador',
  'dinossauro-azul': 'dinossauro-azul',
  dormitorio: 'dormitorio',
  'elefante-no-luar': 'elefante-no-luar',
  'flor-amarela': 'flor-amarela',
  'florestas-azuis-aquarela': 'florestas-azuis-aquarela',
  'fundo-marinho': 'fundo-marinho',
  'futebol-divertido': 'futebol-divertido',
  'girafa-estrelada': 'girafa-estrelada',
  'patinho-laco-azul': 'patinho-laco-azul',
  'patinho-xadrez': 'patinho-xadrez',
  'quadra-de-futebol': 'quadra-de-futebol',
  'roupinhas-delicada': 'roupinhas-delicada',
  'urso-com-baloes': 'urso-com-baloes',
  'urso-nas-nuvens': 'urso-nas-nuvens',
  'xadrez-azul-suave': 'xadrez-azul-suave',
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
  'aviao-nas-nuvens': 'aviao-nas-nuvens',
  'balao-dourado': 'balao-dourado',
  'baloes-no-ceu': 'baloes-no-ceu',
  'bandeirinhas-ursinho': 'bandeirinhas-ursinho',
  'bichinhos-do-bosque': 'bichinhos-do-bosque',
  'bola-na-rede': 'bola-na-rede',
  'borboleta-encantada': 'borboleta-encantada',
  'campo-de-futebol': 'campo-de-futebol',
  'coelhinho-e-bebe': 'coelhinho-e-bebe',
  'dinossauro-aviador': 'dinossauro-aviador',
  'dinossauro-azul': 'dinossauro-azul',
  dormitorio: 'dormitorio',
  'elefante-no-luar': 'elefante-no-luar',
  'flor-amarela': 'flor-amarela',
  'florestas-azuis-aquarela': 'florestas-azuis-aquarela',
  'fundo-marinho': 'fundo-marinho',
  'futebol-divertido': 'futebol-divertido',
  'girafa-estrelada': 'girafa-estrelada',
  'patinho-laco-azul': 'patinho-laco-azul',
  'patinho-xadrez': 'patinho-xadrez',
  'quadra-de-futebol': 'quadra-de-futebol',
  'roupinhas-delicada': 'roupinhas-delicada',
  'urso-com-baloes': 'urso-com-baloes',
  'urso-nas-nuvens': 'urso-nas-nuvens',
  'xadrez-azul-suave': 'xadrez-azul-suave',
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
    // aperture-mu1v9: a wizard-seeded partial evento carries no tipo and/or
    // no modalidade yet — fall back to the editor defaults explicitly.
    eventType: data.evento.tipoEvento ?? DEFAULT_STATE.eventType,
    mode: data.evento.modalidade ?? DEFAULT_STATE.mode,
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

/**
 * Sentinel-seconds trick: `dataHoraIso` is a SINGLE timestamp column, so when
 * the creator fills in the date but leaves the time blank, we still have to
 * persist *some* time-of-day alongside the date — there's no separate
 * "horário indefinido" column. `<input type="time">` never produces seconds
 * (its value is always "HH:MM"), so the seconds slot is free for us to use
 * as an internal marker:
 *   - time filled in by the creator → always saved with :00 seconds.
 *   - time left blank             → saved with :01 seconds (impossible to
 *     get from the input itself), meaning "no time chosen".
 * On read, we check the seconds to tell a real (rounded-to-the-minute)
 * midnight apart from "time was never filled in" — without that, a date
 * with no time would round-trip as `00:00` and render as a fake "0h" on the
 * public RSVP page instead of omitting the time entirely.
 */
const NO_TIME_CHOSEN_SECONDS = 1;

function splitIsoToLocalFields(dataHoraIso: string | null): { date: string; time: string } {
  if (dataHoraIso === null) {
    return { date: '', time: '' };
  }

  const date = new Date(dataHoraIso);
  if (Number.isNaN(date.getTime())) {
    return {
      date: DEFAULT_STATE.date,
      time: DEFAULT_STATE.time,
    };
  }

  const noTimeChosen = date.getSeconds() === NO_TIME_CHOSEN_SECONDS;

  return {
    date: [
      date.getFullYear(),
      String(date.getMonth() + 1).padStart(2, '0'),
      String(date.getDate()).padStart(2, '0'),
    ].join('-'),
    time: noTimeChosen
      ? ''
      : [String(date.getHours()).padStart(2, '0'), String(date.getMinutes()).padStart(2, '0')].join(
          ':',
        ),
  };
}

function combineLocalDateAndTime(date: string, time: string): string | null {
  if (!date) return null;
  // See NO_TIME_CHOSEN_SECONDS docstring above — :01 seconds marks "no time
  // chosen" so it can be told apart from a real midnight on read.
  const combined =
    time.trim().length > 0
      ? new Date(`${date}T${time}:00`)
      : new Date(`${date}T00:00:${String(NO_TIME_CHOSEN_SECONDS).padStart(2, '0')}`);
  if (Number.isNaN(combined.getTime())) {
    throw new Error('Data ou hora do convite invalida');
  }
  return combined.toISOString();
}

function normalizeNullableString(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}
