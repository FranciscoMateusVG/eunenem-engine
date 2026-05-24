// aperture-3d9t — decorative SVG doodles + Polaroid + Tape primitives.
//
// Ported from reference/doodles.jsx into idiomatic typed React.
// Colours default to design-system tokens (CSS vars) so they
// follow TweaksContext primary/accent overrides automatically.
//
// All decoration is purely visual — `aria-hidden` on every component
// so screen readers skip them.

import type { CSSProperties, SVGProps, ReactNode } from "react";

interface DoodleProps {
  size?: number;
  color?: string;
  className?: string;
  style?: CSSProperties;
}

export function StarDoodle({
  size = 24,
  color = "var(--lilac-deep)",
  className,
  style,
}: DoodleProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      className={className}
      style={style}
      aria-hidden="true"
    >
      <path
        d="M12 2 L13.6 8.4 L20 10 L13.6 11.6 L12 18 L10.4 11.6 L4 10 L10.4 8.4 Z"
        fill={color}
      />
    </svg>
  );
}

export function FlowerDoodle({
  size = 28,
  color = "var(--coral-pink)",
  className,
  style,
}: DoodleProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      className={className}
      style={style}
      aria-hidden="true"
    >
      <circle cx="16" cy="8" r="4.2" fill={color} opacity=".85" />
      <circle cx="24" cy="16" r="4.2" fill={color} opacity=".85" />
      <circle cx="16" cy="24" r="4.2" fill={color} opacity=".85" />
      <circle cx="8" cy="16" r="4.2" fill={color} opacity=".85" />
      <circle cx="16" cy="16" r="3" fill="var(--yellow)" />
    </svg>
  );
}

export function BottleDoodle({
  size = 30,
  color = "var(--lilac-deep)",
  className,
  style,
}: DoodleProps) {
  return (
    <svg
      width={size}
      height={size * 1.35}
      viewBox="0 0 30 40"
      fill="none"
      className={className}
      style={style}
      aria-hidden="true"
    >
      <rect x="10" y="2" width="10" height="4" rx="2" fill={color} />
      <path
        d="M8 8 h14 v22 a6 6 0 0 1 -6 6 h-2 a6 6 0 0 1 -6 -6 z"
        stroke={color}
        strokeWidth="1.8"
        fill="none"
      />
      <path
        d="M10 20 h10"
        stroke={color}
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function HeartDoodle({
  size = 22,
  color = "var(--coral-pink)",
  className,
  style,
}: DoodleProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      className={className}
      style={style}
      aria-hidden="true"
    >
      <path
        d="M12 21s-7-4.5-9.5-9c-1.5-2.7.2-6 3.3-6 2 0 3.4 1 4.2 2.4C10.8 7 12.3 6 14.2 6c3 0 4.8 3.3 3.3 6C19 16.5 12 21 12 21z"
        fill={color}
      />
    </svg>
  );
}

interface TapeProps {
  width?: number;
  height?: number;
  rotate?: number;
  color?: string;
  className?: string;
  style?: CSSProperties;
}

/**
 * Yellow translucent tape strip — used to "stick" polaroids onto the
 * scrapbook background. Render inside a positioned parent and pass
 * `style` with top/left to place it.
 */
export function Tape({
  width = 90,
  height = 22,
  rotate = 0,
  color = "rgba(247, 213, 96, .55)",
  className,
  style,
}: TapeProps) {
  return (
    <div
      aria-hidden="true"
      className={className}
      style={{
        position: "absolute",
        width,
        height,
        background: color,
        transform: `rotate(${rotate}deg)`,
        boxShadow: "inset 0 0 0 1px rgba(255,255,255,.5)",
        ...style,
      }}
    />
  );
}

interface PolaroidProps {
  children: ReactNode;
  rotate?: number;
  caption?: string;
  captionColor?: string;
  padding?: number;
  captionPadding?: number;
  className?: string;
  style?: CSSProperties;
}

/**
 * Polaroid frame — wraps any child (image-slot, ImageSlot, raw `<img>`)
 * in a white paper card with `--shadow-lg` and an optional Caveat
 * caption below. Default rotation 0; pass negative/positive for
 * scrapbook scatter.
 */
export function Polaroid({
  children,
  rotate = 0,
  caption,
  captionColor = "var(--coral-pink)",
  padding = 12,
  captionPadding = 18,
  className,
  style,
}: PolaroidProps) {
  return (
    <div
      className={className}
      style={{
        background: "var(--paper)",
        padding: `${padding}px ${padding}px ${captionPadding}px`,
        boxShadow: "var(--shadow-lg)",
        borderRadius: 6,
        transform: `rotate(${rotate}deg)`,
        display: "inline-block",
        ...style,
      }}
    >
      {children}
      {caption && (
        <div
          style={{
            fontFamily: "var(--font-caveat), cursive",
            fontSize: 22,
            color: captionColor,
            textAlign: "center",
            marginTop: 10,
            transform: "rotate(-1deg)",
            lineHeight: 1,
          }}
        >
          {caption}
        </div>
      )}
    </div>
  );
}

/**
 * Hand-drawn curved arrow — used for "see this" affordance gestures.
 * Defaults point right-down. Override viewBox + path inline if you
 * need a different gesture.
 */
export function ArrowDoodle({
  size = 60,
  color = "var(--lilac-deep)",
  className,
  style,
  ...rest
}: DoodleProps & Omit<SVGProps<SVGSVGElement>, keyof DoodleProps>) {
  return (
    <svg
      width={size}
      height={size * 0.7}
      viewBox="0 0 60 42"
      fill="none"
      className={className}
      style={style}
      aria-hidden="true"
      {...rest}
    >
      <path
        d="M4 8 C 18 4, 32 6, 46 22 C 48 24, 50 28, 50 32"
        stroke={color}
        strokeWidth="2"
        strokeLinecap="round"
        fill="none"
      />
      <path
        d="M46 26 L52 32 L46 38"
        stroke={color}
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
    </svg>
  );
}
