// aperture-d0x1w — client-side mirror of engine domain constants.
//
// The engine ships `ID_PLATAFORMA_EUNENEM` (and `_EUCASEI`) as seeded
// platform UUIDs from `src/adapters/plataforma/repository.memory.ts`. The
// client needs the same value to scope auth calls.
//
// We mirror the constant here instead of importing the engine module
// directly because the engine pulls in server-only deps (`pg`, `kysely`,
// `better-auth`) that we don't want bundled into the browser. If the
// engine ever publishes a `frame/constants` browser-safe entry point, swap
// to that.
//
// IF YOU CHANGE THIS VALUE, CHANGE IT IN THE ENGINE TOO
// (`src/adapters/plataforma/repository.memory.ts`).

export const ID_PLATAFORMA_EUNENEM = "11111111-1111-4111-8111-111111111111";
export const ID_PLATAFORMA_EUCASEI = "22222222-2222-4222-8222-222222222222";
