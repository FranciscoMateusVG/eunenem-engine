import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { trpc } from '@/lib/trpc';
import { useCampanhaEscrita } from '@/lib/campanha-escrita';
import { painelHref, EUNENEM_SUPPORT_WHATSAPP_URL } from '@/lib/painelRoutes';
import { useSignOut } from '@/lib/auth';
import type { PainelSectionBodyProps } from '@/PainelSectionPage';
import { useAcessoCampanha } from './useAcessoCampanha';

export function ConfiguracoesBody({ slug }: PainelSectionBodyProps) {
  const id = useCampanhaEscrita();
  const acesso = useAcessoCampanha(id);
  const query = trpc.configuracoes.get.useQuery({ idCampanha: id ?? '' }, { enabled: !!id });
  const utils = trpc.useUtils();
  const [error, setError] = useState<string | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const [showDelete, setShowDelete] = useState(false);
  useEffect(() => {
    if (showDelete) dialog.current?.showModal();
  }, [showDelete]);
  const [confirm, setConfirm] = useState(false);
  const [protocol, setProtocol] = useState<string | null>(null);
  const { signOut } = useSignOut();
  type Settings = NonNullable<typeof query.data>;
  const key = { idCampanha: id ?? '' };
  const optimistic = async (patch: Partial<Settings>) => {
    await utils.configuracoes.get.cancel(key);
    const previous = utils.configuracoes.get.getData(key);
    if (previous) utils.configuracoes.get.setData(key, { ...previous, ...patch });
    return previous;
  };
  const refreshed = async () => {
    await query.refetch();
    toast.success('Preferência salva ♡');
    setError(null);
  };
  const failed = (err: { message: string }) => setError(err.message);
  const rollback = (err: { message: string }, previous: Settings | undefined) => {
    if (previous) utils.configuracoes.get.setData(key, previous);
    failed(err);
  };
  const privacy = trpc.configuracoes.privacidade.useMutation({
    onMutate: (input) => optimistic({ exibirRecados: input.exibirRecados }),
    onSuccess: async () => {
      await refreshed();
      void utils.pagina.obterMural.invalidate();
    },
    onError: (err, _input, previous) => rollback(err, previous),
  });
  const emails = trpc.configuracoes.emails.useMutation({
    onMutate: (input) =>
      optimistic({
        ...(input.presentes !== undefined ? { presentes: input.presentes } : {}),
        ...(input.recados !== undefined ? { recados: input.recados } : {}),
        ...(input.presencas !== undefined ? { presencas: input.presencas } : {}),
      }),
    onSuccess: refreshed,
    onError: (err, _input, previous) => rollback(err, previous),
  });
  const deletion = trpc.configuracoes.solicitarExclusao.useMutation({
    onSuccess: (result) => {
      setProtocol(result.protocolo ?? 'em análise');
      setShowDelete(false);
      setError(null);
    },
    onError: failed,
  });
  const busy = privacy.isPending || emails.isPending || query.isFetching;
  const data = query.data;
  const deletionProtocol = protocol ?? data?.solicitacaoExclusao;
  if (query.error)
    return (
      <div className="config-body" role="alert">
        Não consegui carregar suas configurações.{' '}
        <button type="button" onClick={() => void query.refetch()}>
          Tentar novamente
        </button>
      </div>
    );
  if (!data) return <p role="status">Carregando configurações…</p>;
  const updateEmail = (key: 'presentes' | 'recados' | 'presencas', checked: boolean) =>
    emails.mutate({ idCampanha: id ?? '', [key]: checked });
  return (
    <div className="config-body">
      <header>
        <h1>Configurações</h1>
        <p>Cuide dos acessos e das preferências do seu chá.</p>
      </header>
      {error && <p role="alert">{error}</p>}
      {(privacy.isPending || emails.isPending) && <p role="status">Salvando preferência…</p>}
      <section className="config-card">
        <h2>Pessoas com acesso</h2>
        <p>Convide alguém para ajudar a administrar seu chá e gerencie quem já tem acesso.</p>
        {acesso.pode('membros:gerenciar') ? (
          <a className="perfil-btn perfil-btn-ghost" href={painelHref(slug, 'compartilhar', id)}>
            Gerenciar acessos
          </a>
        ) : (
          <p>Somente o titular pode gerenciar acessos.</p>
        )}
        <small>
          O convite padrão não concede acesso financeiro, alteração de titularidade ou resgates.
        </small>
      </section>
      <section className="config-card">
        <h2>Privacidade e mensagens</h2>
        <Toggle
          label="Exibir recados publicamente"
          description="Permita que seus convidados vejam os recados aprovados na página do chá."
          checked={data.exibirRecados}
          disabled={busy || !acesso.pode('mensagens:gerenciar')}
          onChange={(checked) => privacy.mutate({ idCampanha: id ?? '', exibirRecados: checked })}
        />
        {acesso.pode('mensagens:ver') && (
          <a href={painelHref(slug, 'mensagens', id)}>Aprovar ou ocultar recados</a>
        )}
      </section>
      <section className="config-card">
        <h2>Notificações por e-mail</h2>
        <p>Escolha quais atualizações você deseja receber.</p>
        <Toggle
          label="Presentes recebidos"
          description="Notificar quando alguém escolher ou enviar um presente."
          checked={data.presentes}
          disabled={busy}
          onChange={(v) => updateEmail('presentes', v)}
        />
        <Toggle
          label="Novos recados"
          description="Notificar quando um convidado enviar uma mensagem."
          checked={data.recados}
          disabled={busy}
          onChange={(v) => updateEmail('recados', v)}
        />
        <Toggle
          label="Confirmações de presença"
          description="Notificar quando um convidado confirmar presença."
          checked={data.presencas}
          disabled={busy}
          onChange={(v) => updateEmail('presencas', v)}
        />
        <small>
          Preferências da sua conta, em todos os seus chás. E-mails de segurança, acesso e
          comprovantes continuam sendo enviados. As alterações são salvas individualmente.
        </small>
      </section>
      <section className="config-card config-danger">
        <h2>Excluir conta</h2>
        <p>
          Solicite a exclusão da sua conta e dos dados associados, conforme as regras da plataforma.
        </p>
        {deletionProtocol ? (
          <p role="status">
            Solicitação registrada para análise. Protocolo: {deletionProtocol}.{' '}
            <a href={EUNENEM_SUPPORT_WHATSAPP_URL}>Fale com o atendimento</a> para acompanhar.
          </p>
        ) : (
          <button
            type="button"
            className="perfil-btn perfil-btn-ghost"
            onClick={() => {
              setShowDelete(true);
              setConfirm(false);
            }}
          >
            Excluir minha conta
          </button>
        )}
      </section>
      {showDelete && (
        <dialog
          ref={dialog}
          className="config-card config-modal"
          aria-labelledby="delete-title"
          onCancel={() => setShowDelete(false)}
        >
          <h2 id="delete-title">Solicitar exclusão da conta</h2>
          <p>
            Esta ação registra uma solicitação para análise. Nenhum dado ou conta será apagado ou
            desativado agora.
          </p>
          <p>
            Informações de perfil, fotos e preferências poderão ser excluídas após análise.
            Registros de pagamentos, transações, prevenção de fraude, segurança e outros dados
            sujeitos a obrigações legais poderão precisar ser mantidos.
          </p>
          <p>
            Eventos existentes, valores arrecadados, saldos pendentes e resgates precisam ser
            verificados pela equipe. Havendo pendências, o atendimento orientará a regularização
            antes de qualquer exclusão.
          </p>
          <label className="config-consent">
            <input
              type="checkbox"
              checked={confirm}
              onChange={(e) => setConfirm(e.target.checked)}
            />
            Entendo as consequências e solicito a análise de exclusão da minha própria conta.
          </label>
          <div className="config-actions">
            <button
              type="button"
              className="perfil-btn perfil-btn-ghost"
              disabled={deletion.isPending}
              onClick={() => setShowDelete(false)}
            >
              Cancelar
            </button>
            <button
              type="button"
              className="perfil-btn perfil-btn-primary"
              disabled={!confirm || deletion.isPending}
              onClick={() => deletion.mutate({ confirmacao: 'SOLICITAR EXCLUSAO' })}
            >
              {deletion.isPending ? 'Enviando…' : 'Confirmar solicitação'}
            </button>
          </div>
          {error && (
            <div role="alert">
              <p>{error}</p>
              <button
                type="button"
                className="perfil-btn perfil-btn-ghost"
                onClick={async () => {
                  await signOut();
                  window.location.assign('/login');
                }}
              >
                Sair e entrar novamente
              </button>
            </div>
          )}
        </dialog>
      )}
    </div>
  );
}

function Toggle({
  label,
  description,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  description: string;
  checked: boolean;
  disabled: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="config-toggle">
      <span>
        <strong>{label}</strong>
        <small>{description}</small>
      </span>
      <input
        type="checkbox"
        role="switch"
        aria-label={label}
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
    </label>
  );
}
