import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import type { inferRouterOutputs } from '@trpc/server';
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
  const agradecimento = trpc.configuracoes.mensagemAgradecimento.useMutation({
    onSuccess: ({ mensagemAgradecimento }) => {
      utils.configuracoes.get.setData({ idCampanha }, (atual) =>
        atual ? { ...atual, mensagemAgradecimento } : atual,
      );
      toast.success('mensagem de agradecimento salva ♡');
    },
    onError: (err) => toast.error(err.message || 'não consegui salvar — tenta de novo?'),
  });
  const excluirLista = trpc.configuracoes.excluirLista.useMutation({
    onSuccess: () => window.location.replace('/campanhas'),
  });

  return (
    <ConfiguracoesView
      key={id}
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
      agradecimento={{
        salvando: agradecimento.isPending,
        onSalvar: (mensagem) => agradecimento.mutate({ idCampanha, mensagem }),
      }}
      exclusao={{
        permitida: acesso.papel === 'owner',
        pendente: excluirLista.isPending || excluirLista.isSuccess,
        erro:
          excluirLista.error?.data?.code === 'INTERNAL_SERVER_ERROR'
            ? 'Não consegui excluir a lista. Tente de novo.'
            : excluirLista.error?.message ?? null,
        onConfirmar: () => excluirLista.mutate({ idCampanha }),
        onFechar: excluirLista.reset,
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
  exclusao: Omit<ExcluirListaDialogProps, 'tituloLista'> & { permitida: boolean };
  /** aperture-bqvb5 — mensagem padrão de agradecimento (null = volta à sugerida). */
  agradecimento: { salvando: boolean; onSalvar: (mensagem: string | null) => void };
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
      {config && (
        <MensagemAgradecimentoCard
          key={config.mensagemAgradecimento ?? ''}
          configurada={config.mensagemAgradecimento}
          sugerida={config.mensagemAgradecimentoSugerida}
          podeEditar={podeGerenciarMensagens && !carregando}
          salvando={props.agradecimento.salvando}
          onSalvar={props.agradecimento.onSalvar}
        />
      )}
      <section className="config-card">
        <h2>Notificações por e-mail</h2>
        <p>Escolha quais avisos você recebe por e-mail. A escolha vale só para você.</p>
        <SettingToggle
          label="Presentes recebidos"
          description="Notificar quando alguém escolher ou enviar um presente."
          {...emailToggle('presentes')}
        />
        <SettingToggle
          label="Novos recados"
          description="Notificar quando um convidado enviar uma mensagem. Com Presentes recebidos ligado, o recado já vem nesse e-mail."
          {...emailToggle('recados')}
        />
        <SettingToggle
          label="Confirmações de presença"
          description="Notificar quando um convidado confirmar presença."
          {...emailToggle('presencas')}
        />
      </section>
      {props.exclusao.permitida && config && idCampanha && (
        <section className="config-card config-danger">
          <h2>Excluir Listas</h2>
          <p>Exclua a lista «{config.tituloLista}» do seu painel e tire a página dela do ar.</p>
          <button
            type="button"
            className="perfil-btn perfil-btn-ghost"
            onClick={() => setShowDelete(true)}
          >
            Excluir esta lista
          </button>
          {showDelete && (
            <ExcluirListaDialog
              tituloLista={config.tituloLista}
              pendente={props.exclusao.pendente}
              erro={props.exclusao.erro}
              onConfirmar={props.exclusao.onConfirmar}
              onFechar={() => {
                setShowDelete(false);
                props.exclusao.onFechar();
              }}
            />
          )}
        </section>
      )}
    </div>
  );
}

function MensagemAgradecimentoCard({
  configurada,
  sugerida,
  podeEditar,
  salvando,
  onSalvar,
}: {
  configurada: string | null;
  sugerida: string;
  podeEditar: boolean;
  salvando: boolean;
  onSalvar: (mensagem: string | null) => void;
}) {
  const [texto, setTexto] = useState(configurada ?? sugerida);
  const atual = configurada ?? sugerida;
  const mudou = texto.trim() !== atual.trim();
  return (
    <section className="config-card">
      <h2>Mensagem de agradecimento</h2>
      <p>
        É a mensagem padrão quando você agradece quem te presenteou (em Presentes ou Recados). Use{' '}
        {'{nome}'} para chamar cada pessoa pelo primeiro nome.
      </p>
      <textarea
        className="config-textarea"
        aria-label="Mensagem de agradecimento"
        rows={4}
        maxLength={5000}
        value={texto}
        disabled={!podeEditar || salvando}
        onChange={(e) => setTexto(e.target.value)}
      />
      {podeEditar ? (
        <div className="config-actions">
          {configurada !== null && (
            <button
              type="button"
              className="perfil-btn perfil-btn-ghost"
              disabled={salvando}
              onClick={() => {
                setTexto(sugerida);
                onSalvar(null);
              }}
            >
              Usar a sugerida
            </button>
          )}
          <button
            type="button"
            className="perfil-btn perfil-btn-primary"
            disabled={!mudou || texto.trim().length === 0 || salvando}
            onClick={() => onSalvar(texto.trim() === sugerida.trim() ? null : texto.trim())}
          >
            {salvando ? 'Salvando…' : 'Salvar mensagem'}
          </button>
        </div>
      ) : (
        <small>Somente quem gerencia as mensagens pode alterar esta mensagem.</small>
      )}
    </section>
  );
}

interface ExcluirListaDialogProps {
  tituloLista: string;
  pendente: boolean;
  erro: string | null;
  onConfirmar: () => void;
  onFechar: () => void;
}

export function ExcluirListaDialog({
  tituloLista,
  pendente,
  erro,
  onConfirmar,
  onFechar,
}: ExcluirListaDialogProps) {
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
        e.preventDefault();
        if (!pendente) onFechar();
      }}
    >
      <h2 id="delete-title">Excluir lista</h2>
      <p>A lista «{tituloLista}» e os dados do evento vinculados a ela serão excluídos.</p>
      <p>
        Para solicitar a exclusão de uma lista com histórico financeiro, fale com o{' '}
        <a href={EUNENEM_SUPPORT_WHATSAPP_URL}>atendimento</a>.
      </p>
      <label className="config-consent">
        <input
          type="checkbox"
          checked={confirm}
          disabled={pendente}
          onChange={(e) => setConfirm(e.target.checked)}
        />
        Entendo que essa ação é definitiva e quero excluir esta lista.
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
          {pendente ? 'Excluindo…' : 'Excluir lista'}
        </button>
      </div>
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
