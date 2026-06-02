// M8 entry point — ONLY builds the app and listens.
//
// FORBIDDEN to `new` any service here (CLAUDE.md / PROJECT_SPEC M8): all wiring
// lives in buildApp() so e2e/tests can inject fakes + a temp db. This file just
// reads the host/port from the environment (no hardcoded values — CLAUDE.md §2.1)
// and starts listening.

import { buildApp } from '@choco/api/app-factory';

/** Default listen port when PORT is unset. */
const DEFAULT_PORT = 3000;
/** Default bind host when HOST is unset. */
const DEFAULT_HOST = '0.0.0.0';

async function main(): Promise<void> {
  const port = Number.parseInt(process.env['PORT'] ?? '', 10);
  const host = process.env['HOST'] ?? DEFAULT_HOST;
  const { api } = buildApp();
  await api.listen({
    port: Number.isFinite(port) && port > 0 ? port : DEFAULT_PORT,
    host,
  });
}

void main();
