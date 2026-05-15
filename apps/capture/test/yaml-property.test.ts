// YAML round-trip property test (criterion 18 / spec §13 #18).
//
// [§Y.4 / 2026-05-09] Per spec amendment §Y.4, criterion 18 is
// "YAML round-trip property test (parse → serialize → reparse → deep-equal)
// green via fast-check." The cross-language `js-yaml` ≡ `pyyaml`
// byte-equivalence requirement is dropped: the divergences in string-quoting
// heuristics, line-wrapping, and empty-value rendering require a custom
// emitter (~200-400 LOC) that's high-effort / low-ROI for v0.1. The parity
// oracle covers byte-identity for the canonical fixture, which is what users
// observe; cross-engine equivalence is implementation detail.

import fc from "fast-check";
import { describe, expect, test } from "vitest";
import { dumpYaml, loadYaml } from "../src/packet/yaml.js";

describe("YAML serialization property tests", () => {
  test("round-trip preserves shape for arbitrary nested objects", () => {
    fc.assert(
      fc.property(
        fc.record({
          a: fc.string(),
          b: fc.integer(),
          c: fc.array(fc.string(), { maxLength: 5 }),
          d: fc.record({
            inner: fc.string(),
            n: fc.integer({ min: 0, max: 1000 }),
          }),
        }),
        (obj) => {
          const dumped = dumpYaml(obj);
          const reloaded = loadYaml(dumped) as Record<string, unknown>;
          // Compare structurally (allowing js-yaml's null/undefined coercion).
          expect((reloaded as { a: string }).a).toBe(obj.a);
          expect((reloaded as { b: number }).b).toBe(obj.b);
          expect((reloaded as { c: string[] }).c).toEqual(obj.c);
          expect((reloaded as { d: { inner: string; n: number } }).d).toEqual(obj.d);
        }
      ),
      // [F14 / 2026-05-09] Bumped from 50 → 200 to surface rare divergences
      // (Unicode multi-byte boundaries, line-wrapping at exact 120 chars).
      { numRuns: 200 }
    );
  });

  test("dump options match locked spec (default_flow_style=false)", () => {
    const obj = { a: { b: { c: 1 } } };
    const dumped = dumpYaml(obj);
    // Block style is the only allowed; flow style would surface as `{a: {b: {c: 1}}}`.
    expect(dumped).not.toContain("{");
    expect(dumped).toContain("a:");
  });

  test("sortKeys=false preserves insertion order", () => {
    const obj = { z: 1, a: 2, m: 3 };
    const dumped = dumpYaml(obj);
    const lines = dumped.split("\n");
    expect(lines[0]).toContain("z:");
    expect(lines[1]).toContain("a:");
    expect(lines[2]).toContain("m:");
  });

  test("[F24 / 2026-05-09] loadYaml does NOT coerce hex-prefix strings to numbers (pyyaml-compat float resolver)", () => {
    // js-yaml's default float resolver matches `\d+e\d+` as scientific
    // notation — `86583e01` becomes the number 865830 (8.6583 × 10^5).
    // pyyaml's stricter resolver requires either a decimal point or a
    // signed exponent and so leaves `86583e01` as a string. This
    // divergence silently corrupts string fields whose content is a
    // sha256 hex prefix (≈1/256 probability per snippet).
    //
    // The fix: loadYaml uses a pyyaml-compatible schema that mirrors
    // pyyaml's float-resolver regex. This regression test pins the
    // contract.
    const yamlText = [
      "snippet: 86583e01",
      "another_hex: 1234e56",
      "real_float_with_dot: 1.5",
      "real_float_with_signed_exp: 1.5e+10",
      "plain_int: 42",
      "plain_string: hello",
      "explicit_float_no_dot_unsigned_exp: 1e10",
    ].join("\n");
    const loaded = loadYaml(yamlText) as Record<string, unknown>;
    // Hex-prefix-shaped scalars stay strings (pyyaml-compat behaviour).
    expect(loaded.snippet).toBe("86583e01");
    expect(loaded.another_hex).toBe("1234e56");
    // Real floats still parse as numbers.
    expect(loaded.real_float_with_dot).toBe(1.5);
    expect(loaded.real_float_with_signed_exp).toBe(1.5e10);
    // Plain integers still parse.
    expect(loaded.plain_int).toBe(42);
    // Plain strings still parse.
    expect(loaded.plain_string).toBe("hello");
    // The "1e10" form (no dot, unsigned exponent) is NOT a float in
    // pyyaml — it stays a string. This is the key divergence from
    // js-yaml's default resolver.
    expect(loaded.explicit_float_no_dot_unsigned_exp).toBe("1e10");
  });

  test("[F25 / 2026-05-09] loadYaml matches pyyaml on the over-coercion shapes the cycle-3 review surfaced", () => {
    // The cycle-2 F24 fix tightened the float resolver but its regex
    // overshot pyyaml in three shape families. Cycle-3 verification
    // (PR #7 comment 4412631803) ran `python3 yaml.safe_load` against
    // each of these inputs and observed that pyyaml leaves them as
    // strings; cycle-2's TS regex coerced them to numbers. This test
    // pins the post-cycle-3.5 parity for each divergent shape.
    //
    // Empirical pyyaml outputs (verified by the fix orchestrator
    // running `python3 -c "import yaml; print(yaml.safe_load('value: X'))"`):
    //   1.5e10    -> string '1.5e10'      (decimal-with-dot, unsigned exp)
    //   .5e10     -> string '.5e10'       (leading-dot, unsigned exp)
    //   1e+10     -> string '1e+10'       (no decimal, signed exp)
    //   1e-10     -> string '1e-10'       (no decimal, signed exp)
    //   ++.inf    -> string '++.inf'      (double-sign on inf)
    //   +.nan     -> string '+.nan'       (sign on nan — pyyaml's
    //                                      resolver omits the outer
    //                                      [-+]? for the nan branch)
    //
    // pyyaml's actual regex: shape 1/2 require a SIGNED exponent
    // (`[eE][-+][0-9]+`, not `[-+]?`); there is NO no-decimal exponential
    // shape in pyyaml's regex (cycle-2 invented one); the inf/nan
    // alternations have NO outer `[-+]?` (sign is INSIDE the inf branch
    // only, never the nan branch).
    const yamlText = [
      "decimal_unsigned_exp: 1.5e10",
      "leading_dot_unsigned_exp: .5e10",
      "int_with_signed_pos_exp: 1e+10",
      "int_with_signed_neg_exp: 1e-10",
      "double_sign_inf: ++.inf",
      "signed_nan: +.nan",
      // Verify the matching cases still work (parity sanity).
      "real_decimal_signed_exp: 1.5e+10",
      "real_inf: .inf",
      "real_neg_inf: -.inf",
      "real_nan: .nan",
    ].join("\n");
    const loaded = loadYaml(yamlText) as Record<string, unknown>;
    // The 6 shapes that pyyaml leaves as strings (cycle-3 over-coercion).
    expect(loaded.decimal_unsigned_exp).toBe("1.5e10");
    expect(loaded.leading_dot_unsigned_exp).toBe(".5e10");
    expect(loaded.int_with_signed_pos_exp).toBe("1e+10");
    expect(loaded.int_with_signed_neg_exp).toBe("1e-10");
    expect(loaded.double_sign_inf).toBe("++.inf");
    expect(loaded.signed_nan).toBe("+.nan");
    // The 4 shapes that pyyaml accepts as floats (parity sanity).
    expect(loaded.real_decimal_signed_exp).toBe(1.5e10);
    expect(loaded.real_inf).toBe(Number.POSITIVE_INFINITY);
    expect(loaded.real_neg_inf).toBe(Number.NEGATIVE_INFINITY);
    expect(loaded.real_nan as number).toBeNaN();
  });

  test("round-trip parse(serialize(p)) deep-equals p for a packet-shaped value", () => {
    // [§Y.4 / 2026-05-09] Replaces the previous "matches pyyaml safe_dump on
    // simple input" test, which compared `js-yaml.dump` against `dumpYaml`
    // (both js-yaml-backed) and asserted only structural equality of parsed
    // outputs. That comparison was intra-library and could not detect any
    // real cross-engine divergence; F3 (PR #7 cycle-1) flagged the misleading
    // name. Per §Y.4 the criterion is now round-trip only.
    const obj = {
      x: "hello",
      y: [1, 2, 3],
      z: null,
      nested: { a: "foo", b: ["bar", "baz"] },
      multiline: "line1\nline2\nline3",
      unicode: "héllo wörld 日本",
      empty_str: "",
    };
    const dumped = dumpYaml(obj);
    const reloaded = loadYaml(dumped);
    expect(reloaded).toEqual(obj);
  });
});
