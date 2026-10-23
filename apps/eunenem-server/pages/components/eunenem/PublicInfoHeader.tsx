import { EUNENEM_SUPPORT_WHATSAPP_URL } from '@/lib/painelRoutes';

/** Shared public information-page header, originally used by the FAQ. */
export function PublicInfoHeader({ onContactClick }: { onContactClick?: () => void }) {
  return (
    <>
      <style>{HEADER_CSS}</style>
      <header className="faq-topbar">
        <div className="faq-topbar-inner">
          <a className="faq-logo" href="/" aria-label="EuNeném — início">
            <img src="/public/logo-landing.png" alt="EuNeném" className="faq-logo-img" />
          </a>
          <nav className="faq-nav-right">
            <a
              className="faq-nav-link"
              href={EUNENEM_SUPPORT_WHATSAPP_URL}
              onClick={onContactClick}
            >
              falar conosco
            </a>
          </nav>
        </div>
      </header>
    </>
  );
}

const HEADER_CSS = `
/* topbar */
.faq-topbar{position:sticky;top:0;z-index:50;background:rgba(248,247,246,.78);backdrop-filter:blur(14px) saturate(1.2);-webkit-backdrop-filter:blur(14px) saturate(1.2);border-bottom:1px solid var(--line);}
.faq-topbar-inner{max-width:1080px;margin:0 auto;padding:12px 26px;display:flex;align-items:center;justify-content:space-between;gap:16px;}
.faq-logo{display:inline-flex;align-items:center;text-decoration:none;}
.faq-logo-img{height:54px;width:auto;background:rgba(255,255,255,.95);padding:6px 12px;border-radius:14px;}
.faq-nav-right{display:flex;align-items:center;gap:18px;}
.faq-nav-link{font-size:12px;color:var(--ink-soft);text-decoration:none;text-transform:uppercase;letter-spacing:.12em;font-weight:600;min-height:44px;display:inline-flex;align-items:center;}
.faq-nav-link:hover{color:var(--plum);}

@media(max-width: 400px){
  .faq-topbar-inner{padding:12px 18px;gap:10px;}
  .faq-logo-img{height:48px;padding:6px;}
  .faq-nav-link{font-size:11px;letter-spacing:.05em;min-height:44px;display:inline-flex;align-items:center;}
}
`;
