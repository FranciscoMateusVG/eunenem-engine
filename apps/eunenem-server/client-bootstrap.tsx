import { StrictMode, type ComponentType, createElement } from 'react';
import { hydrateRoot } from 'react-dom/client';
import {
  type BrowserErrorCapture,
  initializeBrowserErrorCapture,
} from './pages/lib/browser-errors.js';

interface ClientAppModule {
  readonly App: ComponentType<{ pathname: string }>;
  readonly resolveRoute: (pathname: string) => { readonly kind: string };
}

interface ClientBootstrapOptions {
  readonly document?: Pick<Document, 'getElementById'>;
  readonly targetWindow?: Window;
  readonly hydrate?: typeof hydrateRoot;
  readonly loadApp?: () => Promise<ClientAppModule>;
  readonly createErrorCapture?: (
    config: Window['__EUNENEM_ENV__'],
    options: { readonly target: Window },
  ) => BrowserErrorCapture;
}

export async function bootstrapClient(options: ClientBootstrapOptions = {}): Promise<void> {
  const targetWindow = options.targetWindow ?? window;
  const targetDocument = options.document ?? document;
  const capture = (options.createErrorCapture ?? initializeBrowserErrorCapture)(
    targetWindow.__EUNENEM_ENV__,
    { target: targetWindow },
  );
  const root = targetDocument.getElementById('root');
  if (!root) {
    const error = new Error('client root unavailable');
    capture.capture('bootstrap', error);
    throw error;
  }

  let appModule: ClientAppModule;
  try {
    appModule = await (options.loadApp ?? (() => import('./pages/App.js')))();
  } catch (error) {
    capture.capture('bootstrap', error);
    throw error;
  }

  const pathname = targetWindow.location.pathname;
  capture.setRouteKind(appModule.resolveRoute(pathname).kind);
  try {
    (options.hydrate ?? hydrateRoot)(
      root,
      createElement(
        StrictMode,
        null,
        createElement(appModule.App, { pathname }),
      ),
      {
        onCaughtError: capture.onCaughtError,
        onRecoverableError: capture.onRecoverableError,
        onUncaughtError: capture.onUncaughtError,
      },
    );
  } catch (error) {
    capture.capture('bootstrap', error);
    throw error;
  }
}
