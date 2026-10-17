import { MembroPermissoesToggles } from './MembroPermissoesToggles';
import { PermissoesEditor, presetDe, ROTULO_PRESET } from './PermissoesEditor';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { trpc } from '@/lib/trpc';
import { useCampanhaEscrita } from '@/lib/campanha-escrita';
// Deep-leaf import (zod-only, pg-free) — see BancariosBody.tsx (aperture-9abwt).
import {
  type AcaoConcedivel,
  PERMISSOES_PADRAO_MEMBRO,
} from '../../../../../../src/domain/arrecadacao/value-objects/permissao-campanha.js';

// aperture-e06nr — calm redesign of the sharing panel: one-line header, a
// compact invite row with a preset picker, and one card per person whose
// permissions and remove/revoke action live behind "Gerenciar". Same tRPC
// calls and payloads as before; only the presentation changed.

export function CompartilharBody() {
  const idCampanha = useCampanhaEscrita();
  const [email, setEmail] = useState('');
  const [notice, setNotice] = useState('');
  // aperture-m3vx4: chosen at invite time; acceptance grants exactly this set.
  const [permissoes, setPermissoes] = useState<AcaoConcedivel[]>([...PERMISSOES_PADRAO_MEMBRO]);
  // Bumped on a successful invite so the preset picker starts fresh.
  const [formKey, setFormKey] = useState(0);
  const [aberto, setAberto] = useState<string | null>(null);
  const utils = trpc.useUtils();
  const query = trpc.campanhaMembros.listar.useQuery(
    { idCampanha: idCampanha ?? '' },
    { enabled: !!idCampanha, retry: false },
  );
  const invites = trpc.compartilhamento.listarConvites.useQuery(
    { idCampanha: idCampanha ?? '' },
    { enabled: !!idCampanha, retry: false },
  );
  const refresh = () => {
    void query.refetch();
    void invites.refetch();
  };
  const invite = trpc.compartilhamento.convidar.useMutation({
    onSuccess: (_data, vars) => {
      setEmail('');
      setPermissoes([...PERMISSOES_PADRAO_MEMBRO]);
      setFormKey((k) => k + 1);
      setNotice(`Convite enviado para ${vars.email}. Ele vale por 7 dias.`);
      refresh();
    },
  });
  const revoke = trpc.compartilhamento.revogar.useMutation({ onSuccess: refresh });
  const editInvite = trpc.compartilhamento.definirPermissoesConvite.useMutation({
    onMutate: async ({ idConvite, permissoes: proximas }) => {
      const key = { idCampanha: idCampanha ?? '' };
      await utils.compartilhamento.listarConvites.cancel(key);
      const anterior = utils.compartilhamento.listarConvites.getData(key);
      utils.compartilhamento.listarConvites.setData(key, (lista) =>
        lista?.map((i) => (i.id === idConvite ? { ...i, permissoes: proximas } : i)),
      );
      return { anterior };
    },
    onError: (error, _vars, context) => {
      if (context?.anterior)
        utils.compartilhamento.listarConvites.setData(
          { idCampanha: idCampanha ?? '' },
          context.anterior,
        );
      toast.error(error.message || 'não consegui salvar a permissão — tente de novo');
    },
    onSettled: () => {
      void invites.refetch();
    },
  });
  const remove = trpc.campanhaMembros.remover.useMutation({ onSuccess: refresh });
  const busy = invite.isPending || revoke.isPending || remove.isPending;

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(''), 8000);
    return () => clearTimeout(timer);
  }, [notice]);

  if (!idCampanha || query.isLoading)
    return (
      <Shell>
        <p role="status" className="cmp-quiet">
          Carregando compartilhamento…
        </p>
      </Shell>
    );
  if (query.error)
    return (
      <Shell>
        <p role="alert" className="cmp-toast err">
          {query.error.data?.code === 'FORBIDDEN' || query.error.data?.code === 'UNAUTHORIZED'
            ? 'Somente o proprietário pode gerenciar o compartilhamento desta campanha.'
            : query.error.message}
        </p>
      </Shell>
    );

  const erro = invite.error || revoke.error || remove.error;
  const pessoas = query.data ?? [];
  const dono = pessoas.find((p) => p.papel === 'owner');
  const membros = pessoas.filter((p) => p.papel !== 'owner');
  const agora = new Date();
  const convites = invites.data ?? [];
  const ativo = (c: (typeof convites)[number]) =>
    !c.revogado_em && !c.consumido_em && new Date(c.expira_em) > agora;
  const pendentes = convites.filter(ativo);
  const anteriores = convites.filter((c) => !ativo(c));
  const alternar = (chave: string) => setAberto((atual) => (atual === chave ? null : chave));

  return (
    <Shell>
      <section className="cmp-card cmp-invite" aria-labelledby="cmp-invite-title">
        <h2 id="cmp-invite-title" className="cmp-h2">
          Convidar alguém
        </h2>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            setNotice('');
            invite.mutate({ idCampanha, email, permissoes });
          }}
        >
          <label className="cmp-label" htmlFor="cmp-email">
            E-mail da pessoa
          </label>
          <div className="cmp-invite-row">
            <input
              id="cmp-email"
              className="cmp-input"
              type="email"
              required
              maxLength={254}
              placeholder="nome@email.com"
              autoComplete="off"
              aria-describedby="cmp-email-hint"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
            <button className="cmp-btn-primary" disabled={busy} type="submit">
              Convidar
            </button>
          </div>
          <p id="cmp-email-hint" className="cmp-hint">
            A pessoa entra com este e-mail, pelo Google ou por link de acesso.
          </p>
          <PermissoesEditor
            key={formKey}
            testId="convite-permissoes-novo"
            resumoTestId="convite-permissoes-resumo"
            legenda="O que ela poderá fazer"
            permissoes={permissoes}
            disabled={invite.isPending}
            onChange={setPermissoes}
          />
        </form>
        {notice && (
          <p role="status" className="cmp-toast ok">
            <span className="cmp-toast-ico" aria-hidden="true">
              <ICheck />
            </span>
            {notice}
          </p>
        )}
        {erro && (
          <div role="alert" className="cmp-toast err">
            <span>{erro.message}</span>
            <button
              type="button"
              className="cmp-toast-close"
              aria-label="Fechar aviso"
              onClick={() => {
                invite.reset();
                revoke.reset();
                remove.reset();
              }}
            >
              ×
            </button>
          </div>
        )}
      </section>

      <section aria-labelledby="cmp-people-title">
        <h2 id="cmp-people-title" className="cmp-h2 cmp-people-title">
          Quem tem acesso
          <span className="cmp-count">{pessoas.length + pendentes.length}</span>
        </h2>
        {invites.error && (
          <p role="alert" className="cmp-toast err">
            {invites.error.message}
          </p>
        )}
        <ul className="cmp-people">
          {dono && (
            <PessoaCard
              nome={dono.nomeExibicao ?? 'Você'}
              email={dono.email}
              chip={<span className="cmp-chip dono">Dono</span>}
              detalhe="Pode tudo"
            />
          )}
          {membros.map((member) => {
            const nome = member.nomeExibicao ?? member.email ?? 'Pessoa';
            const chave = `m-${member.idConta}`;
            return (
              <PessoaCard
                key={member.idConta}
                nome={nome}
                email={member.nomeExibicao ? member.email : null}
                chip={<span className="cmp-chip membro">Membro</span>}
                detalhe={ROTULO_PRESET[presetDe(member.permissoes)]}
                painel={{
                  id: chave,
                  aberto: aberto === chave,
                  alternar: () => alternar(chave),
                  conteudo: (
                    <>
                      <MembroPermissoesToggles idCampanha={idCampanha} idConta={member.idConta} />
                      <AcaoDiscreta
                        rotulo="Remover acesso"
                        pergunta={`Remover o acesso de ${nome}?`}
                        confirmar="Sim, remover"
                        disabled={busy}
                        onConfirm={() => remove.mutate({ idCampanha, idConta: member.idConta })}
                      />
                    </>
                  ),
                }}
              />
            );
          })}
          {pendentes.map((invitation) => {
            const chave = `c-${invitation.id}`;
            const ate = new Date(invitation.expira_em).toLocaleDateString('pt-BR', {
              day: '2-digit',
              month: '2-digit',
            });
            return (
              <PessoaCard
                key={invitation.id}
                nome={invitation.email}
                pendente
                chip={<span className="cmp-chip pendente">Pendente até {ate}</span>}
                detalhe={ROTULO_PRESET[presetDe(invitation.permissoes as AcaoConcedivel[])]}
                painel={{
                  id: chave,
                  aberto: aberto === chave,
                  alternar: () => alternar(chave),
                  conteudo: (
                    <>
                      <PermissoesEditor
                        testId={`convite-permissoes-${invitation.id}`}
                        legenda="O que ela poderá fazer ao aceitar"
                        permissoes={invitation.permissoes as AcaoConcedivel[]}
                        disabled={editInvite.isPending}
                        onChange={(proximas) =>
                          editInvite.mutate({
                            idCampanha,
                            idConvite: invitation.id,
                            permissoes: proximas,
                          })
                        }
                      />
                      <AcaoDiscreta
                        rotulo="Revogar convite"
                        pergunta="Revogar este convite? O link deixa de funcionar."
                        confirmar="Sim, revogar"
                        disabled={busy}
                        onConfirm={() => revoke.mutate({ idCampanha, idConvite: invitation.id })}
                      />
                    </>
                  ),
                }}
              />
            );
          })}
        </ul>
        {membros.length === 0 && pendentes.length === 0 && (
          <p className="cmp-empty">Por enquanto só você. Convide alguém para dividir as tarefas.</p>
        )}
        {anteriores.length > 0 && (
          <details className="cmp-history">
            <summary>Convites anteriores ({anteriores.length})</summary>
            <ul>
              {anteriores.map((invitation) => (
                <li key={invitation.id}>
                  <span className="cmp-history-email">{invitation.email}</span>
                  <span className="cmp-history-status">
                    {invitation.consumido_em
                      ? 'Aceito'
                      : invitation.revogado_em
                        ? 'Revogado'
                        : 'Expirado'}
                  </span>
                </li>
              ))}
            </ul>
          </details>
        )}
      </section>
    </Shell>
  );
}

function Shell({ children }: { children: ReactNode }) {
  return (
    <div className="cmp">
      <style>{CMP_CSS}</style>
      <header className="cmp-head">
        <h1>
          <span className="hl">Compartilhar</span>
        </h1>
        <p className="cmp-lede">Convide quem vai te ajudar a cuidar da lista.</p>
        <p className="cmp-note">
          <IShield />
          Você continua dono da lista e do dinheiro. Só você pode convidar outras pessoas.
        </p>
      </header>
      {children}
    </div>
  );
}

const TONS = ['lilac', 'pink', 'blue', 'yellow', 'green'] as const;

function iniciais(nome: string) {
  const base = nome.includes('@') ? (nome.split('@')[0] ?? '').replace(/[._-]+/g, ' ') : nome;
  const partes = base.trim().split(/\s+/).filter(Boolean);
  const primeira = partes[0] ?? '?';
  const ultima = partes[partes.length - 1] ?? '';
  const letras = partes.length > 1 ? `${primeira[0] ?? ''}${ultima[0] ?? ''}` : primeira.slice(0, 2);
  return letras.toUpperCase();
}

function tom(nome: string) {
  let soma = 0;
  for (const ch of nome) soma = (soma * 31 + ch.charCodeAt(0)) >>> 0;
  return TONS[soma % TONS.length];
}

function PessoaCard({
  nome,
  email,
  chip,
  detalhe,
  pendente,
  painel,
}: {
  nome: string;
  email?: string | null;
  chip: ReactNode;
  detalhe: string;
  pendente?: boolean;
  painel?: { id: string; aberto: boolean; alternar: () => void; conteudo: ReactNode };
}) {
  const painelId = painel ? `cmp-painel-${painel.id}` : undefined;
  return (
    <li className={`cmp-person${painel?.aberto ? ' open' : ''}`}>
      <div className="cmp-person-row">
        <span
          className={`cmp-avatar ${pendente ? 'pendente' : tom(nome)}`}
          aria-hidden="true"
        >
          {iniciais(nome)}
        </span>
        <div className="cmp-person-id">
          <p className="cmp-person-name">{nome}</p>
          {email && <p className="cmp-person-email">{email}</p>}
          <p className="cmp-person-meta">
            {chip}
            <span className="cmp-person-preset">{detalhe}</span>
          </p>
        </div>
        {painel && (
          <button
            type="button"
            className="cmp-manage"
            aria-expanded={painel.aberto}
            aria-controls={painelId}
            aria-label={`Gerenciar acesso de ${nome}`}
            onClick={painel.alternar}
          >
            Gerenciar
            <IChevron />
          </button>
        )}
      </div>
      {painel?.aberto && (
        <div id={painelId} className="cmp-person-panel">
          {painel.conteudo}
        </div>
      )}
    </li>
  );
}

/** Quiet destructive action with an inline "are you sure?" step. */
function AcaoDiscreta({
  rotulo,
  pergunta,
  confirmar,
  disabled,
  onConfirm,
}: {
  rotulo: string;
  pergunta: string;
  confirmar: string;
  disabled: boolean;
  onConfirm: () => void;
}) {
  const [confirmando, setConfirmando] = useState(false);
  const cancelar = useRef<HTMLButtonElement>(null);
  const gatilho = useRef<HTMLButtonElement>(null);
  const primeiro = useRef(true);
  useEffect(() => {
    if (primeiro.current) {
      primeiro.current = false;
      return;
    }
    (confirmando ? cancelar : gatilho).current?.focus();
  }, [confirmando]);
  if (!confirmando)
    return (
      <div className="cmp-danger">
        <button
          ref={gatilho}
          type="button"
          className="cmp-link-danger"
          disabled={disabled}
          onClick={() => setConfirmando(true)}
        >
          {rotulo}
        </button>
      </div>
    );
  return (
    <div className="cmp-danger confirm" role="group" aria-label={rotulo}>
      <span>{pergunta}</span>
      <div className="cmp-danger-btns">
        <button type="button" className="cmp-btn-danger" disabled={disabled} onClick={onConfirm}>
          {confirmar}
        </button>
        <button
          ref={cancelar}
          type="button"
          className="cmp-btn-quiet"
          onClick={() => setConfirmando(false)}
        >
          Cancelar
        </button>
      </div>
    </div>
  );
}

function ICheck() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M5 12.5l4.5 4.5L19 7.5" />
    </svg>
  );
}
function IShield() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 3l7 3v5c0 4.5-3 8.2-7 10-4-1.8-7-5.5-7-10V6l7-3z" />
      <path d="M9 12l2 2 4-4" />
    </svg>
  );
}
function IChevron() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}

const CMP_CSS = `
.cmp{--cmp-cta:#8a5aa3;--cmp-quiet:#83549c;--cmp-danger:#b0466a;max-width:640px;margin:0 auto;padding:24px 16px 0;display:flex;flex-direction:column;gap:20px}
.cmp *{box-sizing:border-box}
.cmp p{margin:0}

.cmp-head{display:flex;flex-direction:column;gap:6px;padding:0 2px}
.cmp-head h1{font-family:var(--font-patrick-hand),cursive;color:var(--plum);font-size:38px;line-height:1.05;font-weight:600;margin:0}
.cmp-head h1 .hl{padding:0 8px}
.cmp-lede{font-size:16px;color:var(--ink);line-height:1.45}
.cmp-note{display:flex;align-items:flex-start;gap:8px;margin-top:4px;font-size:13px;line-height:1.45;color:var(--ink-soft)}
.cmp-note svg{flex-shrink:0;margin-top:1px;color:var(--green-deep)}
.cmp-quiet{color:var(--ink-soft);font-size:14px}

.cmp-card{background:var(--paper);border:1px solid var(--line);border-radius:24px;box-shadow:var(--shadow-sm);padding:20px 18px}
.cmp-h2{font-family:var(--font-patrick-hand),cursive;color:var(--plum);font-size:24px;line-height:1.1;font-weight:600;margin:0 0 14px}
.cmp-invite form{display:flex;flex-direction:column}
.cmp-label{font-size:13px;font-weight:600;color:var(--ink-soft);margin-bottom:6px}
.cmp-invite-row{display:flex;gap:8px}
.cmp-input{flex:1;min-width:0;height:48px;padding:0 16px;background:#fff;border:1.5px solid var(--line);border-radius:14px;color:var(--ink);font-family:var(--font-dm-sans),sans-serif;font-size:15px;font-weight:500;outline:none;transition:border-color .18s,box-shadow .18s}
.cmp-input::placeholder{color:var(--ink-mute);font-weight:400}
.cmp-input:hover{border-color:#e2c8d4}
.cmp-input:focus{border-color:var(--lilac-deep);box-shadow:0 0 0 4px rgba(167,123,190,.18)}
.cmp-hint{font-size:12.5px;color:var(--ink-soft);margin-top:8px}
.cmp-btn-primary{flex-shrink:0;height:48px;padding:0 22px;border:0;border-radius:999px;background:var(--cmp-cta);color:#fff;font-family:var(--font-dm-sans),sans-serif;font-size:14px;font-weight:700;cursor:pointer;box-shadow:0 8px 20px rgba(138,90,163,.28);transition:background .18s,transform .18s}
.cmp-btn-primary:hover:not(:disabled){background:var(--plum)}
.cmp-btn-primary:active:not(:disabled){transform:scale(.98)}
.cmp-btn-primary:disabled{background:var(--cream-2);color:var(--ink-soft);box-shadow:none;cursor:not-allowed}
.cmp button:focus-visible,.cmp summary:focus-visible{outline:3px solid var(--lilac);outline-offset:2px}

.cmp-perm{border:0;margin:20px 0 0;padding:0;min-width:0}
.cmp-perm-legend{padding:0;margin-bottom:8px;font-size:13px;font-weight:600;color:var(--ink-soft)}
.cmp-seg{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:4px;padding:4px;background:var(--cream-2);border-radius:999px}
.cmp-seg-opt{position:relative;display:flex;align-items:center;justify-content:center;min-height:40px;padding:0 8px;border-radius:999px;font-size:13.5px;font-weight:600;color:var(--ink-soft);text-align:center;line-height:1.15;cursor:pointer;transition:background .18s,color .18s,box-shadow .18s}
.cmp-seg-opt input{position:absolute;inset:0;width:100%;height:100%;margin:0;opacity:0;cursor:pointer}
.cmp-seg-opt:hover{color:var(--plum)}
.cmp-seg-opt.on{background:var(--paper);color:var(--plum);box-shadow:var(--shadow-sm)}
.cmp-seg-opt:has(input:focus-visible){outline:3px solid var(--lilac);outline-offset:1px}
.cmp-perm:disabled .cmp-seg-opt{cursor:progress}
.cmp-perm-resumo{margin-top:10px;font-size:13.5px;line-height:1.45;color:var(--ink-soft)}
.cmp-perm-grupos{display:flex;flex-direction:column;gap:14px;margin-top:14px}
.cmp-perm-grupo{border:1px solid var(--line);border-radius:18px;padding:12px 14px 4px}
.cmp-perm-grupo.financeiro{border-color:#f3d3de;background:linear-gradient(180deg,#fff9fb,#fff)}
.cmp-perm-grupo-titulo{display:flex;align-items:center;gap:8px;font-family:var(--font-patrick-hand),cursive;font-size:19px;color:var(--plum);margin-bottom:2px}
.cmp-perm-grupo-titulo span{font-family:var(--font-dm-sans),sans-serif;font-size:11.5px;font-weight:600;color:var(--cmp-danger);background:var(--pink-soft);border-radius:999px;padding:2px 8px}
.cmp-switch-row{display:grid;grid-template-columns:28px 1fr auto;align-items:center;gap:10px;min-height:48px;padding:6px 0;border-top:1px solid var(--line);cursor:pointer}
.cmp-perm-grupo-titulo + .cmp-switch-row{border-top:0}
.cmp-switch-ico{width:28px;height:28px;border-radius:9px;display:inline-flex;align-items:center;justify-content:center;background:var(--lilac-soft);color:var(--cmp-quiet)}
.financeiro .cmp-switch-ico{background:var(--pink-soft);color:var(--cmp-danger)}
.cmp-switch-txt{font-size:14px;line-height:1.3;color:var(--ink)}
.cmp-switch{appearance:none;-webkit-appearance:none;position:relative;width:42px;height:26px;margin:0;border-radius:999px;background:#e6d9e1;cursor:pointer;transition:background .18s;flex-shrink:0}
.cmp-switch::before{content:"";position:absolute;top:3px;left:3px;width:20px;height:20px;border-radius:50%;background:#fff;box-shadow:0 1px 3px rgba(107,60,94,.25);transition:transform .18s}
.cmp-switch:checked{background:var(--cmp-cta)}
.cmp-switch:checked::before{transform:translateX(16px)}
.cmp-switch:focus-visible{outline:3px solid var(--lilac);outline-offset:2px}
.cmp-switch:disabled{opacity:.55;cursor:progress}

.cmp-toast{display:flex;align-items:center;gap:10px;margin-top:14px;padding:12px 14px;border-radius:16px;font-size:13.5px;line-height:1.4;animation:cmp-in .25s ease-out}
.cmp-toast.ok{background:#f1f7e3;border:1px solid #d9e8b0;color:#4f6a1a}
.cmp-toast.err{background:var(--pink-soft);border:1px solid #f0c6d2;color:#823753;justify-content:space-between}
.cmp-toast-ico{flex-shrink:0;width:24px;height:24px;border-radius:50%;background:var(--green-deep);color:#fff;display:inline-flex;align-items:center;justify-content:center}
.cmp-toast-close{border:0;background:transparent;color:inherit;font-size:20px;line-height:1;width:32px;height:32px;border-radius:10px;cursor:pointer;flex-shrink:0}
.cmp-toast-close:hover{background:rgba(255,255,255,.6)}
@keyframes cmp-in{from{opacity:0;transform:translateY(-4px)}to{opacity:1;transform:none}}

.cmp-people-title{display:flex;align-items:center;gap:10px;padding:0 2px}
.cmp-count{font-family:var(--font-dm-sans),sans-serif;font-size:12px;font-weight:700;color:var(--cmp-quiet);background:var(--lilac-soft);border-radius:999px;min-width:24px;height:24px;padding:0 8px;display:inline-flex;align-items:center;justify-content:center}
.cmp-people{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:10px}
.cmp-person{background:var(--paper);border:1px solid var(--line);border-radius:20px;box-shadow:var(--shadow-sm);transition:box-shadow .2s}
.cmp-person.open{box-shadow:var(--shadow-md)}
.cmp-person-row{display:flex;align-items:center;gap:12px;padding:14px 14px 14px 16px}
.cmp-avatar{flex-shrink:0;width:46px;height:46px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;font-family:var(--font-patrick-hand),cursive;font-size:19px;color:var(--plum);border:3px solid #fff;box-shadow:0 3px 10px rgba(107,60,94,.14)}
.cmp-avatar.lilac{background:var(--lilac-soft);transform:rotate(-4deg)}
.cmp-avatar.pink{background:var(--pink-soft);transform:rotate(3deg)}
.cmp-avatar.blue{background:var(--blue-soft);transform:rotate(-2deg)}
.cmp-avatar.yellow{background:var(--yellow-soft);transform:rotate(4deg)}
.cmp-avatar.green{background:#eaf2cc;transform:rotate(-3deg)}
.cmp-avatar.pendente{background:var(--cream);border:2px dashed var(--lilac);box-shadow:none;color:var(--cmp-quiet)}
.cmp-person-id{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}
.cmp-person-name{font-size:15px;font-weight:600;line-height:1.3;color:var(--ink);overflow-wrap:anywhere}
.cmp-person-email{font-size:13px;line-height:1.35;color:var(--ink-soft);overflow-wrap:anywhere}
.cmp-person-meta{display:flex;flex-wrap:wrap;align-items:center;gap:6px 8px;margin-top:4px}
.cmp-chip{display:inline-flex;align-items:center;height:22px;padding:0 9px;border-radius:999px;font-size:12px;font-weight:600}
.cmp-chip.dono{background:var(--lilac-soft);color:var(--plum)}
.cmp-chip.membro{background:var(--blue-soft);color:#2f6b71}
.cmp-chip.pendente{background:var(--yellow-soft);color:#7a5a12}
.cmp-person-preset{font-size:12.5px;color:var(--ink-soft)}
.cmp-manage{flex-shrink:0;display:inline-flex;align-items:center;gap:4px;min-height:44px;padding:0 12px;border:1.5px solid var(--line);border-radius:999px;background:#fff;color:var(--cmp-quiet);font-family:var(--font-dm-sans),sans-serif;font-size:13px;font-weight:600;cursor:pointer;transition:background .18s,border-color .18s}
.cmp-manage:hover{background:var(--lilac-soft);border-color:var(--lilac-soft)}
.cmp-manage svg{transition:transform .2s}
.cmp-manage[aria-expanded="true"]{background:var(--lilac-soft);border-color:var(--lilac-soft)}
.cmp-manage[aria-expanded="true"] svg{transform:rotate(180deg)}
.cmp-person-panel{padding:0 16px 16px;border-top:1px dashed var(--line);animation:cmp-in .2s ease-out}
.cmp-person-panel .cmp-perm{margin-top:16px}

.cmp-danger{margin-top:14px;padding-top:4px;border-top:1px solid var(--line);display:flex;justify-content:flex-end}
.cmp-danger.confirm{flex-direction:column;align-items:stretch;gap:10px;font-size:14px;color:var(--ink)}
.cmp-danger-btns{display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap}
.cmp-link-danger{border:0;background:transparent;min-height:44px;padding:0 6px;color:var(--cmp-danger);font-family:var(--font-dm-sans),sans-serif;font-size:13.5px;font-weight:600;cursor:pointer;text-decoration:underline;text-decoration-thickness:1px;text-underline-offset:3px;border-radius:10px}
.cmp-link-danger:hover:not(:disabled){background:var(--pink-soft)}
.cmp-btn-danger,.cmp-btn-quiet{min-height:44px;padding:0 18px;border-radius:999px;font-family:var(--font-dm-sans),sans-serif;font-size:13.5px;font-weight:700;cursor:pointer}
.cmp-btn-danger{border:0;background:var(--cmp-danger);color:#fff}
.cmp-btn-danger:hover:not(:disabled){background:#8f3253}
.cmp-btn-quiet{border:1.5px solid var(--line);background:#fff;color:var(--ink-soft)}
.cmp-btn-quiet:hover{background:var(--cream-2)}
.cmp button:disabled{cursor:not-allowed;opacity:.6}

.cmp-empty{margin-top:10px;padding:16px;border:1.5px dashed var(--line);border-radius:18px;text-align:center;font-size:14px;color:var(--ink-soft)}
.cmp-history{margin-top:14px;padding:0 2px}
.cmp-history summary{display:inline-flex;align-items:center;min-height:44px;font-size:13.5px;font-weight:600;color:var(--cmp-quiet);cursor:pointer;border-radius:10px}
.cmp-history ul{list-style:none;margin:4px 0 0;padding:0}
.cmp-history li{display:flex;justify-content:space-between;gap:12px;padding:10px 4px;border-top:1px solid var(--line);font-size:13.5px;color:var(--ink-soft)}
.cmp-history-email{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cmp-history-status{flex-shrink:0;font-weight:600}

@media (max-width:519px){
  .cmp-person-row{align-items:flex-start}
  .cmp-manage{padding:0 10px;font-size:12.5px}
}
@media (max-width:379px){
  .cmp-invite-row{flex-direction:column}
  .cmp-person-row{flex-wrap:wrap}
  .cmp-manage{margin-left:58px}
}
@media (min-width:900px){
  .cmp{padding-top:40px;gap:24px}
  .cmp-head h1{font-size:48px}
  .cmp-card{padding:26px 28px;border-radius:28px}
  .cmp-person-row{padding:16px 18px}
  .cmp-person-panel{padding:0 20px 20px}
}
@media (prefers-reduced-motion:reduce){
  .cmp *,.cmp *::before{animation:none!important;transition:none!important}
}
`;
