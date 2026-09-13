import { sendEvent } from '@/lib/analytics';
import { EUNENEM_SUPPORT_WHATSAPP_URL } from '@/lib/painelRoutes';

// aperture-7mqsg (item 8) — floating WhatsApp support button, HOMEPAGE ONLY
// (mounted by LandingPage; nothing else renders it). A plain accessible link —
// no nested button, no prefilled text (the visitor writes the message), opens
// the official wa.me URL in a new tab. Geometry/safe-area live in
// tailwind.css under `.wa-fab`.
export const WHATSAPP_FAB_LABEL = 'Falar com a EuNeném pelo WhatsApp';

export function WhatsAppFab() {
  return (
    <a
      className="wa-fab"
      href={EUNENEM_SUPPORT_WHATSAPP_URL}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={WHATSAPP_FAB_LABEL}
      title={WHATSAPP_FAB_LABEL}
      onClick={() => sendEvent('landing_whatsapp_fab_click')}
    >
      {/* WhatsApp glyph — inline, no icon dependency. */}
      <svg viewBox="0 0 24 24" width="28" height="28" aria-hidden="true" focusable="false">
        <path
          fill="currentColor"
          d="M12.04 2C6.58 2 2.13 6.45 2.13 11.91c0 1.75.46 3.45 1.32 4.95L2 22l5.25-1.38a9.9 9.9 0 0 0 4.79 1.22c5.46 0 9.91-4.45 9.91-9.91S17.5 2 12.04 2m0 1.67c4.55 0 8.24 3.7 8.24 8.24 0 4.55-3.69 8.24-8.24 8.24-1.5 0-2.97-.4-4.25-1.17l-.3-.18-3.12.82.83-3.04-.2-.31a8.2 8.2 0 0 1-1.26-4.36c0-4.54 3.7-8.24 8.3-8.24M8.53 7.33c-.16 0-.43.06-.66.31-.22.25-.87.86-.87 2.07 0 1.22.89 2.39 1 2.56.14.17 1.76 2.67 4.25 3.73.59.27 1.05.42 1.41.53.59.19 1.13.16 1.56.1.48-.07 1.46-.6 1.67-1.18.21-.58.21-1.07.15-1.18-.07-.1-.23-.16-.48-.27-.25-.14-1.47-.74-1.69-.82-.23-.08-.37-.12-.56.12-.16.25-.64.81-.78.97-.15.17-.29.19-.53.07-.26-.13-1.06-.39-2-1.23-.74-.66-1.23-1.47-1.38-1.72-.12-.24-.01-.39.11-.5.11-.11.27-.29.37-.44.13-.14.17-.25.25-.41.08-.17.04-.31-.02-.43-.06-.11-.56-1.35-.77-1.84-.2-.48-.4-.42-.56-.43-.14 0-.3-.01-.47-.01"
        />
      </svg>
    </a>
  );
}
