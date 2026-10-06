import type { CSSProperties } from "react";
import { EDIT_FIELDS, type EditField } from "@/lib/inline-edit";
import { useTweaks } from "./TweaksContext";

// aperture-whxzg — contextual owner edit icon.
//
// One small round button parked next to the page element it edits (hero
// title, cover photo, polaroid, story text, story photo). Clicking it opens
// the existing Personalizar panel focused on the exact input for that field
// (openEditor → TweaksPanel focus effect). Rendered ONLY by owner-authorized
// surfaces: Hero/Story take an `editable` bit that PaginaPage derives from
// getPerfilPublicoBySlug.isOwner — a guest, a signed-out visitor or another
// creator never gets this element in the tree.
//
// 44×44 hit area (WCAG 2.5.5 / mobile), visible label via aria-label +
// title, keyboard-native (<button>). Visuals live in .eu-edit-btn
// (tailwind.css) so the hover/focus ring is one definition.
export function EditButton({
  field,
  style,
  className,
}: {
  field: EditField;
  style?: CSSProperties;
  className?: string;
}) {
  const { openEditor } = useTweaks();
  const spec = EDIT_FIELDS[field];
  return (
    <button
      type="button"
      className={`eu-edit-btn${className ? ` ${className}` : ""}`}
      data-testid={`edit-${field}`}
      data-edit-field={field}
      aria-label={spec.iconLabel}
      title={spec.iconLabel}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        openEditor(field);
      }}
      style={style}
    >
      <svg
        viewBox="0 0 24 24"
        width={18}
        height={18}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.7}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M4 20h4l10.5-10.5a2.1 2.1 0 0 0-3-3L5 17v3z" />
        <path d="M13.5 6.5l3 3" />
      </svg>
    </button>
  );
}
