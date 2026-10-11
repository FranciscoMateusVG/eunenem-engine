import { useEffect } from 'react';
import { LandingPage } from './LandingPage.js';
import { useAuthModal } from './components/eunenem/auth/AuthModalProvider.js';
import { useMe } from './lib/auth.js';
import { postLoginTarget } from './lib/post-login-route.js';

/** Compatibility entry for old /login links, owned entirely by Engine 2.0. */
export function LoginPage() {
  const me = useMe();
  const { open } = useAuthModal();

  useEffect(() => {
    if (me.isPending) return;
    if (me.data?.slug) {
      // Keep onboarding/legacy precedence. next/redirect are deliberately inert:
      // this entry does not introduce a second post-login return contract.
      window.location.replace(postLoginTarget(me.data));
    } else {
      open('signin');
    }
  }, [me.isPending, me.data, open]);

  return <LandingPage />;
}
