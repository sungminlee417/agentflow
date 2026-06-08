// Suppresses the AI SDK's per-call "specificationVersion compatibility mode"
// warning. We have ai@5 + ai@6 both installed transitively (different
// packages pull different versions), so the Anthropic provider runs in
// v2 compat mode. The warning is correct but it's logged per call —
// noisy on routes like /api/inbox/pull that fire many drafts in
// parallel. Suppressing is safe; functionally everything works.

declare const globalThis: { AI_SDK_LOG_WARNINGS?: boolean };
globalThis.AI_SDK_LOG_WARNINGS = false;
export {};
