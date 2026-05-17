// Ajv structural validation against schema/pr-change-packet.v0.1.1.schema.json.
// The schema is loaded once per process from the repo-relative path; for tests
// the loader can be overridden.

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import addFormats from "ajv-formats";
import Ajv2020 from "ajv/dist/2020.js";
import type { Packet } from "./types.js";

export interface ValidationIssue {
  kind: "structural" | "refs" | "internal";
  path: string;
  message: string;
}

export class SchemaValidatorInternalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SchemaValidatorInternalError";
  }
}

let cached:
  | { validate: (data: unknown) => boolean; getErrors: () => ValidationIssue[] }
  | undefined;

// Schema path candidates relative to `import.meta.url` of THIS file
// (validate-schema.{js,ts}). Probed in order; first existing path wins.
//
// Two layouts must work:
//   - PRODUCTION (npm install, `node dist/cli.js`): file is at
//     dist/packet/validate-schema.js → `../schema/...` = dist/schema/...
//     (scripts/copy-bin.mjs copies canonical schema/ → dist/schema/ at build).
//   - TESTS (vitest running TS via ts-loader): file is at
//     apps/capture/src/packet/validate-schema.ts → `../../../../schema/...`
//     = repo-root schema/... (the canonical authoring location).
//
// rc.5 hard-coded only the test path; every npm-installed `generate` hit
// SchemaValidatorInternalError (DF-S1). Fixed in rc.6 via probe + fallback.
const SCHEMA_CANDIDATES = [
  "../schema/pr-change-packet.v0.1.1.schema.json", // production / dist
  "../../../../schema/pr-change-packet.v0.1.1.schema.json", // tests / src
];

export function defaultSchemaPath(): string {
  for (const rel of SCHEMA_CANDIDATES) {
    const p = resolve(fileURLToPath(new URL(rel, import.meta.url)));
    if (existsSync(p)) {
      return p;
    }
  }
  // No candidate exists. Return the production path so the downstream
  // ENOENT message points at the production layout the user can actually
  // act on (reinstall, file an issue, etc.).
  return resolve(fileURLToPath(new URL(SCHEMA_CANDIDATES[0]!, import.meta.url)));
}

export function compileSchema(schemaPath?: string) {
  if (cached) return cached;
  const path = schemaPath ?? defaultSchemaPath();
  let schemaText: string;
  try {
    schemaText = readFileSync(path, "utf-8");
  } catch (err) {
    throw new SchemaValidatorInternalError(
      `cannot read JSON Schema at ${path}: ${(err as Error).message}`
    );
  }
  let schema: object;
  try {
    schema = JSON.parse(schemaText);
  } catch (err) {
    throw new SchemaValidatorInternalError(
      `cannot parse JSON Schema at ${path}: ${(err as Error).message}`
    );
  }

  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  let validateFn: ReturnType<typeof ajv.compile>;
  try {
    validateFn = ajv.compile(schema);
  } catch (err) {
    throw new SchemaValidatorInternalError(`Ajv compile failed: ${(err as Error).message}`);
  }

  let lastErrors: ValidationIssue[] = [];

  return (cached = {
    validate(data: unknown): boolean {
      const ok = validateFn(data);
      if (ok) {
        lastErrors = [];
        return true;
      }
      lastErrors = (validateFn.errors ?? []).map((e) => ({
        kind: "structural",
        path: e.instancePath || e.schemaPath || "",
        message: `${e.instancePath || "(root)"}: ${e.message ?? "(no message)"}`,
      }));
      return false;
    },
    getErrors(): ValidationIssue[] {
      return lastErrors;
    },
  });
}

export function validateStructural(packet: Packet, schemaPath?: string): ValidationIssue[] {
  const v = compileSchema(schemaPath);
  if (v.validate(packet)) return [];
  return v.getErrors();
}

export function resetSchemaCache(): void {
  cached = undefined;
}
