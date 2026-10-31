import { captureFirstTouch } from './pages/lib/signup-attribution.js';
import { bootstrapClient } from './client-bootstrap.js';

captureFirstTouch(window);
await bootstrapClient();
