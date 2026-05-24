
import { useCallback, useRef, useState, type DragEvent } from "react";

// aperture-3d9t — drag-drop + browse-files image-slot.
//
// Preview-only — file selection populates an in-memory object URL
// for display, no persistence per operator constraint. On reload the
// slot returns to placeholder.
//
// Three states:
//   - empty: dashed lilac border + Patrick Hand placeholder text +
//            "Arraste a foto aqui / ou clique" affordance.
//   - dragOver: cream-2 fill + animated border (subtle).
//   - filled: shows the selected image at full-bleed inside the slot.
//
// Accessibility:
//   - the slot is a real `<button>` so keyboard users tab to it +
//     hit Enter/Space to open the file picker.
//   - drag-and-drop handlers are mouse-only enhancements layered on
//     top; the keyboard path is the canonical interaction.

interface ImageSlotProps {
  /** Placeholder text shown when empty. */
  placeholder?: string;
  /** Fixed aspect — defaults to "auto" (use parent's height). */
  aspectRatio?: string;
  /** Slot id (DOM only — semantic, not used for persistence). */
  id?: string;
  className?: string;
  /** Visual fit when an image is selected. */
  fit?: "cover" | "contain";
}

export function ImageSlot({
  placeholder = "Arraste a foto aqui ou clique",
  aspectRatio,
  id,
  className,
  fit = "cover",
}: ImageSlotProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);

  const handleFile = useCallback((file: File | null | undefined) => {
    if (!file) return;
    if (!file.type.startsWith("image/")) return;
    const url = URL.createObjectURL(file);
    setPreview((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return url;
    });
  }, []);

  const onClick = () => inputRef.current?.click();
  const onChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    handleFile(e.target.files?.[0]);
  };
  const onDragOver = (e: DragEvent<HTMLButtonElement>) => {
    e.preventDefault();
    if (!isDragOver) setIsDragOver(true);
  };
  const onDragLeave = () => setIsDragOver(false);
  const onDrop = (e: DragEvent<HTMLButtonElement>) => {
    e.preventDefault();
    setIsDragOver(false);
    handleFile(e.dataTransfer.files?.[0]);
  };

  return (
    <>
      <button
        type="button"
        id={id}
        onClick={onClick}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        className={className}
        aria-label={preview ? "Trocar foto" : `Selecionar foto: ${placeholder}`}
        style={{
          position: "relative",
          width: "100%",
          height: "100%",
          aspectRatio,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: preview
            ? "var(--cream-2)"
            : isDragOver
              ? "var(--lilac-soft)"
              : "var(--cream-2)",
          border: preview
            ? "none"
            : `1.5px dashed ${isDragOver ? "var(--lilac-deep)" : "var(--lilac)"}`,
          borderRadius: "inherit",
          overflow: "hidden",
          cursor: "pointer",
          padding: 16,
          textAlign: "center",
          transition: "background 0.2s ease, border-color 0.2s ease",
        }}
      >
        {preview ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={preview}
            alt="Pré-visualização do upload"
            style={{
              position: "absolute",
              inset: 0,
              width: "100%",
              height: "100%",
              objectFit: fit,
            }}
          />
        ) : (
          <span
            style={{
              fontFamily: "var(--font-patrick-hand), cursive",
              fontSize: 18,
              color: "var(--lilac-deep)",
              lineHeight: 1.3,
              maxWidth: 220,
            }}
          >
            {placeholder}
          </span>
        )}
      </button>
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        hidden
        onChange={onChange}
      />
    </>
  );
}
