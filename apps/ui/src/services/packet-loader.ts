/**
 * Packet loader — js-yaml + Ajv schema-validating parser for the v0.1.1
 * PR Change Packet shape.
 *
 * Sprint 3a (gh#9 criterion 7 / 10): the packet view reads from packet YAML.
 * File-path resolution goes through libSQL (`packets.yaml_path`) via the
 * Tauri `read_packet` IPC command (handler in `src-tauri/src/ipc.rs`); the
 * raw YAML text crosses the IPC boundary and is parsed + validated here in
 * TS so the JSON Schema dependency stays in one place.
 *
 * Why TS-side parsing (not Rust):
 *   1. Symmetry with capture (`apps/capture/src/packet/yaml.ts` is also
 *      js-yaml-based; a re-capture chain from capture→UI is library-symmetric).
 *   2. Ajv 2020-draft compile + validate is a battle-tested path; ports to
 *      Rust (jsonschema-rs etc.) introduce their own subtle drift surface
 *      that the v0.1 MVP doesn't pay back yet.
 *   3. Keeps the Rust handler trivial — read file, return text.
 *
 * Strict-load schema:
 *   Mirrors apps/capture/src/packet/yaml.ts: js-yaml's DEFAULT_SCHEMA minus
 *   the broad-float resolver (which silently re-types strings like the
 *   sha256 prefix `2e10` as floats). Phase 1 capture established this as
 *   the cross-engine canonical schema; we reuse it so a packet that round-
 *   trips capture→storage→UI keeps byte-identical interpretation.
 *
 * "No mocks/stubs" honesty (criterion 10):
 *   - js-yaml `load` runs end-to-end, parsing the real fixture / runtime YAML.
 *   - Ajv compiles `schema/pr-change-packet.v0.1.1.schema.json` once at
 *     module init; validation runs on every loaded packet.
 *   - The fixture-fallback path reads the canonical fixture from disk via
 *     fetch (Storybook / Vite dev) — no in-memory test doubles.
 */
import jsYaml from 'js-yaml';
import Ajv2020, { type ValidateFunction } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
// `resolveJsonModule` (tsconfig.base.json:14) gives us typed JSON imports.
// The schema file is the canonical artefact at repo-root; relative path
// from this module is `../../../../schema/...`.
import schemaJson from '../../../../schema/pr-change-packet.v0.1.1.schema.json';

// ---------------------------------------------------------------------------
// Strict load schema — DEFAULT_SCHEMA minus broad-float (parity with capture)
// ---------------------------------------------------------------------------

// The pyyaml-compatible float resolver. Capture uses the same shape in
// apps/capture/src/packet/yaml.ts:60 — mirrored here so a capture→UI round-
// trip keeps byte identity. Re-deriving from js-yaml's compiled internals
// keeps the fields aligned even if upstream tweaks the metadata format.
const pyyamlFloat = new jsYaml.Type('tag:yaml.org,2002:float', {
  kind: 'scalar',
  resolve: (data: unknown) => {
    if (typeof data !== 'string' || data.length === 0) return false;
    // Match pyyaml's stricter regex: an exponent MUST have an explicit sign.
    return /^[-+]?(\d+\.\d*|\.\d+|\d+)([eE][-+]\d+)?$|^[-+]?\.(inf|Inf|INF)$|^\.(nan|NaN|NAN)$/.test(
      data,
    );
  },
  construct: (data: unknown) => {
    if (typeof data !== 'string') return Number.NaN;
    if (data === '.inf' || data === '.Inf' || data === '.INF') return Number.POSITIVE_INFINITY;
    if (data === '+.inf' || data === '+.Inf' || data === '+.INF') return Number.POSITIVE_INFINITY;
    if (data === '-.inf' || data === '-.Inf' || data === '-.INF') return Number.NEGATIVE_INFINITY;
    if (/^\.(nan|NaN|NAN)$/.test(data)) return Number.NaN;
    return parseFloat(data);
  },
  predicate: (obj: unknown): obj is number => typeof obj === 'number',
  represent: (obj: object) => String(obj),
});

interface JsYamlSchemaInternals {
  compiledImplicit: { tag: string }[];
  compiledExplicit: jsYaml.Type[];
}
const defaultInternals = jsYaml.DEFAULT_SCHEMA as unknown as JsYamlSchemaInternals;
const filteredImplicit = defaultInternals.compiledImplicit.filter(
  (t) => t.tag !== 'tag:yaml.org,2002:float',
) as unknown as jsYaml.Type[];
const STRICT_LOAD_SCHEMA = new jsYaml.Schema({
  implicit: [...filteredImplicit, pyyamlFloat],
  explicit: defaultInternals.compiledExplicit,
});

// ---------------------------------------------------------------------------
// Ajv compiled-schema singleton
// ---------------------------------------------------------------------------

let validateFnCached: ValidateFunction | null = null;
function getValidator(): ValidateFunction {
  if (validateFnCached) return validateFnCached;
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  validateFnCached = ajv.compile(schemaJson as object);
  return validateFnCached;
}

// ---------------------------------------------------------------------------
// Packet shape (field-subset Sprint 3a needs — full shape lives in capture's
// types.ts; we mirror only the surface the packet view renders so a future
// schema field addition does not require touching every screen-level usage).
// ---------------------------------------------------------------------------

export type RiskLevel = 'low' | 'med' | 'high' | 'crit';
export type DecisionKind = 'accept' | 'changes' | 'block' | 'reject';

export interface PacketHeaderShape {
  packet_id: string; // ULID
  session_id: string;
  generated_at: string; // ISO 8601
  generator_name: string;
  generator_version: string;
  schema_version: string;
  parent_packet_id: string | null;
  /**
   * Re-capture chain ordinal (1-based). Sprint 3a populates 1 for root
   * captures and `null` when the chain depth is unknown (parent present
   * but the full chain has not been traversed). Sprint 4's libSQL
   * chain-walk will populate the actual ordinal; until then, surfacing
   * a pessimistic null > a fabricated `2` (cycle-1 P1 — fabricating
   * `packet-2` when the actual position could be packet-5 would be a
   * factual error displayed in the header).
   */
  packet_n: number | null;
  /** Whether this packet has a parent_packet_id (i.e., is_recapture). Sprint
   *  3a's RecaptureBanner gate. The boolean is independent of `packet_n` so
   *  the banner shows even when the chain depth is unknown. */
  is_recapture: boolean;
  repository: string;
  branch: string;
}

export interface PacketClaimShape {
  id: string; // CLAIM-NNN
  stable_id?: string; // 16-hex
  text: string;
  evidence_refs: string[];
  evidence_count: number;
  confidence: 'supported' | 'partial' | 'ungrounded';
  /** Effective risk level: reviewer_override > creator_override > agent. Null when no classification recorded. */
  risk_level: RiskLevel | null;
}

export interface ApprovalTrailEntryShape {
  claim_id: string;
  decision: DecisionKind;
  reason: string | null;
  by: string;
  at: string; // ISO 8601
}

export interface RiskHistogramShape {
  low: number;
  med: number;
  high: number;
  crit: number;
  /** Convenience total — matches the claim count when all claims are classified, else < claim count. */
  classified_total: number;
}

// ---------------------------------------------------------------------------
// Sprint 3b: diff_summary + redaction_audit projections
// ---------------------------------------------------------------------------

/** One excerpt slice from a tool-use input field (schema/$defs/excerpt). */
export interface ExcerptShape {
  /** "before"/"after" for Edit/Write; "before#N"/"after#N" for MultiEdit. */
  kind: string;
  /** Excerpt text (≤1300 chars after elision marker). */
  text: string;
  /** True if the original was clipped during capture. */
  elided: boolean;
}

/** One semantic change entry (schema/$defs/semantic_change). */
export interface SemanticChangeShape {
  /** Stable ID, format DIFF-NNN. */
  id: string;
  /** Human-readable description (e.g., "Edited path/to/file.ts"). */
  description: string;
  /**
   * ALWAYS single-element array per schema (one file per DIFF). We expose
   * the array so future schema changes that relax this constraint do not
   * require a UI port; today the renderer reads files[0].
   */
  files: string[];
  /** Locked enum: write/edit/multiedit. */
  operation: 'write' | 'edit' | 'multiedit';
  /** Excerpt slices (before/after for Edit/Write; before#N/after#N for MultiEdit). */
  excerpts: ExcerptShape[];
}

export interface DiffSummaryShape {
  base_sha: string;
  head_sha: string;
  files_changed: number;
  lines_added: number;
  lines_deleted: number;
  modules_touched: string[];
  semantic_changes: SemanticChangeShape[];
}

/**
 * One row from agent_session.redaction_metadata.redactions_by_pattern,
 * lifted into a UI-friendly array so the Redaction tab can render directly
 * without re-walking the source object. Sprint 3b reads from agent_session
 * (always present per schema); the broader redaction_audit detail (per-layer
 * × per-pattern with locations) is deferred to Sprint 4's M3 modal.
 */
export interface RedactionPatternRowShape {
  pattern_name: string;
  count: number;
}

export interface RedactionSummaryShape {
  /** From bin/trail-redaction-patterns.yml (REQUIRED non-empty per schema). */
  pattern_set_version: string;
  /** "bundled" when default trail-redaction-patterns.yml; else override identifier. */
  pattern_set_origin?: string;
  /** Total redactions across all captured fields. */
  redactions_applied: number;
  /** Per-pattern counts, sorted alphabetically by pattern_name (UI-stable). */
  by_pattern: RedactionPatternRowShape[];
  /** Schema-validation errors raised by the redaction pipeline; SHOULD be empty. */
  validation_errors: string[];
}

/**
 * One entry from packet.posted_to_pr[] (schema AB-2 / Phase 3b). Sprint 5
 * (gh#12 AC-5, AC-6) reads this for re-post detection in the M4 modal —
 * the most-recent entry tells M4 it's a re-post and surfaces the
 * destination so the user can compare against the freshly-detected one
 * (B6 P1 hardening).
 */
export interface PostedToPrEntryShape {
  pr_url: string;
  pr_number: number;
  /** sha256 hex (64 chars) of the posted markdown. AC-5 tamper detection. */
  body_hash: string;
  /** ISO 8601 (+00:00 suffix per schema). */
  posted_at: string;
  posted_by: string;
}

export interface LoadedPacket {
  header: PacketHeaderShape;
  claims: PacketClaimShape[];
  histogram: RiskHistogramShape;
  approval_trail: ApprovalTrailEntryShape[];
  /** Sprint 3b: diff_summary projection for the Diff tab. */
  diff_summary: DiffSummaryShape;
  /** Sprint 3b: redaction summary for the Redaction tab (B4 §4.5). */
  redaction_summary: RedactionSummaryShape;
  /**
   * Sprint 5 (gh#12 AC-6): posted_to_pr[] entries surfaced for the M4
   * modal's re-post differentiation. Sorted by posted_at desc; first
   * entry is the most-recent. Empty array on first post.
   */
  posted_to_pr: PostedToPrEntryShape[];
  /** Source path of the loaded YAML (for UI diagnostics + tamper-warning surfaces). */
  source_path: string;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type PacketLoadError =
  | { kind: 'yaml-parse-failed'; message: string }
  | { kind: 'schema-rejected'; errors: string[]; message: string }
  | { kind: 'shape-mismatch'; field: string; message: string };

export class PacketLoadException extends Error {
  readonly inner: PacketLoadError;
  constructor(inner: PacketLoadError) {
    super(inner.message);
    this.inner = inner;
  }
}

// ---------------------------------------------------------------------------
// Risk priority (criterion 1's effective level — same precedence as Rust db.rs:144-147)
// ---------------------------------------------------------------------------

interface RiskClassificationRaw {
  agent?: { level?: RiskLevel | null } | null;
  creator_override?: { level?: RiskLevel | null } | null;
  reviewer_override?: { level?: RiskLevel | null } | null;
}

export function effectiveRiskLevel(rc: RiskClassificationRaw | undefined | null): RiskLevel | null {
  if (!rc) return null;
  const reviewer = rc.reviewer_override?.level ?? null;
  if (reviewer) return reviewer;
  const creator = rc.creator_override?.level ?? null;
  if (creator) return creator;
  const agent = rc.agent?.level ?? null;
  if (agent) return agent;
  return null;
}

// ---------------------------------------------------------------------------
// Public: parse + validate raw YAML text
// ---------------------------------------------------------------------------

export function parsePacketYaml(yamlText: string, sourcePath: string): LoadedPacket {
  let raw: unknown;
  try {
    raw = jsYaml.load(yamlText, { schema: STRICT_LOAD_SCHEMA });
  } catch (err) {
    throw new PacketLoadException({
      kind: 'yaml-parse-failed',
      message: `Failed to parse packet YAML at ${sourcePath}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    });
  }
  if (!raw || typeof raw !== 'object') {
    throw new PacketLoadException({
      kind: 'yaml-parse-failed',
      message: `Packet YAML at ${sourcePath} did not parse to an object (got ${typeof raw})`,
    });
  }

  const validate = getValidator();
  if (!validate(raw)) {
    const errs = (validate.errors ?? []).map(
      (e) => `${e.instancePath || '(root)'}: ${e.message ?? '(no message)'}`,
    );
    throw new PacketLoadException({
      kind: 'schema-rejected',
      errors: errs,
      message: `Packet at ${sourcePath} failed schema validation (${errs.length} error${
        errs.length === 1 ? '' : 's'
      }): ${errs.slice(0, 3).join('; ')}${errs.length > 3 ? ` (+${errs.length - 3} more)` : ''}`,
    });
  }

  // Cast is safe — Ajv just verified the v0.1.1 shape. We still narrow each
  // field carefully on access to keep the runtime contract honest (per N15:
  // verification beyond smoke).
  const packet = raw as {
    _meta: {
      packet_id: string;
      generated_at: string;
      generator: { name: string; version: string };
      capture_method: string;
      parent_packet_id: string | null;
    };
    packet_version: string;
    pr: { repository: string; branch: string };
    agent_session: {
      session_id: string;
      redaction_metadata: {
        pattern_set_version: string;
        pattern_set_origin?: string;
        redactions_applied: number;
        redactions_by_pattern: Record<string, number>;
        // schema/$defs/redaction_validation_error: { pattern, snippet } where
        // snippet is sha256(match).hexdigest()[:8] (a privacy-preserving
        // fingerprint, NOT the raw match). Sprint 3b's UI renders this as
        // a single line per error: "{pattern} matched (sha256:{snippet})".
        validation_errors?: Array<{ pattern: string; snippet: string }>;
      };
    };
    summary: { claims: Array<RawClaim> };
    approval_trail?: Array<RawApprovalEntry>;
    diff_summary: {
      base_sha: string;
      head_sha: string;
      files_changed: number;
      lines_added: number;
      lines_deleted: number;
      modules_touched: string[];
      semantic_changes: Array<RawSemanticChange>;
    };
    posted_to_pr?: Array<RawPostedToPrEntry>;
  };

  const header: PacketHeaderShape = {
    packet_id: packet._meta.packet_id,
    session_id: packet.agent_session.session_id,
    generated_at: packet._meta.generated_at,
    generator_name: packet._meta.generator.name,
    generator_version: packet._meta.generator.version,
    schema_version: packet.packet_version,
    parent_packet_id: packet._meta.parent_packet_id ?? null,
    // Honest about chain depth:
    //   - root capture (no parent) → packet_n = 1
    //   - non-root → packet_n = null (depth unknown until Sprint 4 walks the chain)
    // The PacketHeader UI surfaces "re-captured" when packet_n is null AND
    // is_recapture is true; it shows "packet-1" only for confirmed root.
    // This avoids the cycle-1 P1 trap of fabricating packet-2 for what
    // could be packet-5.
    packet_n: packet._meta.parent_packet_id ? null : 1,
    is_recapture: packet._meta.parent_packet_id !== null && packet._meta.parent_packet_id !== undefined,
    repository: packet.pr.repository,
    branch: packet.pr.branch,
  };

  // exactOptionalPropertyTypes: only spread `stable_id` when present so the
  // shape never carries an `undefined` value the consumer would have to
  // pre-empt with a typeof-check. The schema marks stable_id optional and
  // the canonical fixture populates it; this branch keeps both shapes valid.
  const claims: PacketClaimShape[] = packet.summary.claims.map((c) => {
    const base: PacketClaimShape = {
      id: c.id,
      text: c.text,
      evidence_refs: c.evidence_refs,
      evidence_count: c.evidence_refs.length,
      confidence: c.confidence,
      risk_level: effectiveRiskLevel(c.risk_classification ?? null),
    };
    return c.stable_id ? { ...base, stable_id: c.stable_id } : base;
  });

  const histogram: RiskHistogramShape = { low: 0, med: 0, high: 0, crit: 0, classified_total: 0 };
  for (const c of claims) {
    if (c.risk_level) {
      histogram[c.risk_level] += 1;
      histogram.classified_total += 1;
    }
  }

  // Approval trail comes through verbatim. Schema already validated decision
  // is one of accept/changes/block/reject; entries[].claim_id resolves to a
  // claim in this packet by id OR stable_id (cross-reference rule per
  // schema/$defs/approval_trail_entry — Phase 1 capture leaves the array
  // empty and the cross-reference pass therefore trivially holds).
  const approvalTrail: ApprovalTrailEntryShape[] = (packet.approval_trail ?? []).map((e) => ({
    claim_id: e.claim_id,
    decision: e.decision,
    reason: e.reason ?? null,
    by: e.by,
    at: e.at,
  }));

  // Sprint 3b: diff_summary projection. Schema validated the shape; we copy
  // the typed surface so the UI never has to re-walk the raw object.
  const diffSummary: DiffSummaryShape = {
    base_sha: packet.diff_summary.base_sha,
    head_sha: packet.diff_summary.head_sha,
    files_changed: packet.diff_summary.files_changed,
    lines_added: packet.diff_summary.lines_added,
    lines_deleted: packet.diff_summary.lines_deleted,
    modules_touched: [...packet.diff_summary.modules_touched],
    semantic_changes: packet.diff_summary.semantic_changes.map((sc) => ({
      id: sc.id,
      description: sc.description,
      files: [...sc.files],
      operation: sc.operation,
      excerpts: sc.excerpts.map((ex) => ({
        kind: ex.kind,
        text: ex.text,
        elided: ex.elided,
      })),
    })),
  };

  // Sprint 3b: redaction summary projection. Sort by_pattern alphabetically so
  // the UI surface is deterministic even if the YAML emits the map in
  // insertion order (the schema does not lock map ordering for v0.1.1, only
  // for the redaction_audit array).
  const rm = packet.agent_session.redaction_metadata;
  const byPattern: RedactionPatternRowShape[] = Object.entries(rm.redactions_by_pattern)
    .map(([pattern_name, count]) => ({ pattern_name, count }))
    .sort((a, b) => a.pattern_name.localeCompare(b.pattern_name));
  // schema/$defs/redaction_validation_error: each entry is
  // `{ pattern, snippet }` where `snippet` is sha256(match).hexdigest()[:8]
  // (a privacy-preserving fingerprint, NEVER the raw match). The UI
  // surfaces them as one-liners that a reviewer can grep against the
  // pattern catalog without leaking sensitive content.
  const validationErrors: string[] = (rm.validation_errors ?? []).map(
    (v) => `${v.pattern} matched (sha256:${v.snippet})`,
  );
  const redactionSummary: RedactionSummaryShape = {
    pattern_set_version: rm.pattern_set_version,
    ...(rm.pattern_set_origin ? { pattern_set_origin: rm.pattern_set_origin } : {}),
    redactions_applied: rm.redactions_applied,
    by_pattern: byPattern,
    validation_errors: validationErrors,
  };

  // Sprint 5 (gh#12 AC-6): posted_to_pr[] projection for re-post detection
  // in the M4 modal. Schema marks the array optional (Phase 1 capture
  // never emits it; Phase 3b's `trail packet post` appends entries). Sort
  // descending by posted_at so [0] is the most-recent entry — that drives
  // the M4 "previously posted to" line + destination-changed glyph.
  const rawPostedTo: RawPostedToPrEntry[] = packet.posted_to_pr ?? [];
  const postedToPr: PostedToPrEntryShape[] = rawPostedTo
    .map((e) => ({
      pr_url: e.pr_url,
      pr_number: e.pr_number,
      body_hash: e.body_hash,
      posted_at: e.posted_at,
      posted_by: e.posted_by,
    }))
    .sort((a, b) => b.posted_at.localeCompare(a.posted_at));

  return {
    header,
    claims,
    histogram,
    approval_trail: approvalTrail,
    diff_summary: diffSummary,
    redaction_summary: redactionSummary,
    posted_to_pr: postedToPr,
    source_path: sourcePath,
  };
}

interface RawPostedToPrEntry {
  pr_url: string;
  pr_number: number;
  body_hash: string;
  posted_at: string;
  posted_by: string;
}

interface RawClaim {
  id: string;
  stable_id?: string;
  text: string;
  evidence_refs: string[];
  confidence: 'supported' | 'partial' | 'ungrounded';
  risk_classification?: RiskClassificationRaw;
}

interface RawApprovalEntry {
  claim_id: string;
  decision: DecisionKind;
  reason: string | null;
  by: string;
  at: string;
}

interface RawSemanticChange {
  id: string;
  description: string;
  files: string[];
  operation: 'write' | 'edit' | 'multiedit';
  excerpts: Array<{ kind: string; text: string; elided: boolean }>;
}

// ---------------------------------------------------------------------------
// IPC + fixture-fallback bridge — Sprint 3a's only consumer
// ---------------------------------------------------------------------------

/**
 * Loads a packet by ID through the Tauri `read_packet` IPC command. The
 * Rust handler queries libSQL `packets.yaml_path` and reads the YAML text
 * from disk; this function then runs the TS-side parse + Ajv validate.
 *
 * Throws `PacketLoadException` on parse / validation failure;
 * IpcInvocationError surfaces unchanged when the IPC layer rejects the
 * request (not-found, tamper-detected, permission-denied, etc.).
 */
export async function loadPacketViaIpc(
  packetId: string,
  // Indirection so unit tests can pass a fake invoke without spinning up
  // the Tauri runtime. Default = the production typed invoke wrapper.
  invokeFn?: (
    cmd: 'read_packet',
    args: { packet_id: string },
  ) => Promise<{ packet_id: string; schema_version: string; yaml_text: string; yaml_path: string }>,
): Promise<LoadedPacket> {
  const fn =
    invokeFn ??
    (async (_cmd: 'read_packet', args: { packet_id: string }) => {
      const { invoke } = await import('@/ipc/client');
      return invoke('read_packet', args) as Promise<{
        packet_id: string;
        schema_version: string;
        yaml_text: string;
        yaml_path: string;
      }>;
    });
  const resp = await fn('read_packet', { packet_id: packetId });
  return parsePacketYaml(resp.yaml_text, resp.yaml_path);
}

/**
 * Dev-fallback loader: reads a packet YAML directly from a fetch URL. Used
 * by Storybook and the in-browser dev mode where the Tauri bridge is
 * absent. The fixture path is repository-relative; Vite serves it through
 * the dev server's static-file pipeline.
 */
export async function loadPacketViaFetch(url: string): Promise<LoadedPacket> {
  const resp = await fetch(url);
  if (!resp.ok) {
    throw new PacketLoadException({
      kind: 'yaml-parse-failed',
      message: `Failed to fetch packet YAML at ${url}: HTTP ${resp.status}`,
    });
  }
  const text = await resp.text();
  return parsePacketYaml(text, url);
}
