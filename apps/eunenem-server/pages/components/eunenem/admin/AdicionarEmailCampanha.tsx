import { useState } from 'react';
import { trpc } from '@/lib/trpc';

export function AdicionarEmailCampanha({ idCampanha }: { idCampanha: string }) {
  const [email, setEmail] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const mutation = trpc.admin.campanhas.adicionarEmail.useMutation();
  return (
    <form
      className="space-y-3 rounded border border-line p-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (confirmed) mutation.mutate({ idCampanha, email, confirmarApenasAcesso: true });
      }}
    >
      <h3 className="font-semibold">Adicionar acesso por e-mail</h3>
      <p className="text-sm">
        Ação auditada. O destinatário precisa entrar com o e-mail verificado. Não altera o
        proprietário nem os dados bancários.
      </p>
      <label className="block">
        E-mail
        <input
          className="ml-2 rounded border p-2"
          type="email"
          required
          value={email}
          onChange={(event) => setEmail(event.target.value)}
        />
      </label>
      <label className="block">
        <input
          type="checkbox"
          checked={confirmed}
          onChange={(event) => setConfirmed(event.target.checked)}
        />{' '}
        Confirmo que concederei somente acesso, sem transferência de titularidade financeira.
      </label>
      <button
        className="rounded bg-plum px-4 py-2 text-white"
        disabled={!confirmed || mutation.isPending}
      >
        Enviar convite de acesso
      </button>
      {mutation.isSuccess && (
        <p role="status">Convite enviado. Aguardando entrada com e-mail verificado.</p>
      )}
      {mutation.error && <p role="alert">{mutation.error.message}</p>}
    </form>
  );
}
