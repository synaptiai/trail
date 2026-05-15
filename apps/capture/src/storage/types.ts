// StorageWriter interface — locked per Appendix A R-COUPLING-03.

import type {
  Claim,
  Command,
  Packet,
  RedactionMetadata,
  SemanticChange,
  TestEntry,
} from "../packet/types.js";

export type RedactionAudit = RedactionMetadata;

export type Evidence =
  | (SemanticChange & { kind: "DIFF" })
  | (Command & { kind: "CMD" })
  | (TestEntry & { kind: "TEST" })
  | { kind: "PROMPT"; id: string; text: string };

export interface StorageWriter {
  writePacket(
    packet: Packet,
    redactionAudit: RedactionAudit,
    claims: Claim[],
    evidence: Evidence[]
  ): Promise<void>;
}
