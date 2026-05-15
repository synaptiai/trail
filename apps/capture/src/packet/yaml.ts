// YAML serialisation locked for parity with pyyaml.safe_dump(default_flow_style=False,
// sort_keys=False, allow_unicode=True, width=120).
//
// js-yaml's defaults are mostly aligned but several behavioural diffs exist:
//   - js-yaml's CORE_SCHEMA quotes strings differently from pyyaml.SafeDumper.
//   - js-yaml's `noCompatMode: false` (the default — see [F12 / 2026-05-09])
//     keeps backward-compatible scalar emission; setting it to `true` would
//     emit YAML 1.2-only forms that pyyaml's SafeDumper rejects on load.
//     pyyaml uses default_flow_style=False which forces block at top level.
//   - line widths differ in folded scalar emission.
//
// We use js-yaml's default schema with explicit dump options. Cross-engine
// byte parity against pyyaml is OUT OF SCOPE per spec §Y.4 (2026-05-09):
// the round-trip property (parse → serialize → reparse → deep-equal) is the
// v0.1 contract. A custom scalar emitter for byte parity is a v0.2+ task if
// a downstream consumer needs it.
//
// [F24 / 2026-05-09] Cross-engine LOAD parity (input direction):
//   js-yaml's default float resolver matches `\d+e\d+` (no sign on exponent,
//   no decimal point) as YAML 1.1 scientific notation — e.g., `86583e01`
//   becomes the number 865830. pyyaml's resolver requires either a decimal
//   point OR a signed exponent (`+`/`-`), and so leaves `86583e01` as a
//   string. This divergence is observable when TS reads a py-reference-
//   produced YAML containing a hash-prefix snippet that incidentally fits
//   js-yaml's broader regex (sha256 hex prefixes are 8 chars, ~1/256
//   probability of matching `\d+e\d+`).
//
//   `loadYaml` below uses a pyyaml-compatible schema (via `pyyamlFloat`
//   below) that matches pyyaml's stricter float resolver, eliminating the
//   silent string→number coercion for hex-like scalars. Affects
//   redaction.validation_errors[].snippet, pattern_set_version, and any
//   other field whose pyyaml-emitted scalar legitimately looks like a
//   `\d+e\d+` string.

import jsYaml from "js-yaml";

// pyyaml-compatible float resolver. Ported faithfully from pyyaml's
// `Resolver.add_implicit_resolver` for `tag:yaml.org,2002:float`:
//   https://github.com/yaml/pyyaml/blob/main/lib/yaml/resolver.py
//
// PyYAML's actual regex (verified empirically via
// `yaml.SafeLoader.yaml_implicit_resolvers`):
//   ^(?:[-+]?(?:[0-9][0-9_]*)\.[0-9_]*(?:[eE][-+][0-9]+)?
//     |\.[0-9][0-9_]*(?:[eE][-+][0-9]+)?
//     |[-+]?[0-9][0-9_]*(?::[0-5]?[0-9])+\.[0-9_]*
//     |[-+]?\.(?:inf|Inf|INF)
//     |\.(?:nan|NaN|NAN))$
//
// Five shapes:
//   1. `[-+]?\d[\d_]*\.[\d_]*(?:[eE][-+]\d+)?` — decimal-with-dot, optional
//      SIGNED exponent. Crucially the exponent sign is REQUIRED (`[-+]`,
//      not `[-+]?`) — pyyaml rejects `1.5e10` as a float.
//   2. `\.[0-9][0-9_]*(?:[eE][-+]\d+)?` — leading-dot decimal, signed-exp
//      required if present. (Note: NO outer `[-+]?` — pyyaml rejects
//      `+.5` and `-.5` as floats.)
//   3. `[-+]?\d[\d_]*(?::[0-5]?\d)+\.[\d_]*` — sexagesimal/base-60 (YAML 1.1).
//   4. `[-+]?\.(?:inf|Inf|INF)` — signed infinity.
//   5. `\.(?:nan|NaN|NAN)` — NaN. (NO outer `[-+]?` — pyyaml rejects
//      `+.nan` and `-.nan` as floats.)
//
// [F25 / 2026-05-09] Cycle-3 verification surfaced that the prior regex
// over-coerced in shapes pyyaml leaves as strings:
//   - `1.5e10`, `.5e10` (unsigned exponent on decimal-with-dot)
//   - `1e+10`, `1e-10` (NO decimal point — pyyaml has no integer-mantissa
//     exponential shape; the prior regex's shape 2 was a TS-side invention)
//   - `++.inf`, `+.nan` (outer `[-+]?` bled onto the special-value
//     alternations; pyyaml's regex puts the sign INSIDE inf, NOT nan)
// Tightened to literal pyyaml form. Empirical parity verified by the
// regression test in yaml-property.test.ts (F25).
const pyyamlFloat = new jsYaml.Type("tag:yaml.org,2002:float", {
  kind: "scalar",
  resolve: (data: string | null): boolean => {
    if (data === null) return false;
    return /^(?:[-+]?(?:[0-9][0-9_]*)\.[0-9_]*(?:[eE][-+][0-9]+)?|\.[0-9][0-9_]*(?:[eE][-+][0-9]+)?|[-+]?[0-9][0-9_]*(?::[0-5]?[0-9])+\.[0-9_]*|[-+]?\.(?:inf|Inf|INF)|\.(?:nan|NaN|NAN))$/.test(
      data
    );
  },
  construct: (data: string): number => {
    const cleaned = data.replace(/_/g, "");
    if (/^[+]?\.(?:inf|Inf|INF)$/.test(cleaned)) return Number.POSITIVE_INFINITY;
    if (/^-\.(?:inf|Inf|INF)$/.test(cleaned)) return Number.NEGATIVE_INFINITY;
    if (/^\.(?:nan|NaN|NAN)$/.test(cleaned)) return Number.NaN;
    // Sexagesimal (base-60): pyyaml constructs as sum-of-sixties; we
    // fall through to parseFloat which returns NaN. Unlikely in real
    // packet content but if needed, parse manually here.
    return Number.parseFloat(cleaned);
  },
});

// Build a schema identical to DEFAULT_SCHEMA but with pyyaml's stricter
// float resolver in place of js-yaml's broader one. The implicit-type
// list is walked in order and the FIRST resolver to accept wins — so we
// must REMOVE the default float and INSERT our pyyaml float in roughly
// the same position. js-yaml's compiled schema fields are not in the
// public type surface, so we cast through `unknown` to access them.
//
// Failure mode if this cast goes stale (js-yaml major-version bump): the
// regression test at the bottom of the file (and parity-md.test.ts) will
// fail loudly, surfacing the schema-internals breakage at the next test
// run rather than silently shipping the broader resolver.
interface JsYamlSchemaInternals {
  compiledImplicit: { tag: string }[];
  compiledExplicit: jsYaml.Type[];
}
const defaultInternals = jsYaml.DEFAULT_SCHEMA as unknown as JsYamlSchemaInternals;
const filteredImplicit = defaultInternals.compiledImplicit.filter(
  (t) => t.tag !== "tag:yaml.org,2002:float"
) as unknown as jsYaml.Type[];
const strictLoadSchema = new jsYaml.Schema({
  implicit: [...filteredImplicit, pyyamlFloat],
  explicit: defaultInternals.compiledExplicit,
});

export interface DumpOptions {
  width?: number;
}

export function dumpYaml(value: unknown, opts: DumpOptions = {}): string {
  return jsYaml.dump(value, {
    indent: 2,
    flowLevel: -1,
    noCompatMode: false,
    sortKeys: false,
    lineWidth: opts.width ?? 120,
    noRefs: true,
    quotingType: "'",
    forceQuotes: false,
    schema: jsYaml.DEFAULT_SCHEMA,
    skipInvalid: false,
  });
}

export function loadYaml(text: string): unknown {
  return jsYaml.load(text, { schema: strictLoadSchema });
}
