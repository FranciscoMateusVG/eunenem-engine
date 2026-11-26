// aperture-bqvb5 — "agradecer presentes": the owner picks one or more people
// who gave gifts and sends them a thank-you email (her own words, her
// configured default, or the suggested text). People come from
// `agradecimentos.destinatarios` (grouped per giver, email never reaches the
// browser); the selection is sent back as payment ids.
//
// Self-contained styles (`agr-` prefix) so Presentes and Mensagens can both
// mount it regardless of their own CSS scopes.
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";

type Modo = "padrao" | "escrever";

function primeiroNome(nome: string): string {
  return nome.trim().split(/\s+/)[0] || "tudo bem";
}

function fmtData(iso: string): string {
  return new Date(iso).toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo" });
}

export function AgradecerModal({
  idCampanha,
  open,
  idPagamentoInicial,
  onClose,
}: {
  idCampanha: string;
  open: boolean;
  /** Preselects the giver of this payment (drawer / recado shortcut). */
  idPagamentoInicial?: string | null;
  onClose: () => void;
}) {
  const utils = trpc.useUtils();
  const destinatarios = trpc.agradecimentos.destinatarios.useQuery(
    { idCampanha },
    { enabled: open && idCampanha !== "" },
  );
  const config = trpc.configuracoes.get.useQuery(
    { idCampanha },
    { enabled: open && idCampanha !== "" },
  );
  const pessoas = destinatarios.data?.pessoas ?? [];
  const [selecionadas, setSelecionadas] = useState<ReadonlySet<string>>(new Set());
  const [modo, setModo] = useState<Modo>("padrao");
  const [texto, setTexto] = useState("");

  // Fresh state each time it opens; preselect the shortcut's giver.
  useEffect(() => {
    if (!open) return;
    setModo("padrao");
    setTexto("");
    setSelecionadas(new Set());
  }, [open]);
  useEffect(() => {
    if (!open || !idPagamentoInicial || pessoas.length === 0) return;
    const pessoa = pessoas.find((p) => p.idsPagamento.includes(idPagamentoInicial));
    if (pessoa) setSelecionadas(new Set([pessoa.idsPagamento[0] as string]));
  }, [open, idPagamentoInicial, pessoas]);

  const enviar = trpc.agradecimentos.enviar.useMutation({
    onSuccess: ({ enviados, falhas }) => {
      void utils.agradecimentos.destinatarios.invalidate({ idCampanha });
      if (enviados > 0) {
        toast.success(
          enviados === 1
            ? "agradecimento enviado ♡"
            : `agradecimento enviado para ${enviados} pessoas ♡`,
        );
      }
      if (falhas > 0) {
        toast.error(
          `não consegui enviar para ${falhas} ${falhas === 1 ? "pessoa" : "pessoas"} — tenta de novo?`,
        );
        return;
      }
      onClose();
    },
    onError: (err) =>
      toast.error(
        err.data?.code === "TOO_MANY_REQUESTS" || err.data?.code === "FORBIDDEN"
          ? err.message
          : "não consegui enviar o agradecimento — tenta de novo?",
      ),
  });

  const escolhidas = useMemo(
    () => pessoas.filter((p) => selecionadas.has(p.idsPagamento[0] as string)),
    [pessoas, selecionadas],
  );
  const jaAgradecidas = escolhidas.filter((p) => p.agradecidoEm !== null);
  const mensagemPadrao =
    config.data?.mensagemAgradecimento ?? config.data?.mensagemAgradecimentoSugerida ?? "";
  const mensagem = modo === "escrever" ? texto : mensagemPadrao;
  const exemplo = escolhidas[0] ?? pessoas[0];
  const previa = exemplo ? mensagem.replaceAll("{nome}", primeiroNome(exemplo.nome)) : mensagem;
  const podeEnviar =
    escolhidas.length > 0 &&
    !enviar.isPending &&
    (modo === "padrao" ? mensagemPadrao.length > 0 : texto.trim().length > 0);

  if (!open) return null;

  const alternar = (chave: string) =>
    setSelecionadas((atual) => {
      const proxima = new Set(atual);
      if (proxima.has(chave)) proxima.delete(chave);
      else proxima.add(chave);
      return proxima;
    });
  const todasMarcadas = pessoas.length > 0 && escolhidas.length === pessoas.length;

  return (
    <>
      <style>{AGRADECER_CSS}</style>
      <div className="agr-scrim" onClick={enviar.isPending ? undefined : onClose} />
      <div className="agr-modal" role="dialog" aria-modal="true" aria-labelledby="agr-title">
        <header className="agr-hd">
          <div>
            <span className="agr-caps">quem te presenteou ♡</span>
            <h3 id="agr-title" className="agr-title">
              Agradecer presentes
            </h3>
          </div>
          <button
            type="button"
            className="agr-x"
            onClick={onClose}
            aria-label="Fechar"
            disabled={enviar.isPending}
          >
            ×
          </button>
        </header>

        <div className="agr-body">
          {destinatarios.isLoading ? (
            <p className="agr-muted">carregando…</p>
          ) : destinatarios.error ? (
            <p className="agr-muted" role="alert">
              {destinatarios.error.message || "não consegui carregar quem presenteou."}
            </p>
          ) : pessoas.length === 0 ? (
            <p className="agr-muted">
              ninguém para agradecer ainda — os presentes pagos com nome e e-mail aparecem aqui ♡
            </p>
          ) : (
            <>
              <div className="agr-list-hd">
                <span className="agr-caps">
                  {escolhidas.length} de {pessoas.length} selecionadas
                </span>
                <button
                  type="button"
                  className="agr-link"
                  onClick={() =>
                    setSelecionadas(
                      todasMarcadas
                        ? new Set()
                        : new Set(pessoas.map((p) => p.idsPagamento[0] as string)),
                    )
                  }
                >
                  {todasMarcadas ? "desmarcar todas" : "selecionar todas"}
                </button>
              </div>
              <ul className="agr-list">
                {pessoas.map((p) => {
                  const chave = p.idsPagamento[0] as string;
                  return (
                    <li key={chave}>
                      <label className="agr-pessoa">
                        <input
                          type="checkbox"
                          checked={selecionadas.has(chave)}
                          onChange={() => alternar(chave)}
                        />
                        <span className="agr-pessoa-txt">
                          <span className="agr-pessoa-nome">{p.nome || "(sem nome)"}</span>
                          {p.presentes.length > 0 && (
                            <span className="agr-pessoa-sub">{p.presentes.join(", ")}</span>
                          )}
                        </span>
                        {p.agradecidoEm && (
                          <span className="agr-tag" title={`agradecido em ${fmtData(p.agradecidoEm)}`}>
                            agradecido ♡
                          </span>
                        )}
                      </label>
                    </li>
                  );
                })}
              </ul>

              <fieldset className="agr-modo">
                <legend className="agr-caps">mensagem</legend>
                <label>
                  <input
                    type="radio"
                    name="agr-modo"
                    checked={modo === "padrao"}
                    onChange={() => setModo("padrao")}
                  />
                  mensagem padrão
                </label>
                <label>
                  <input
                    type="radio"
                    name="agr-modo"
                    checked={modo === "escrever"}
                    onChange={() => {
                      setModo("escrever");
                      if (!texto) setTexto(mensagemPadrao);
                    }}
                  />
                  escrever mensagem
                </label>
              </fieldset>
              {modo === "escrever" ? (
                <label className="agr-field">
                  <span className="agr-sr">texto do agradecimento</span>
                  <textarea
                    value={texto}
                    maxLength={5000}
                    rows={5}
                    onChange={(e) => setTexto(e.target.value)}
                    aria-label="texto do agradecimento"
                  />
                  <span className="agr-muted">
                    use {"{nome}"} para chamar cada pessoa pelo primeiro nome
                  </span>
                </label>
              ) : null}
              <div className="agr-previa" aria-label="prévia">
                <span className="agr-caps">prévia</span>
                <p>{previa}</p>
              </div>
              {jaAgradecidas.length > 0 && (
                <p className="agr-aviso" role="status">
                  {jaAgradecidas.length === 1
                    ? `${primeiroNome(jaAgradecidas[0]?.nome ?? "")} já foi agradecido(a) — vai receber de novo.`
                    : `${jaAgradecidas.length} pessoas já foram agradecidas — vão receber de novo.`}
                </p>
              )}
            </>
          )}
        </div>

        <footer className="agr-ft">
          <button
            type="button"
            className="agr-btn-ghost"
            onClick={onClose}
            disabled={enviar.isPending}
          >
            cancelar
          </button>
          <button
            type="button"
            className="agr-btn"
            disabled={!podeEnviar}
            onClick={() =>
              enviar.mutate({
                idCampanha,
                idsPagamento: escolhidas.flatMap((p) => p.idsPagamento),
                ...(modo === "escrever" ? { mensagem: texto.trim() } : {}),
              })
            }
          >
            {enviar.isPending
              ? "enviando…"
              : jaAgradecidas.length > 0
                ? "enviar de novo"
                : escolhidas.length > 1
                  ? `enviar para ${escolhidas.length}`
                  : "enviar agradecimento"}
          </button>
        </footer>
      </div>
    </>
  );
}

const AGRADECER_CSS = `
.agr-scrim { position: fixed; inset: 0; background: rgba(107, 60, 94, 0.32); backdrop-filter: blur(4px); z-index: 120; }
.agr-modal {
  position: fixed; left: 50%; top: 50%; transform: translate(-50%, -50%); z-index: 121;
  width: min(520px, calc(100vw - 24px)); max-height: calc(100dvh - 24px);
  display: flex; flex-direction: column; background: var(--paper, #fff);
  border: 1px solid var(--line, #efe7ee); border-radius: 22px;
  box-shadow: 0 30px 80px -20px rgba(107, 60, 94, 0.45); color: var(--plum, #6b3c5e);
  font-family: var(--font-dm-sans), system-ui, sans-serif;
}
.agr-hd { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; padding: 20px 22px 8px; }
.agr-title { font-family: var(--font-patrick-hand), cursive; font-size: 26px; margin: 2px 0 0; line-height: 1.1; }
.agr-caps { font-size: 11px; font-weight: 600; letter-spacing: 0.1em; text-transform: uppercase; color: var(--ink-soft, #8a6f80); }
.agr-x { width: 36px; height: 36px; border-radius: 999px; border: 0; background: var(--cream, #f7f2ee); font-size: 20px; color: var(--ink-soft, #8a6f80); cursor: pointer; flex: none; }
.agr-body { padding: 6px 22px 12px; overflow-y: auto; display: flex; flex-direction: column; gap: 12px; }
.agr-muted { margin: 0; font-size: 13px; color: var(--ink-soft, #8a6f80); line-height: 1.5; }
.agr-list-hd { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
.agr-link { background: none; border: 0; padding: 4px 0; color: var(--lilac-deep, #9d6cb6); font-size: 12px; font-weight: 600; text-decoration: underline; cursor: pointer; }
.agr-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; max-height: 34dvh; overflow-y: auto; }
.agr-pessoa { display: flex; align-items: center; gap: 10px; padding: 10px 12px; border: 1px solid var(--line, #efe7ee); border-radius: 14px; cursor: pointer; min-height: 44px; }
.agr-pessoa:has(input:checked) { border-color: var(--lilac, #c9a5d8); background: rgba(201, 165, 216, 0.12); }
.agr-pessoa input { width: 18px; height: 18px; accent-color: var(--lilac-deep, #9d6cb6); flex: none; }
.agr-pessoa-txt { display: flex; flex-direction: column; min-width: 0; flex: 1; }
.agr-pessoa-nome { font-weight: 600; font-size: 14px; }
.agr-pessoa-sub { font-size: 12px; color: var(--ink-soft, #8a6f80); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.agr-tag { flex: none; font-size: 11px; font-weight: 600; color: var(--green-deep, #6f8a2a); background: rgba(160, 190, 90, 0.16); border-radius: 999px; padding: 3px 8px; }
.agr-modo { border: 0; margin: 0; padding: 0; display: flex; flex-wrap: wrap; gap: 6px 16px; align-items: center; }
.agr-modo legend { margin-bottom: 6px; padding: 0; }
.agr-modo label { display: inline-flex; align-items: center; gap: 6px; font-size: 14px; min-height: 32px; cursor: pointer; }
.agr-field { display: flex; flex-direction: column; gap: 6px; }
.agr-field textarea { width: 100%; box-sizing: border-box; border: 1.5px solid var(--line, #efe7ee); border-radius: 14px; padding: 10px 12px; font: inherit; font-size: 16px; color: var(--plum, #6b3c5e); resize: vertical; background: var(--cream, #f7f2ee); }
.agr-field textarea:focus { outline: none; border-color: var(--lilac, #c9a5d8); background: var(--paper, #fff); }
.agr-sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
.agr-previa { background: var(--cream, #f7f2ee); border: 1px dashed var(--line, #efe7ee); border-radius: 14px; padding: 10px 12px; }
.agr-previa p { margin: 4px 0 0; font-size: 14px; line-height: 1.55; white-space: pre-wrap; overflow-wrap: anywhere; }
.agr-aviso { margin: 0; font-size: 13px; color: #9a5b1e; background: rgba(240, 180, 90, 0.16); border-radius: 12px; padding: 8px 10px; }
.agr-ft { display: flex; justify-content: flex-end; gap: 10px; flex-wrap: wrap; padding: 12px 22px 18px; border-top: 1px solid var(--line, #efe7ee); }
.agr-btn, .agr-btn-ghost { min-height: 44px; padding: 10px 16px; border-radius: 999px; font-size: 12px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; cursor: pointer; }
.agr-btn { border: 0; color: #fff; background: var(--lilac-deep, #9d6cb6); }
.agr-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.agr-btn-ghost { border: 1px solid var(--line, #efe7ee); background: transparent; color: var(--ink-soft, #8a6f80); }
@media (max-width: 480px) {
  .agr-ft > button { flex: 1 1 auto; }
}
`;
