import { numero } from "./formato";

/**
 * Nota de cobertura/limitação de uma métrica (aperture-lcug3). O texto vem do
 * servidor e aparece literalmente; quando o dado é parcial, a nota ganha
 * destaque e mostra quantos itens foram de fato observados.
 */
export interface CoberturaDados {
  nota: string;
  parcial: boolean;
  denominador: number;
  observados: number;
}

export function CoberturaNota({ cobertura, unidade }: { cobertura: CoberturaDados; unidade?: string }) {
  return (
    <p
      data-testid="cobertura-nota"
      data-parcial={cobertura.parcial}
      className={`rounded-md border p-3 text-[13px] ${
        cobertura.parcial ? "border-amber-200 bg-amber-50 text-amber-900" : "border-line bg-stone-50 text-ink-soft"
      }`}
    >
      {cobertura.parcial ? <strong className="font-semibold">Dado parcial. </strong> : null}
      {cobertura.nota}
      {unidade && cobertura.denominador > 0 ? (
        <span className="ml-1 font-mono text-[11px]">
          ({numero(cobertura.observados)} de {numero(cobertura.denominador)} {unidade} com o dado)
        </span>
      ) : null}
    </p>
  );
}
