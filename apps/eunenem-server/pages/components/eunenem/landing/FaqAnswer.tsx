// Render the answer's paragraphs, bullet lists and emphasis as semantic JSX.
// Text stays escaped by React; no HTML from the copy is injected.
function emphasis(text: string) {
  return text.split(/(\*\*[^*]+\*\*)/g).map((part, index) =>
    part.startsWith('**') && part.endsWith('**') ? (
      <strong key={index}>{part.slice(2, -2)}</strong>
    ) : part,
  );
}

export function FaqAnswer({ text }: { text: string }) {
  return (
    <div className="space-y-3">
      {text.split('\n\n').map((block, index) =>
        block.startsWith('- ') ? (
          <ul key={index} className="list-disc space-y-2 pl-5">
            {block.split('\n').map((line) => (
              <li key={line}>{emphasis(line.slice(2))}</li>
            ))}
          </ul>
        ) : (
          <p key={index}>{emphasis(block)}</p>
        ),
      )}
    </div>
  );
}
