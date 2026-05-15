// Markdown render. Spec Appendix C. Mirrors py-reference/cli/render.py.
// Parity-tested per §10. Output joined with "\n" — no trailing newline (matches
// py-reference's "\n".join behaviour).

import type { ApprovalTrailEntry, Packet } from "../packet/types.js";

export interface RenderOptions {
  packetPath: string;
}

function fenceOpen(lang = ""): string {
  return lang ? `\`\`\`${lang}` : "```";
}

const FENCE_CLOSE = "```";

function langFor(filePath: string): string {
  const p = filePath.toLowerCase();
  if (p.endsWith(".py")) return "python";
  if (p.endsWith(".yml") || p.endsWith(".yaml")) return "yaml";
  if (p.endsWith(".md")) return "markdown";
  if (p.endsWith(".json")) return "json";
  if (p.endsWith(".js") || p.endsWith(".jsx")) return "javascript";
  if (p.endsWith(".ts") || p.endsWith(".tsx")) return "typescript";
  if (p.endsWith(".sh")) return "bash";
  if (p.endsWith(".rs")) return "rust";
  if (p.endsWith(".go")) return "go";
  return "";
}

function renderExcerpts(
  excerpts: { kind: string; text: string; elided: boolean }[],
  lang: string
): string[] {
  const out: string[] = [];
  for (const ex of excerpts) {
    const kind = ex.kind ?? "?";
    const text = ex.text ?? "";
    const elided = ex.elided ?? false;
    const marker = kind.startsWith("before") ? "−" : "+";
    const label = `${marker} ${kind}${elided ? " *(elided)*" : ""}`;
    out.push(`_${label}_`);
    out.push(fenceOpen(lang));
    out.push(text);
    out.push(FENCE_CLOSE);
    out.push("");
  }
  return out;
}

// Python repr() emits a string with single quotes by default and switches to
// double quotes only when the string contains a single quote without a double
// quote. Inside the chosen quote, backslash and the quote char are escaped;
// non-printables use \xHH or \n / \t / \r etc. We implement the subset that
// covers Phase 1 fixture output.
function pyRepr(s: string): string {
  const hasSingle = s.includes("'");
  const hasDouble = s.includes('"');
  const useDouble = hasSingle && !hasDouble;
  const quote = useDouble ? '"' : "'";
  let out = quote;
  for (const ch of s) {
    const code = ch.codePointAt(0)!;
    if (ch === "\\") out += "\\\\";
    else if (ch === quote) out += `\\${quote}`;
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (code < 0x20 || code === 0x7f) {
      out += `\\x${code.toString(16).padStart(2, "0")}`;
    } else {
      out += ch;
    }
  }
  out += quote;
  return out;
}

export function renderMarkdown(packet: Packet, opts: RenderOptions): string {
  const out: string[] = [];
  const meta = packet._meta;
  const sess = packet.agent_session;
  const diff = packet.diff_summary;
  const cmds = packet.commands_run;
  const tests = packet.test_evidence;
  const summary = packet.summary;
  const redaction = sess.redaction_metadata;

  out.push(`# Trail Packet — \`${sess.session_id.slice(0, 8)}\``);
  out.push("");
  out.push(`**Packet ID:** \`${meta.packet_id}\`  `);
  out.push(`**Generated:** ${meta.generated_at}  `);
  out.push(`**Capture:** ${meta.capture_method}  `);
  out.push(`**Model:** ${sess.model}  `);
  out.push(`**Session window:** ${sess.started_at} → ${sess.ended_at}  `);
  out.push(
    `**Files changed:** ${diff.files_changed} across ${diff.modules_touched.length} module(s) (\`${diff.modules_touched.join(", ")}\`)`
  );
  out.push("");
  out.push(
    `**Redaction:** ${redaction.redactions_applied} redaction(s), ${redaction.validation_errors.length} validation error(s), pattern set v${redaction.pattern_set_version}`
  );
  if (redaction.validation_errors.length > 0) {
    out.push("");
    out.push("> ⚠ Redaction Layer 2 reported issues — investigate before trusting:");
    for (const err of redaction.validation_errors) {
      out.push(`> - \`${err.pattern}\` matched: \`${err.snippet}\``);
    }
  }

  out.push("");
  out.push("## Task");
  out.push("");
  out.push(
    `> ${pyRepr(packet.task_intent.summary)} (source: \`${packet.task_intent.source_ref}\`)`
  );
  out.push("");

  const diffById = new Map(diff.semantic_changes.map((d) => [d.id, d]));
  const cmdById = new Map(cmds.map((c) => [c.id, c]));
  const testById = new Map(tests.passed.map((t) => [t.id, t]));

  out.push("## Claims");
  out.push("");
  out.push(
    `**${summary.claims.length} claims** — **${summary.ungrounded_claim_count} ungrounded** (must be 0 for a healthy packet). Each claim renders inline with its cited evidence.`
  );
  out.push("");

  const citedDiff = new Set<string>();
  const citedCmd = new Set<string>();
  const citedTest = new Set<string>();

  for (const c of summary.claims) {
    out.push(`### ${c.id} — ${c.text}`);
    out.push("");
    out.push(`_evidence: ${c.evidence_refs.map((r) => `\`${r}\``).join(" ")}_  `);
    out.push(`_confidence: ${c.confidence ?? "supported"}_`);
    out.push("");
    for (const r of c.evidence_refs) {
      if (diffById.has(r)) {
        citedDiff.add(r);
        const d = diffById.get(r)!;
        const fp = d.files[0] ?? "";
        out.push(`**${r}** (${d.operation ?? "?"}) — \`${fp}\``);
        out.push("");
        const lang = langFor(fp);
        if (d.excerpts.length > 0) {
          out.push(...renderExcerpts(d.excerpts, lang));
        } else {
          out.push("_(no excerpt captured)_");
          out.push("");
        }
      } else if (cmdById.has(r)) {
        citedCmd.add(r);
        const cm = cmdById.get(r)!;
        out.push(`**${r}** — \`${cm.command}\``);
        const so = cm.stdout_summary ?? "";
        if (so) {
          out.push("");
          out.push("```");
          out.push(so.slice(0, 600));
          out.push("```");
        }
        out.push("");
      } else if (testById.has(r)) {
        citedTest.add(r);
        const t = testById.get(r)!;
        out.push(`**${r}** — \`${t.ref}\``);
        out.push("");
      } else {
        out.push(`**${r}** _(unresolved)_`);
        out.push("");
      }
    }
    out.push("---");
    out.push("");
  }

  const orphanDiffs = diff.semantic_changes.filter((d) => !citedDiff.has(d.id));
  const orphanCmds = cmds.filter((c) => !citedCmd.has(c.id));
  const orphanTests = tests.passed.filter((t) => !citedTest.has(t.id));

  if (orphanDiffs.length > 0 || orphanCmds.length > 0 || orphanTests.length > 0) {
    out.push("## Appendix — Orphan Evidence");
    out.push("");
    out.push(
      `_${orphanDiffs.length} diffs, ${orphanCmds.length} commands, ${orphanTests.length} tests captured but not cited by any claim. These are kept for downstream agent consumption; mechanical claim synthesis is the gap (tracked as v0.2 work)._`
    );
    out.push("");

    if (orphanCmds.length > 0) {
      out.push("<details><summary>Commands</summary>");
      out.push("");
      for (const cm of orphanCmds.slice(0, 40)) {
        out.push(`- **${cm.id}** — \`${cm.command}\``);
      }
      if (orphanCmds.length > 40) {
        out.push(`- _… and ${orphanCmds.length - 40} more_`);
      }
      out.push("");
      out.push("</details>");
      out.push("");
    }
    if (orphanDiffs.length > 0) {
      out.push("<details><summary>Diffs</summary>");
      out.push("");
      for (const d of orphanDiffs.slice(0, 30)) {
        out.push(`- **${d.id}** — ${d.description}`);
      }
      if (orphanDiffs.length > 30) {
        out.push(`- _… and ${orphanDiffs.length - 30} more_`);
      }
      out.push("");
      out.push("</details>");
      out.push("");
    }
    if (orphanTests.length > 0) {
      out.push("<details><summary>Tests</summary>");
      out.push("");
      for (const t of orphanTests.slice(0, 30)) {
        out.push(`- **${t.id}** — \`${t.ref}\``);
      }
      out.push("");
      out.push("</details>");
      out.push("");
    }
  }

  if (sess.prompts.initial) {
    out.push("## Initial Prompt");
    out.push("");
    out.push("<a id='prompt-001'></a>");
    out.push("```");
    out.push(sess.prompts.initial.slice(0, 1000));
    out.push("```");
    out.push("");
  }

  // Approval trail section — surfaces packet.approval_trail[] entries written
  // by `trail packet decide`. Required for AC-6 (gh#4): the PR-body fenced
  // section must reflect the latest approval_trail state. Without this, a
  // re-render after appending an approval_trail entry would be byte-identical
  // to the prior render (body_hash unchanged) and the public PR body would
  // not reflect the decision. Mirrors the Trail tab in spec B4 §4.3.
  const approvalTrail = packet.approval_trail;
  if (Array.isArray(approvalTrail) && approvalTrail.length > 0) {
    const decisionLabel: Record<string, string> = {
      accept: "✅ accept",
      changes: "🔁 changes",
      block: "🛑 block",
      reject: "❌ reject",
    };
    out.push("## Approval Trail");
    out.push("");
    out.push(
      `_${approvalTrail.length} decision${approvalTrail.length === 1 ? "" : "s"} recorded via \`trail packet decide\`. Chronological order._`
    );
    out.push("");
    out.push("| Claim | Decision | Reviewer | At | Reason |");
    out.push("|---|---|---|---|---|");
    for (const entry of approvalTrail) {
      const cid = `\`${entry.claim_id}\``;
      const dec = decisionLabel[entry.decision] ?? entry.decision;
      const by = entry.by.replace(/\|/g, "\\|");
      const at = entry.at.replace(/\|/g, "\\|");
      const reason =
        entry.reason && entry.reason.trim() !== ""
          ? entry.reason.replace(/\|/g, "\\|").replace(/\n/g, " ")
          : "—";
      out.push(`| ${cid} | ${dec} | ${by} | ${at} | ${reason} |`);
    }
    out.push("");
  }

  out.push("---");
  out.push(`*Generated by Trail v0.1 (post-hoc) from \`${opts.packetPath}\`.*`);
  return out.join("\n");
}

/**
 * Compact PR-body render of a packet.
 *
 * `renderMarkdown` embeds full diff excerpts inline per claim — that's the
 * right format for the local `.trail/sessions/<sid>/packet-N.md` file and
 * for the Tauri review UI, but a realistic Claude Code session produces
 * a markdown render of ~5 KB per claim × hundreds of claims = several
 * hundred KB. GitHub's PR-body limit is ~65,536 characters; the body
 * update path (`packetPost`, `packetDecide` body-refresh) rejects with
 * `GraphQL: Body is too long`.
 *
 * rc.6 (DOGFOOD-2 fix) switches the PR-body path to this summary mode:
 * essential metadata + a compact claims table (id, truncated text,
 * evidence count, decision-if-recorded) capped at MAX_CLAIM_ROWS rows,
 * with a footer linking to the colocated full-fidelity packet markdown.
 *
 * The body remains the canonical "what was claimed and who decided what"
 * view; the full diff content lives one click away in the repo.
 */
const MAX_CLAIM_ROWS = 50;
const CLAIM_TEXT_TRUNCATE = 120;

export function renderMarkdownSummary(packet: Packet, opts: RenderOptions): string {
  const out: string[] = [];
  const meta = packet._meta;
  const sess = packet.agent_session;
  const diff = packet.diff_summary;
  const summary = packet.summary;
  const redaction = sess.redaction_metadata;

  out.push(`# Trail Packet — \`${sess.session_id.slice(0, 8)}\``);
  out.push("");
  out.push(`**Packet ID:** \`${meta.packet_id}\`  `);
  out.push(`**Generated:** ${meta.generated_at}  `);
  out.push(`**Model:** ${sess.model}  `);
  out.push(`**Session window:** ${sess.started_at} → ${sess.ended_at}  `);
  out.push(
    `**Files changed:** ${diff.files_changed} across ${diff.modules_touched.length} module(s) (\`${diff.modules_touched.join(", ")}\`)`
  );
  out.push("");
  out.push(
    `**Redaction:** ${redaction.redactions_applied} applied · ${redaction.validation_errors.length} Layer-2 issue(s) · patterns v${redaction.pattern_set_version}`
  );
  if (redaction.validation_errors.length > 0) {
    out.push("");
    out.push("> ⚠ Redaction Layer 2 reported issues — see full packet for details.");
  }

  out.push("");
  out.push("## Task");
  out.push("");
  out.push(
    `> ${pyRepr(packet.task_intent.summary)} (source: \`${packet.task_intent.source_ref}\`)`
  );

  // Build a per-claim decision lookup so the table can show status compactly.
  const decisionByClaim = new Map<string, ApprovalTrailEntry>();
  const approvalTrail = packet.approval_trail;
  if (Array.isArray(approvalTrail)) {
    for (const entry of approvalTrail) {
      // Last-write-wins per claim_id (matches Trail tab semantics).
      decisionByClaim.set(entry.claim_id, entry);
    }
  }
  const decisionLabel: Record<string, string> = {
    accept: "✅ accept",
    changes: "🔁 changes",
    block: "🛑 block",
    reject: "❌ reject",
  };

  out.push("");
  out.push("## Claims");
  out.push("");
  out.push(
    `**${summary.claims.length} total** · **${summary.ungrounded_claim_count} ungrounded** (must be 0 for a healthy packet)`
  );
  out.push("");

  if (summary.claims.length === 0) {
    out.push("_No claims recorded for this packet._");
  } else {
    // Prioritize claims that have a recorded decision (the reviewer
    // explicitly engaged) so they always appear in the table. Fill the
    // remainder by appearance order, capped at MAX_CLAIM_ROWS total.
    const decidedClaims: typeof summary.claims = [];
    const undecidedClaims: typeof summary.claims = [];
    for (const c of summary.claims) {
      const key = c.stable_id ?? c.id;
      if (decisionByClaim.has(c.id) || (c.stable_id && decisionByClaim.has(c.stable_id))) {
        decidedClaims.push(c);
      } else {
        undecidedClaims.push(c);
        void key;
      }
    }
    const tableClaims = decidedClaims
      .concat(undecidedClaims)
      .slice(0, MAX_CLAIM_ROWS);

    out.push("| Claim | Text | Evidence | Status |");
    out.push("|---|---|---|---|");
    for (const c of tableClaims) {
      const text = c.text.length > CLAIM_TEXT_TRUNCATE
        ? `${c.text.slice(0, CLAIM_TEXT_TRUNCATE - 1)}…`
        : c.text;
      const safeText = text.replace(/\|/g, "\\|").replace(/\n/g, " ");
      const evCount = c.evidence_refs.length;
      const decision = decisionByClaim.get(c.id) ?? (c.stable_id ? decisionByClaim.get(c.stable_id) : undefined);
      const status = decision ? (decisionLabel[decision.decision] ?? decision.decision) : "—";
      out.push(`| \`${c.id}\` | ${safeText} | ${evCount} ref(s) | ${status} |`);
    }
    if (summary.claims.length > MAX_CLAIM_ROWS) {
      const more = summary.claims.length - MAX_CLAIM_ROWS;
      out.push("");
      out.push(
        `_…and ${more} more claim(s). See the full packet for the complete list and inline diff evidence._`
      );
    }
  }

  // Approval trail table is always emitted (small in practice) so reviewers
  // see the audit log at a glance even when the claims table is capped.
  if (Array.isArray(approvalTrail) && approvalTrail.length > 0) {
    out.push("");
    out.push("## Approval Trail");
    out.push("");
    out.push(
      `_${approvalTrail.length} decision${approvalTrail.length === 1 ? "" : "s"} recorded via \`trail packet decide\`. Chronological order._`
    );
    out.push("");
    out.push("| Claim | Decision | Reviewer | At | Reason |");
    out.push("|---|---|---|---|---|");
    for (const entry of approvalTrail) {
      const cid = `\`${entry.claim_id}\``;
      const dec = decisionLabel[entry.decision] ?? entry.decision;
      const by = entry.by.replace(/\|/g, "\\|");
      const at = entry.at.replace(/\|/g, "\\|");
      const reason =
        entry.reason && entry.reason.trim() !== ""
          ? entry.reason.replace(/\|/g, "\\|").replace(/\n/g, " ")
          : "—";
      out.push(`| ${cid} | ${dec} | ${by} | ${at} | ${reason} |`);
    }
  }

  out.push("");
  out.push("---");
  out.push(
    `*Trail v0.1 summary. Full packet (with inline diff evidence) at \`${opts.packetPath}\` and \`${opts.packetPath.replace(/\.yml$/, ".md")}\`.*`
  );
  return out.join("\n");
}
