// @synapti/trail-capture — public API.

export { generate, type GenerateOptions, type GenerateResult } from "./generate.js";
export type { Packet, Claim, RedactionMetadata, RedactionValidationError } from "./packet/types.js";
export { generateUlid, ULID_RE } from "./packet/ulid.js";
export { deriveStableId } from "./packet/stable-id.js";
export { stripUserinfo, parseRemoteToOwnerRepo } from "./git/url.js";
export { Redactor } from "./redaction/layer1.js";
export { scanLayer2, snippetHash } from "./redaction/layer2.js";
export {
  loadPatterns,
  PatternLoadError,
  defaultBundledPatternsPath,
  resetPatternCache,
  type CompiledPattern,
  type PatternLoadResult,
} from "./redaction/patterns.js";
export { dumpYaml, loadYaml } from "./packet/yaml.js";
export { detectRecapture } from "./packet/recapture.js";
export { renderMarkdown } from "./render/markdown.js";
export { extract, type ExtractData } from "./extract/extract.js";
export { synthesizeMechanical } from "./claims/mechanical.js";
export { synthesizeLlm, buildLlmPrompt, spawnClaudeRunner, type LlmRunner } from "./claims/llm.js";
export { buildPacket } from "./packet/build.js";
export { validateStructural, SchemaValidatorInternalError } from "./packet/validate-schema.js";
export { validateRefs } from "./packet/validate-refs.js";
export { atomicWrite } from "./io/atomic.js";
export {
  installSignalHandlers,
  signalCleanupHandle,
  trackSubprocess,
  untrackSubprocess,
  resetSignalState,
} from "./io/signals.js";
export type { StorageWriter, Evidence, RedactionAudit } from "./storage/types.js";
export { NoopStorageWriter } from "./storage/noop.js";
export { SqliteStorageWriter, StorageUnavailableError } from "./storage/sqlite.js";
export { VERSION, SCHEMA_URL } from "./version.js";
export {
  EXIT_OK,
  EXIT_GENERIC,
  EXIT_TRANSCRIPT_NOT_FOUND,
  EXIT_GIT_STATE,
  EXIT_PATTERNS,
  EXIT_VALIDATION,
  EXIT_WRITE,
  EXIT_LLM_STRICT,
  EXIT_INVALID_ARGS,
  EXIT_CONCURRENT,
  EXIT_SIGINT,
  EXIT_SIGTERM,
} from "./exit-codes.js";
