import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { PhotoSlot, type FotoSlot, type FotoContentType } from '../PhotoSlot';
import { PRIMARY_SWATCHES, ACCENT_SWATCHES, TWEAKS_DEFAULTS } from '@/lib/mocks/tweaksDefaults';
import { normalizeHex } from '@/lib/palette';
import { trpc } from '@/lib/trpc';
import { useCampanhaEscrita } from '@/lib/campanha-escrita';
import { useCampanhaPublicOwnerSlugRota } from '@/lib/campanhas';
import { paginaSharePath } from '@/lib/painelRoutes';
import { ComPermissao } from './ComPermissao';

const slots = ['perfil', 'capa', 'historia'] as const;
const fields = {
  perfil: ['fotoPerfilKey', 'fotoPerfilUrl'],
  capa: ['fotoCapaKey', 'fotoCapaUrl'],
  historia: ['fotoHistoriaKey', 'fotoHistoriaUrl'],
} as const;
type PhotoDraft = Partial<Record<FotoSlot, { key: string | null; url: string | null }>>;

export function PersonalizarBody() {
  const id = useCampanhaEscrita();
  return (
    <ComPermissao acao="perfil:editar" titulo="Personalizar página">
      {id ? <Editor key={id} idCampanha={id} /> : <p role="status">Carregando sua campanha…</p>}
    </ComPermissao>
  );
}

function Editor({ idCampanha }: { idCampanha: string }) {
  const query = trpc.perfilCampanha.get.useQuery({ idCampanha });
  const ownerSlug = useCampanhaPublicOwnerSlugRota();
  const utils = trpc.useUtils();
  const mutation = trpc.perfilCampanha.atualizar.useMutation();
  const presign = trpc.perfilCampanha.emitirUrlUploadFoto.useMutation();
  const [photos, setPhotos] = useState<PhotoDraft>({});
  const [primary, setPrimary] = useState<string | undefined>();
  const [accent, setAccent] = useState<string | undefined>();
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [mobile, setMobile] = useState(false);
  const frame = useRef<HTMLIFrameElement>(null);
  const data = query.data;
  const primaryValue = primary ?? data?.corPrimaria ?? TWEAKS_DEFAULTS.primary;
  const accentValue = accent ?? data?.corAcento ?? TWEAKS_DEFAULTS.accent;
  const dirty = Object.keys(photos).length > 0 || primary !== undefined || accent !== undefined;
  const busy = uploading > 0 || saving;
  const draft = {
    corPrimaria: normalizeHex(primaryValue),
    corAcento: normalizeHex(accentValue),
    fotoPerfilUrl: photos.perfil ? photos.perfil.url : (data?.fotoPerfilUrl ?? null),
    fotoCapaUrl: photos.capa ? photos.capa.url : (data?.fotoCapaUrl ?? null),
    fotoHistoriaUrl: photos.historia ? photos.historia.url : (data?.fotoHistoriaUrl ?? null),
  };
  // Send only to our own public page. A ready handshake avoids racing hydration.
  const latestDraft = useRef(draft);
  latestDraft.current = draft;
  const sendPreview = () =>
    frame.current?.contentWindow?.postMessage(
      { type: 'eunenem-preview', draft: latestDraft.current },
      window.location.origin,
    );
  useEffect(() => {
    sendPreview();
  }, [primaryValue, accentValue, photos, data]);
  useEffect(() => {
    const ready = (event: MessageEvent) => {
      if (
        event.origin === window.location.origin &&
        event.source === frame.current?.contentWindow &&
        event.data?.type === 'eunenem-preview-ready'
      )
        sendPreview();
    };
    window.addEventListener('message', ready);
    return () => window.removeEventListener('message', ready);
  }, []);
  useEffect(() => {
    if (!dirty && !uploading) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty, uploading]);

  const upload = async (slot: FotoSlot, blob: Blob, contentType: FotoContentType) => {
    setUploading((n) => n + 1);
    try {
      const result = await presign.mutateAsync({ idCampanha, slot, contentType });
      const response = await fetch(result.uploadUrl, {
        method: 'PUT',
        headers: { 'Content-Type': contentType },
        body: blob,
      });
      if (!response.ok) throw new Error('Não consegui enviar a foto. Tente novamente.');
      setPhotos((previous) => ({
        ...previous,
        [slot]: { key: result.objectKey, url: result.publicUrl },
      }));
    } finally {
      setUploading((n) => n - 1);
    }
  };
  const cancel = () => {
    setPhotos({});
    setPrimary(undefined);
    setAccent(undefined);
    setError(null);
  };
  const save = async () => {
    if (busy) return;
    if (!normalizeHex(primaryValue) || !normalizeHex(accentValue)) {
      setError('Informe cores válidas, como #C9A5D8.');
      return;
    }
    setError(null);
    setSaving(true);
    try {
      // The existing API replaces the full content. Re-read and preserve every
      // field this screen does not edit, including untouched photo keys/colors.
      const current = await utils.perfilCampanha.get.fetch({ idCampanha }, { staleTime: 0 });
      const fresh = await mutation.mutateAsync({
        idCampanha,
        nomeBebe: current.nomeBebe,
        relacao: current.relacao,
        historia: current.historia,
        papais: current.papais,
        genero: current.genero,
        tipoEvento: current.tipoEvento,
        dataEvento: current.dataEvento ? new Date(current.dataEvento) : null,
        dataNascimento: current.dataNascimento ? new Date(current.dataNascimento) : null,
        fotoPerfilKey: photos.perfil ? photos.perfil.key : current.fotoPerfilKey,
        fotoCapaKey: photos.capa ? photos.capa.key : current.fotoCapaKey,
        fotoHistoriaKey: photos.historia ? photos.historia.key : current.fotoHistoriaKey,
        corPrimaria: primary === undefined ? current.corPrimaria : normalizeHex(primary),
        corAcento: accent === undefined ? current.corAcento : normalizeHex(accent),
      });
      utils.perfilCampanha.get.setData({ idCampanha }, fresh);
      void utils.perfil.getPerfil.invalidate();
      void utils.perfil.getPerfilPublicoBySlug.invalidate();
      cancel();
      toast.success('Alterações salvas! Feito com carinho ♡');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Não consegui salvar. Tente novamente.');
    } finally {
      setSaving(false);
    }
  };
  if (query.isLoading) return <p role="status">Carregando sua personalização…</p>;
  if (query.error || !data)
    return (
      <div role="alert">
        Não consegui carregar sua página.{' '}
        <button type="button" onClick={() => void query.refetch()}>
          Tentar novamente
        </button>
      </div>
    );
  return (
    <div className="perfil-body personalizar-body">
      <div className="perfil-hero">
        <h1 className="perfil-hero-title">
          Personalizar <span className="hl">página</span>
        </h1>
        <p>Deixe tudo do seu jeitinho ♡</p>
      </div>
      <fieldset disabled={busy} style={{ border: 0, padding: 0, minWidth: 0 }}>
        <section className="perfil-card personalizar-section">
          <h2>Fotos da página</h2>
          <p>As fotos e cores só aparecem para seus convidados depois de salvar.</p>
          <div className="perfil-fotos-grid">
            {slots.map((slot) => (
              <div key={slot}>
                <PhotoSlot
                  disabled={busy}
                  slot={slot}
                  displayUrl={photos[slot] ? photos[slot].url : data[fields[slot][1]]}
                  onUpload={upload}
                />
                <button
                  type="button"
                  className="perfil-btn perfil-btn-ghost"
                  disabled={!(photos[slot] ? photos[slot].url : data[fields[slot][1]])}
                  onClick={() =>
                    setPhotos((previous) => ({ ...previous, [slot]: { key: null, url: null } }))
                  }
                >
                  Remover foto
                </button>
              </div>
            ))}
          </div>
        </section>
        <section className="perfil-card personalizar-section">
          <h2>Cores da página</h2>
          <ColorField
            label="Cor principal"
            value={primaryValue}
            swatches={PRIMARY_SWATCHES}
            onChange={setPrimary}
          />
          <ColorField
            label="Cor de destaque"
            value={accentValue}
            swatches={ACCENT_SWATCHES}
            onChange={setAccent}
          />
        </section>
      </fieldset>
      <section className="perfil-card personalizar-section">
        <h2>Prévia da página</h2>
        <p>Esta é a sua página real. Role para conferir como ela ficará.</p>
        <div className="personalizar-devices" role="group" aria-label="Tamanho da prévia">
          <button
            type="button"
            className="perfil-btn perfil-btn-ghost"
            aria-pressed={!mobile}
            onClick={() => setMobile(false)}
          >
            Desktop
          </button>
          <button
            type="button"
            className="perfil-btn perfil-btn-ghost"
            aria-pressed={mobile}
            onClick={() => setMobile(true)}
          >
            Mobile
          </button>
        </div>
        <div className="personalizar-preview-scroll">
          {ownerSlug ? (
            <iframe
              ref={frame}
              title="Prévia real da página"
              src={`${paginaSharePath(ownerSlug, idCampanha)}?personalizar-preview=1`}
              style={{ width: mobile ? 390 : 1100 }}
            />
          ) : (
            <p role="status">Carregando prévia…</p>
          )}
        </div>
      </section>
      {error && <p role="alert">{error}</p>}
      <p role="status" aria-live="polite">
        {uploading
          ? 'Enviando foto…'
          : dirty
            ? 'Você tem alterações não salvas.'
            : 'Sua página está atualizada.'}
      </p>
      <div className="perfil-actions">
        <button
          type="button"
          className="perfil-btn perfil-btn-ghost"
          disabled={busy || !dirty}
          onClick={cancel}
        >
          Cancelar
        </button>
        <button
          type="button"
          className="perfil-btn perfil-btn-primary"
          disabled={busy || !dirty}
          onClick={() => void save()}
        >
          {saving ? 'Salvando…' : 'Salvar alterações'}
        </button>
      </div>
    </div>
  );
}

function ColorField({
  label,
  value,
  swatches,
  onChange,
}: {
  label: string;
  value: string;
  swatches: string[];
  onChange: (value: string) => void;
}) {
  return (
    <div className="personalizar-color">
      <label>
        {label}
        <input
          aria-label={label}
          className="perfil-input"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          maxLength={7}
        />
      </label>
      <input
        type="color"
        aria-label={`Selecionar ${label.toLowerCase()}`}
        value={normalizeHex(value) ?? '#000000'}
        onChange={(event) => onChange(event.target.value)}
      />
      {swatches.map((color) => (
        <button
          key={color}
          type="button"
          aria-label={`${label} ${color}`}
          aria-pressed={normalizeHex(value) === normalizeHex(color)}
          onClick={() => onChange(color)}
          style={{
            background: color,
            width: 44,
            height: 44,
            borderRadius: '50%',
            border:
              normalizeHex(value) === normalizeHex(color)
                ? '3px solid var(--ink)'
                : '1px solid var(--line)',
          }}
        />
      ))}
    </div>
  );
}
