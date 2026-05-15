// @synapti/trail-audit — public API.
//
// Exposes the pure audit() entry point + scanner primitives so other
// callers (e.g., a future GitHub Action variant in v0.2+) can integrate
// without spawning the CLI subprocess. The CLI at cli.ts wires this to
// process I/O and exit codes.

export { audit, type AuditOptions, type AuditResult } from "./audit.js";
export { scanFile, scanText, snippetHash, type Finding } from "./scanner.js";
export {
  isPacketPath,
  listStagedPackets,
  GitStateError,
  type StagedFilesOptions,
} from "./staged.js";
export {
  reportViolations,
  type OutputMode,
  type ReportOptions,
} from "./violations.js";
export {
  EXIT_OK,
  EXIT_GIT_STATE,
  EXIT_PATTERNS,
  EXIT_VIOLATION,
} from "./exit-codes.js";
export { runCli, VERSION, type RunCliDeps } from "./cli.js";
