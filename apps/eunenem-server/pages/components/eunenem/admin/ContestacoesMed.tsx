import { useState } from 'react';
import { trpc } from '@/lib/trpc';

export function ContestacoesMed({ idPagamento, idCampanha }: { idPagamento?: string; idCampanha?: string }) {
  const query = trpc.admin.contestacoes.listar.useQuery({ idPagamento, idCampanha });
  const utils = trpc.useUtils();
  const refresh = () => utils.admin.contestacoes.listar.invalidate();
  const register = trpc.admin.contestacoes.registrar.useMutation({ onSuccess: refresh });
  const cancel = trpc.admin.repasses.cancelar.useMutation({ onSuccess: refresh });
  const resolve = trpc.admin.contestacoes.resolver.useMutation({ onSuccess: refresh });
  const [reference, setReference] = useState(idPagamento ?? '');
  const [amount, setAmount] = useState('');
  const [date, setDate] = useState('');
  const [caseId, setCaseId] = useState('');
  const [notes, setNotes] = useState('');
  const [resolutionDate, setResolutionDate] = useState('');
  const [resolutionNotes, setResolutionNotes] = useState('');
  return <section className="space-y-3 rounded border border-amber-400 bg-amber-50 p-4">
    <h3 className="font-semibold">Contestações PIX · MED</h3>
    <p className="text-sm">Registro manual do aviso do banco. Não estorna o pagamento nem movimenta dinheiro. Bloqueada ou devolvida: todo o crédito deste pagamento fica retido no repasse.</p>
    {query.isLoading && <p>Consultando contestações…</p>}
    {query.error && <p role="alert">Não foi possível consultar MED: {query.error.message}</p>}
    {query.data?.length === 0 && <p>Sem contestação registrada.</p>}
    {query.data?.map((med) => <div key={med.id} className="space-y-2 border-t border-amber-300 pt-3">
      <p><strong>MED {med.estado}</strong> · {(med.valorCents / 100).toLocaleString('pt-BR', {style: 'currency', currency: 'BRL'})} · <a className="underline" href={`/admin/pagamento/${med.idPagamento}`}>Pagamento {med.idPagamento.slice(0, 8)}</a></p>
      <p>Ocorrência: {new Date(med.ocorridaEm).toLocaleString('pt-BR')}{med.casoId && ` · Caso: ${med.casoId}`}</p>
      <p>{med.notas}</p>
      {med.exposicao && <p role="alert" className="font-semibold text-red-800">Atenção: repasse já enviado, em processamento ou pago. Há exposição financeira; este registro não recupera valores.</p>}
      {med.estado !== 'liberada' && <p role="alert">Repasse retido por MED. Lotes já solicitados não podem ser aprovados/enviados; cancele e solicite novamente para excluir este pagamento.</p>}
      {idPagamento && med.repasseCancelavel && <button type="button" className="rounded border p-2" disabled={cancel.isPending} onClick={() => {
        if (window.confirm('Cancelar este lote retido por MED? Solicite outro repasse para os créditos elegíveis.')) cancel.mutate({idRepasse: med.repasseCancelavel as string});
      }}>Cancelar lote MED para solicitar novamente</button>}
      {idPagamento && med.estado === 'bloqueada'  && <div className="space-y-2">
        <label className="block">Data da resolução confirmada pelo banco <input required type="datetime-local" value={resolutionDate} onChange={(e) => setResolutionDate(e.target.value)} /></label>
        <label className="block">Notas da resolução <input maxLength={2000} value={resolutionNotes} onChange={(e) => setResolutionNotes(e.target.value)} /></label>
        {(['liberada', 'devolvida'] as const).map((estado) => <button key={estado} type="button" className="mr-3 rounded border p-2" disabled={!resolutionDate || resolve.isPending} onClick={() => {
          if (window.confirm(`Confirmar ${estado}? Registre somente o desfecho confirmado pelo banco.`)) resolve.mutate({id: med.id, estado, resolvidaEm: new Date(resolutionDate), notas: resolutionNotes});
        }}>Marcar {estado}</button>)}
      </div>}
    </div>)}
    {idPagamento && query.data?.length === 0 && <form className="space-y-2" onSubmit={(e) => {
      e.preventDefault(); register.mutate({pagamentoOuE2e: reference, valorCents: Math.round(Number(amount) * 100), ocorridaEm: new Date(date), casoId: caseId || undefined, notas: notes});
    }}>
      <label className="block">ID do pagamento ou E2E <input required value={reference} onChange={(e) => setReference(e.target.value)} /></label>
      <label className="block">Valor contestado (R$) <input required type="number" min="0.01" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} /></label>
      <label className="block">Data do bloqueio <input required type="datetime-local" value={date} onChange={(e) => setDate(e.target.value)} /></label>
      <label className="block">ID do caso (opcional) <input maxLength={100} value={caseId} onChange={(e) => setCaseId(e.target.value)} /></label>
      <label className="block">Notas <input maxLength={2000} value={notes} onChange={(e) => setNotes(e.target.value)} /></label>
      <button disabled={register.isPending} type="submit" className="rounded border p-2">Registrar contestação e reter repasse</button>
    </form>}
    {(register.error || resolve.error || cancel.error) && <p role="alert">{register.error?.message ?? resolve.error?.message ?? cancel.error?.message}</p>}
  </section>;
}
