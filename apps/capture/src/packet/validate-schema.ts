// Ajv structural validation against schema/pr-change-packet.v0.1.1.schema.json.
// The schema is loaded once per process from the repo-relative path; for tests
// the loader can be overridden.

import { readFileSync } from "node:fs";
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

export function defaultSchemaPath(): string {
  // The schema lives at repo-root/schema/pr-change-packet.v0.1.1.schema.json
  // Resolve from this file: apps/capture/src/packet/validate-schema.ts ->
  // ../../../../schema/pr-change-packet.v0.1.1.schema.json
  return resolve(
    fileURLToPath(
      new URL("../../../../schema/pr-change-packet.v0.1.1.schema.json", import.meta.url)
    )
  );
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
