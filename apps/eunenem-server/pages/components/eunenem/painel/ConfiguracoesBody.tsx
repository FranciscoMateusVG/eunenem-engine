import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import type { inferRouterOutputs } from '@trpc/server';
import { resetAnalyticsIdentity } from '@/lib/analytics';
import { useCampanhaEscrita } from '@/lib/campanha-escrita';
import { painelHref, EUNENEM_SUPPORT_WHATSAPP_URL } from '@/lib/painelRoutes';
import { trpc } from '@/lib/trpc';
import type { PainelSectionBodyProps } from '@/PainelSectionPage';
// Deep-leaf type import (zod-only, pg-free) — see useAcessoCampanha.ts.
import type { AcaoCampanha } from '../../../../../../src/domain/arrecadacao/value-objects/permissao-campanha.js';
import type { AppRouter } from '../../../../server/trpc/router.js';
import { useAcessoCampanha } from './useAcessoCampanha';

type ConfiguracoesDTO = inferRouterOutputs<AppRouter>['configuracoes']['get'];
/** Toggles de e-mail expostos por `configuracoes.get` (por usuário). */
export type EmailToggleChave = keyof ConfiguracoesDTO['emails'];

/** Tempo para a pessoa ler a confirmação antes de sair da área logada. */
const REDIRECT_APOS_DESATIVAR_MS = 2500;

export function ConfiguracoesBody({ slug }: PainelSectionBodyProps) {
  const id = useCampanhaEscrita();
  const acesso = useAcessoCampanha(id);
  const utils = trpc.useUtils();
  const idCampanha = id ?? '';
  const config = trpc.configuracoes.get.useQuery({ idCampanha }, { enabled: idCampanha !== '' });
  const [salvando, setSalvando] = useState<Partial<Record<EmailToggleChave | 'exibirRecados', boolean>>>(
    {},
  );

  const emails = trpc.configuracoes.emails.useMutation({
    onSuccess: (emailsSalvos) =>
      utils.configuracoes.get.setData({ idCampanha }, (atual) =>
        atual ? { ...atual, emails: emailsSalvos } : atual,
      ),
    onError: () => toast.error('não consegui salvar a preferência — tenta de novo?'),
    onSettled: (_data, _err, { idCampanha: _id, ...toggles }) =>
      setSalvando((atual) => ({
        ...atual,
        ...Object.fromEntries(Object.keys(toggles).map((chave) => [chave, false])),
      })),
  });
  const privacidade = trpc.configuracoes.privacidade.useMutation({
    onSuccess: ({ exibirRecados }) =>
      utils.configuracoes.get.setData({ idCampanha }, (atual) =>
        atual ? { ...atual, exibirRecados } : atual,
      ),
    onError: (err) => toast.error(err.message || 'não consegui salvar — tenta de novo?'),
    onSettled: () => setSalvando((atual) => ({ ...atual, exibirRecados: false })),
  });
  const desativar = trpc.usuario.desativarConta.useMutation({
    onSuccess: () => {
      resetAnalyticsIdentity();
      window.setTimeout(() => window.location.assign('/'), REDIRECT_APOS_DESATIVAR_MS);
    },
  });

  return (
    <ConfiguracoesView
      slug={slug}
      idCampanha={id}
      pode={acesso.pode}
      config={config.data}
      carregando={config.isLoading || acesso.isLoading}
      erroAoCarregar={Boolean(config.error)}
      onRecarregar={() => void config.refetch()}
      salvando={salvando}
      onEmail={(chave, valor) => {
        setSalvando((atual) => ({ ...atual, [chave]: true }));
        emails.mutate({ idCampanha, [chave]: valor });
      }}
      onExibirRecados={(valor) => {
        setSalvando((atual) => ({ ...atual, exibirRecados: true }));
        privacidade.mutate({ idCampanha, exibirRecados: valor });
      }}
      desativacao={{
        pendente: desativar.isPending,
        erro: desativar.error ? desativar.error.message || 'não consegui desativar a conta.' : null,
        concluida: desativar.isSuccess,
        onConfirmar: () => desativar.mutate(),
      }}
    />
  );
}

export interface ConfiguracoesViewProps {
  slug: string;
  idCampanha: string | undefined;
  pode: (acao: AcaoCampanha) => boolean;
  config: ConfiguracoesDTO | undefined;
  carregando: boolean;
  erroAoCarregar: boolean;
  onRecarregar: () => void;
  salvando: Partial<Record<EmailToggleChave | 'exibirRecados', boolean>>;
  onEmail: (chave: EmailToggleChave, valor: boolean) => void;
  onExibirRecados: (valor: boolean) => void;
  desativacao: Omit<DesativarContaDialogProps, 'onFechar'>;
}

export function ConfiguracoesView(props: ConfiguracoesViewProps) {
  const { slug, idCampanha, pode, config, carregando, salvando } = props;
  const [showDelete, setShowDelete] = useState(false);
  const podeGerenciarMensagens = pode('mensagens:gerenciar');

  /** Props of a per-user e-mail switch; new e-mail types only need a key. */
  const emailToggle = (chave: EmailToggleChave) => ({
    checked: config?.emails[chave] ?? true,
    disabled: !config || carregando || Boolean(salvando[chave]),
    onChange: (valor: boolean) => props.onEmail(chave, valor),
  });

  return (
    <div className="config-body">
      <header>
        <h1>Configurações</h1>
        <p>Cuide dos acessos e das preferências do seu chá.</p>
      </header>
      {props.erroAoCarregar && (
        <section className="config-card" role="alert">
          <p>Não consegui carregar suas preferências.</p>
          <button type="button" className="perfil-btn perfil-btn-ghost" onClick={props.onRecarregar}>
            Tentar de novo
          </button>
        </section>
      )}
      <section className="config-card">
        <h2>Pessoas com acesso</h2>
        <p>Convide alguém para ajudar a administrar seu chá e gerencie quem já tem acesso.</p>
        {pode('membros:gerenciar') ? (
          <a className="perfil-btn perfil-btn-ghost" href={painelHref(slug, 'compartilhar', idCampanha)}>
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
        <SettingToggle
          label="Exibir recados publicamente"
          description="Mostra os recados dos convidados na página do chá. Desligado, eles ficam visíveis só aqui no painel."
          checked={config?.exibirRecados ?? true}
          disabled={!config || carregando || !podeGerenciarMensagens || Boolean(salvando.exibirRecados)}
          onChange={props.onExibirRecados}
        />
        {!carregando && !podeGerenciarMensagens && (
          <small>Somente quem gerencia as mensagens pode alterar esta opção.</small>
        )}
        {pode('mensagens:ver') && (
          <a href={painelHref(slug, 'mensagens', idCampanha)}>Ver mensagens recebidas</a>
        )}
      </section>
      <section className="config-card">
        <h2>Notificações por e-mail</h2>
        <p>Escolha quais avisos você recebe por e-mail. A escolha vale só para você.</p>
        <SettingToggle
          label="Presentes recebidos"
          description="Notificar quando alguém escolher ou enviar um presente."
          {...emailToggle('presentes')}
        />
        <UnavailableToggle
          label="Novos recados"
          description="Notificar quando um convidado enviar uma mensagem."
        />
        <UnavailableToggle
          label="Confirmações de presença"
          description="Notificar quando um convidado confirmar presença."
        />
      </section>
      <section className="config-card config-danger">
        <h2>Excluir conta</h2>
        <p>
          Desative sua conta quando quiser. Nada é apagado; a exclusão definitiva dos dados é
          feita com o atendimento.
        </p>
        <button
          type="button"
          className="perfil-btn perfil-btn-ghost"
          onClick={() => setShowDelete(true)}
        >
          Excluir minha conta
        </button>
      </section>
      {showDelete && (
        <DesativarContaDialog {...props.desativacao} onFechar={() => setShowDelete(false)} />
      )}
    </div>
  );
}

export interface DesativarContaDialogProps {
  pendente: boolean;
  /** Mensagem do servidor (pendência financeira, login antigo…). */
  erro: string | null;
  concluida: boolean;
  onConfirmar: () => void;
  onFechar: () => void;
}

export function DesativarContaDialog({
  pendente,
  erro,
  concluida,
  onConfirmar,
  onFechar,
}: DesativarContaDialogProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [confirm, setConfirm] = useState(false);
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  return (
    <dialog
      ref={dialog}
      className="config-card config-modal"
      aria-labelledby="delete-title"
      onCancel={(e) => {
        if (pendente || concluida) e.preventDefault();
        else onFechar();
      }}
    >
      <h2 id="delete-title">Exclusão da conta</h2>
      {concluida ? (
        <p role="status">Sua conta foi desativada. Redirecionando para a página inicial…</p>
      ) : (
        <>
          <p>
            Sua conta será desativada e você sairá de todos os dispositivos. Nada é apagado:
            campanhas, presentes e histórico financeiro ficam guardados.
          </p>
          <p>
            Campanhas em que você é a única pessoa titular saem do ar. Se houver outra pessoa
            titular, a campanha continua no ar com ela.
          </p>
          <p>
            Não é possível desativar com saldo a sacar ou resgate em andamento. Por segurança,
            pedimos que você tenha entrado há pouco tempo.
          </p>
          <p>
            Para excluir seus dados definitivamente ou reativar a conta, fale com o{' '}
            <a href={EUNENEM_SUPPORT_WHATSAPP_URL}>atendimento</a>.
          </p>
          <label className="config-consent">
            <input
              type="checkbox"
              checked={confirm}
              disabled={pendente}
              onChange={(e) => setConfirm(e.target.checked)}
            />
            Entendo e quero desativar minha conta.
          </label>
          {erro && <p role="alert">{erro}</p>}
          <div className="config-actions">
            <button
              type="button"
              className="perfil-btn perfil-btn-ghost"
              onClick={onFechar}
              disabled={pendente}
            >
              Cancelar
            </button>
            <button
              type="button"
              className="perfil-btn perfil-btn-primary"
              onClick={onConfirmar}
              disabled={!confirm || pendente}
            >
              {pendente ? 'Desativando…' : 'Desativar minha conta'}
            </button>
          </div>
        </>
      )}
    </dialog>
  );
}

function SettingToggle({
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
  onChange: (valor: boolean) => void;
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

function UnavailableToggle({ label, description }: { label: string; description: string }) {
  return (
    <label className="config-toggle">
      <span>
        <strong>{label}</strong>
        <small>{description}</small>
        <small>Indisponível</small>
      </span>
      <input type="checkbox" role="switch" aria-label={label} disabled />
    </label>
  );
}
