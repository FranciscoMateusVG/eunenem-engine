import { useEffect, useRef, useState } from 'react';
import { useCampanhaEscrita } from '@/lib/campanha-escrita';
import { painelHref, EUNENEM_SUPPORT_WHATSAPP_URL } from '@/lib/painelRoutes';
import type { PainelSectionBodyProps } from '@/PainelSectionPage';
import { useAcessoCampanha } from './useAcessoCampanha';

export function ConfiguracoesBody({ slug }: PainelSectionBodyProps) {
  const id = useCampanhaEscrita();
  const acesso = useAcessoCampanha(id);
  const dialog = useRef<HTMLDialogElement>(null);
  const [showDelete, setShowDelete] = useState(false);
  const [confirm, setConfirm] = useState(false);
  useEffect(() => {
    if (showDelete) dialog.current?.showModal();
  }, [showDelete]);
  return (
    <div className="config-body">
      <header>
        <h1>Configurações</h1>
        <p>Cuide dos acessos e das preferências do seu chá.</p>
      </header>
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
        <UnavailableToggle
          label="Exibir recados publicamente"
          description="Controle de privacidade indisponível nesta versão."
        />
        <small>Os recados continuam seguindo o funcionamento atual da página.</small>
        {acesso.pode('mensagens:ver') && (
          <a href={painelHref(slug, 'mensagens', id)}>Ver mensagens recebidas</a>
        )}
      </section>
      <section className="config-card">
        <h2>Notificações por e-mail</h2>
        <p>Personalização de notificações indisponível nesta versão.</p>
        <UnavailableToggle
          label="Presentes recebidos"
          description="Notificar quando alguém escolher ou enviar um presente."
        />
        <UnavailableToggle
          label="Novos recados"
          description="Notificar quando um convidado enviar uma mensagem."
        />
        <UnavailableToggle
          label="Confirmações de presença"
          description="Notificar quando um convidado confirmar presença."
        />
        <small>As notificações existentes continuam funcionando normalmente.</small>
      </section>
      <section className="config-card config-danger">
        <h2>Excluir conta</h2>
        <p>Converse com o atendimento sobre a exclusão da sua conta e dos dados associados.</p>
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
      </section>
      {showDelete && (
        <dialog
          ref={dialog}
          className="config-card config-modal"
          aria-labelledby="delete-title"
          onCancel={() => setShowDelete(false)}
        >
          <h2 id="delete-title">Exclusão da conta</h2>
          <p>
            O atendimento orientará a análise da sua conta, dos eventos e de possíveis pendências
            financeiras. Informações de perfil, fotos e preferências poderão ser excluídas após
            análise; registros financeiros e de segurança poderão precisar ser mantidos.
          </p>
          <p>Nenhuma solicitação é registrada nesta tela. Para iniciar, fale com o atendimento.</p>
          <label className="config-consent">
            <input
              type="checkbox"
              checked={confirm}
              onChange={(e) => setConfirm(e.target.checked)}
            />
            Entendo e quero conversar com o atendimento sobre minha conta.
          </label>
          <div className="config-actions">
            <button
              type="button"
              className="perfil-btn perfil-btn-ghost"
              onClick={() => setShowDelete(false)}
            >
              Cancelar
            </button>
            {confirm ? (
              <a className="perfil-btn perfil-btn-primary" href={EUNENEM_SUPPORT_WHATSAPP_URL}>
                Falar com o atendimento
              </a>
            ) : (
              <button type="button" className="perfil-btn perfil-btn-primary" disabled>
                Falar com o atendimento
              </button>
            )}
          </div>
        </dialog>
      )}
    </div>
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
