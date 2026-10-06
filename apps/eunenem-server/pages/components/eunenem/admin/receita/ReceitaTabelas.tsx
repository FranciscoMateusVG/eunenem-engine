import { formatBRL } from "@/lib/formatBRL";
import { type ReceitaDashboard, type ReceitaMeioProvedor, ROTULOS } from "./types";

/**
 * Decomposição da Receita EuNeném por meio/provedor (aperture-9bpre). A aba
 * Receita 1b não a exibe mais; a prévia da NFS-e a usa.
 */

const TH = "px-3 py-2";
const THR = "px-3 py-2 text-right";

function Valor({ cents, forte = false }: { cents: number; forte?: boolean }) {
  return (
    <td
      className={`whitespace-nowrap px-3 py-2 text-right font-mono tabular-nums ${
        forte ? "font-semibold text-ink" : "text-ink-soft"
      }`}
    >
      {formatBRL(cents)}
    </td>
  );
}

function CabecalhoValores() {
  return (
    <>
      <th scope="col" className={THR}>
        {ROTULOS.registradas}
      </th>
      <th scope="col" className={THR}>
        {ROTULOS.cancelamentos}
      </th>
      <th scope="col" className={THR}>
        {ROTULOS.resultado}
      </th>
    </>
  );
}

function rotuloMetodo(metodo: ReceitaMeioProvedor["metodo"]): string {
  if (metodo === "pix") return "PIX";
  if (metodo === "credit_card") return "Cartão";
  return "meio não registrado";
}

function rotuloProvedor(provedor: ReceitaMeioProvedor["provedor"]): string {
  if (provedor === "stripe") return "Stripe";
  if (provedor === "inter") return "Inter";
  return "provedor não registrado";
}

export function ReceitaPorMeioProvedor({
  rows,
  soma,
}: {
  rows: ReceitaDashboard["porMeioProvedor"];
  soma: ReceitaDashboard["conciliacao"]["somaPorMeioProvedor"];
}) {
  return (
    <section aria-labelledby="receita-meio-title" className="space-y-3">
      <div>
        <h2 id="receita-meio-title" className="text-lg font-semibold text-ink">
          Por meio de pagamento e provedor
        </h2>
        <p className="text-[13px] text-ink-soft">
          Quando o pagamento não guarda o provedor, a taxa aparece em "provedor não registrado" —
          nunca é descartada.
        </p>
      </div>
      {rows.length === 0 ? (
        <p className="rounded-md border border-line bg-paper p-5 text-[14px] text-ink-soft">
          Nenhuma taxa registrada ou cancelada neste período.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-md border border-line bg-paper">
          <table className="min-w-full divide-y divide-line text-left text-[12px]">
            <thead className="bg-cream-2/60 font-mono uppercase tracking-[0.12em] text-ink-mute">
              <tr>
                <th scope="col" className={TH}>
                  Meio
                </th>
                <th scope="col" className={TH}>
                  Provedor
                </th>
                <CabecalhoValores />
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {rows.map((row) => (
                <tr key={`${row.metodo}:${row.provedor}`}>
                  <th scope="row" className="whitespace-nowrap px-3 py-2 font-normal text-ink">
                    {rotuloMetodo(row.metodo)}
                  </th>
                  <td className="whitespace-nowrap px-3 py-2 text-ink-soft">
                    {rotuloProvedor(row.provedor)}
                  </td>
                  <Valor cents={row.taxasRegistradasCents} />
                  <Valor cents={row.cancelamentosCents} />
                  <Valor cents={row.resultadoDeTaxasCents} forte />
                </tr>
              ))}
            </tbody>
            <tfoot className="border-t-2 border-line bg-cream-2/40">
              <tr>
                <th scope="row" colSpan={2} className="px-3 py-2 text-left font-semibold text-ink">
                  Todos os meios
                </th>
                <Valor cents={soma.taxasRegistradasCents} />
                <Valor cents={soma.cancelamentosCents} />
                <Valor cents={soma.taxasRegistradasCents - soma.cancelamentosCents} forte />
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </section>
  );
}
