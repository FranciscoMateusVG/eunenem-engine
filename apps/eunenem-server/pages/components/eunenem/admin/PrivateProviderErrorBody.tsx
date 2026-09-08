/**
 * Admin-only presentation for the private Banco Inter error response.
 *
 * React renders `body` as a text node, escaping any HTML-like provider text.
 * The details element is collapsed by default so sensitive diagnostics are
 * revealed only when the authorized operator asks for them.
 */
export function PrivateProviderErrorBody({
  body,
  truncated,
}: {
  body: string;
  truncated: boolean;
}) {
  return (
    <details className="ml-6 rounded border border-red-200 bg-red-50/50 px-3 py-2">
      <summary className="cursor-pointer font-mono text-[10px] uppercase tracking-[0.12em] text-red-800">
        resposta privada do banco
        {truncated ? " · truncada em 16 KiB" : ""}
      </summary>
      <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] text-red-950">
        {body}
      </pre>
    </details>
  );
}
