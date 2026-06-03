// Routing constants shared by the API router (server-side parsing) and the web
// composer (client-side 全体 send). One source so the parser and the composer
// never drift on what counts as a broadcast.
//
// F078 (MVP scope): only the two GLOBAL broadcast tokens. Breed-scoped
// (@all-{breed}) and thread-scoped (@本帖 / @全体参与者) group mentions from
// Clowder's full F078 are intentionally NOT ported — our model has 3 flat agents.

/**
 * Global broadcast mention tokens. A user message carrying any of these (as a
 * whole token) routes to ALL available agents at once — the router fans them out
 * in parallel (≥2 targets auto-infer the `ideate`/parallel strategy).
 */
export const BROADCAST_MENTIONS = ['@all', '@全体'] as const;

/** The canonical token the composer prepends for a 全体 (broadcast) send. */
export const BROADCAST_MENTION: string = BROADCAST_MENTIONS[0];
