// P3-32: the administrator console's module entry. Kept separate from main.js
// so the HTML carries no inline script and needs no unsafe-inline (§1.15).
import { startAdmin } from './main.js';

void startAdmin({ window: globalThis });
