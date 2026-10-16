import { useState } from 'react';
import { trpc } from '@/lib/trpc';
import { useCampanhaEscrita } from '@/lib/campanha-escrita';

export function CompartilharBody() {
  const idCampanha = useCampanhaEscrita();
  const [email, setEmail] = useState('');
  const [notice, setNotice] = useState('');
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
    onSuccess: () => {
      setEmail('');
      setNotice(
        'Convite enviado. O acesso será liberado quando a pessoa entrar com este e-mail verificado.',
      );
      refresh();
    },
  });
  const revoke = trpc.compartilhamento.revogar.useMutation({ onSuccess: refresh });
  const remove = trpc.campanhaMembros.remover.useMutation({ onSuccess: refresh });
  const busy = invite.isPending || revoke.isPending || remove.isPending;
  if (!idCampanha || query.isLoading) return <p role="status">Carregando compartilhamento…</p>;
  if (query.error)
    return (
      <p role="alert">
        {query.error.data?.code === 'FORBIDDEN' || query.error.data?.code === 'UNAUTHORIZED'
          ? 'Somente o proprietário pode gerenciar o compartilhamento desta campanha.'
          : query.error.message}
      </p>
    );
  return (
    <section className="mx-auto max-w-2xl space-y-6 p-6">
      <h1 className="text-2xl font-semibold text-plum">Compartilhar</h1>
      <p>
        Convide alguém para acessar esta campanha. O convite vale por 7 dias e exige acesso ao
        e-mail pelo Google ou link de acesso.
      </p>
      <p className="text-sm text-ink-soft">
        Compartilhar não transfere a propriedade da campanha nem a titularidade financeira. Novos
        membros podem cuidar dos presentes, recados, perfil e convite. Não têm acesso a extrato,
        dados bancários ou saques, nem podem mudar o link ou compartilhar com outras pessoas.
      </p>
      <form
        className="flex flex-wrap gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          setNotice('');
          invite.mutate({ idCampanha, email });
        }}
      >
        <label className="flex-1">
          E-mail da pessoa
          <input
            className="block w-full rounded border p-2"
            type="email"
            required
            maxLength={254}
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </label>
        <button className="rounded bg-plum px-4 py-2 text-white" disabled={busy} type="submit">
          Convidar
        </button>
      </form>
      {notice && <p role="status">{notice}</p>}
      {(invite.error || revoke.error || remove.error) && (
        <p role="alert">{(invite.error || revoke.error || remove.error)?.message}</p>
      )}
      <h2 className="text-xl font-semibold">Pessoas com acesso</h2>
      <ul className="space-y-3">
        {query.data?.map((member) => (
          <li key={member.idConta} className="rounded border p-3">
            <p>
              {member.nomeExibicao ?? 'Pessoa'} · {member.email ?? 'Sem e-mail'}
            </p>
            {member.papel === 'owner' ? (
              <span>Proprietário</span>
            ) : (
              <button
                disabled={busy}
                className="text-plum underline"
                onClick={() => {
                  if (window.confirm('Remover o acesso desta pessoa?'))
                    remove.mutate({ idCampanha, idConta: member.idConta });
                }}
              >
                Remover acesso
              </button>
            )}
          </li>
        ))}
      </ul>
      <h2 className="text-xl font-semibold">Convites</h2>
      {invites.error && <p role="alert">{invites.error.message}</p>}
      <ul className="space-y-3">
        {invites.data?.map((invitation) => {
          const active =
            !invitation.revogado_em &&
            !invitation.consumido_em &&
            new Date(invitation.expira_em) > new Date();
          return (
            <li key={invitation.id} className="rounded border p-3">
              <p>{invitation.email}</p>
              <span>
                {invitation.consumido_em
                  ? 'Aceito'
                  : invitation.revogado_em
                    ? 'Revogado'
                    : active
                      ? `Pendente até ${new Date(invitation.expira_em).toLocaleDateString('pt-BR')}`
                      : 'Expirado'}
              </span>
              {active && (
                <button
                  className="ml-4 text-plum underline"
                  disabled={busy}
                  onClick={() => revoke.mutate({ idCampanha, idConvite: invitation.id })}
                >
                  Revogar convite
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
