/**
 * Design system entrypoint.
 *
 * Re-exports the typed token map plus shared types so components import from a
 * single path. Tokens are the source of truth; CSS variables are codegen.
 */
export { tokens } from './tokens.js';
export type { Tokens, RiskLevel, Theme, TypeToken } from './tokens.js';
