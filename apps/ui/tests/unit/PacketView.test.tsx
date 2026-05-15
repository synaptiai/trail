import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { axe } from 'jest-axe';
import { PacketView } from '@/components/screens/PacketView';
import type { LoadedPacket } from '@/services/packet-loader';

const PACKET_FIXTURE: LoadedPacket = {
  source_path: '/test/fixture.yml',
  header: {
    packet_id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
    session_id: '18e374b5-4eb9-424d-a3ff-a639d1c6fada',
    generated_at: '2026-05-09T12:00:00.000+00:00',
    generator_name: 'trail',
    generator_version: '0.1.0-dev',
    schema_version: '0.1.1',
    parent_packet_id: null,
    packet_n: 1,
    is_recapture: false,
    repository: 'synaptiai/trail',
    branch: 'main',
  },
  claims: [
    {
      id: 'CLAIM-001',
      stable_id: 'aaaaaaaaaaaaaaaa',
      text: 'low-risk claim',
      evidence_refs: ['DIFF-001'],
      evidence_count: 1,
      confidence: 'supported',
      risk_level: 'low',
    },
    {
      id: 'CLAIM-002',
      stable_id: 'bbbbbbbbbbbbbbbb',
      text: 'high-risk claim',
      evidence_refs: ['DIFF-002', 'TEST-001'],
      evidence_count: 2,
      confidence: 'supported',
      risk_level: 'high',
    },
  ],
  histogram: { low: 1, med: 0, high: 1, crit: 0, classified_total: 2 },
  approval_trail: [],
  diff_summary: {
    base_sha: '0000000000000000000000000000000000000000',
    head_sha: '1111111111111111111111111111111111111111',
    files_changed: 1,
    lines_added: 3,
    lines_deleted: 1,
    modules_touched: ['src'],
    semantic_changes: [
      {
        id: 'DIFF-001',
        description: 'Edited src/foo.ts',
        files: ['src/foo.ts'],
        operation: 'edit',
        excerpts: [
          { kind: 'before', text: 'const x = 1;', elided: false },
          { kind: 'after', text: 'const x = 2;', elided: false },
        ],
      },
    ],
  },
  redaction_summary: {
    pattern_set_version: '0.1.3',
    pattern_set_origin: 'bundled',
    redactions_applied: 0,
    by_pattern: [],
    validation_errors: [],
  },
  posted_to_pr: [],
};

const PACKET_RECAPTURE: LoadedPacket = {
  ...PACKET_FIXTURE,
  header: {
    ...PACKET_FIXTURE.header,
    parent_packet_id: '01ARZ3NDEKTSV4RRFFQ69G5FAW',
    packet_n: null, // Sprint 3a: chain depth unknown until Sprint 4 walk
    is_recapture: true,
  },
};

describe('<PacketView> — Sprint 3a integration', () => {
  it('renders the packet view spine when loaded packet is supplied directly', () => {
    render(
      <PacketView
        packetId="01ARZ3NDEKTSV4RRFFQ69G5FAV"
        persona="creator"
        loadedPacket={PACKET_FIXTURE}
      />,
    );
    // Header surfaces repository + branch
    expect(screen.getByText(/synaptiai\/trail/)).toBeInTheDocument();
    // Histogram with role=img + verbose label
    const histogram = screen.getByRole('img', {
      name: /Risk distribution: 1 low, 0 medium, 1 high, 0 critical/,
    });
    expect(histogram).toBeInTheDocument();
    // Tabs render Claims + Diff + Redaction + Trail
    expect(screen.getByRole('tab', { name: /Claims/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Diff/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Redaction/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Trail/i })).toBeInTheDocument();
  });

  it('mode=creator → Claims tab is active by default', () => {
    render(
      <PacketView
        packetId="01ARZ3NDEKTSV4RRFFQ69G5FAV"
        persona="creator"
        loadedPacket={PACKET_FIXTURE}
      />,
    );
    const claimsTab = screen.getByRole('tab', { name: /Claims/i });
    expect(claimsTab.getAttribute('aria-selected')).toBe('true');
  });

  it('mode=auditor → Trail tab is active by default (B4 §4.6)', () => {
    render(
      <PacketView
        packetId="01ARZ3NDEKTSV4RRFFQ69G5FAV"
        persona="auditor"
        loadedPacket={PACKET_FIXTURE}
      />,
    );
    const trailTab = screen.getByRole('tab', { name: /Trail/i });
    expect(trailTab.getAttribute('aria-selected')).toBe('true');
  });

  it('mode=auditor surfaces the AUDIT · READ-ONLY chip', () => {
    render(
      <PacketView
        packetId="01ARZ3NDEKTSV4RRFFQ69G5FAV"
        persona="auditor"
        loadedPacket={PACKET_FIXTURE}
      />,
    );
    expect(screen.getByText(/AUDIT · READ-ONLY/)).toBeInTheDocument();
  });

  it('mode=creator does NOT surface the audit chip', () => {
    render(
      <PacketView
        packetId="01ARZ3NDEKTSV4RRFFQ69G5FAV"
        persona="creator"
        loadedPacket={PACKET_FIXTURE}
      />,
    );
    expect(screen.queryByText(/AUDIT · READ-ONLY/)).toBeNull();
  });

  it('parent_packet_id non-null → RecaptureBanner renders above header', () => {
    render(
      <PacketView
        packetId="01ARZ3NDEKTSV4RRFFQ69G5FAV"
        persona="creator"
        loadedPacket={PACKET_RECAPTURE}
      />,
    );
    expect(
      screen.getByText(/Re-capture detected — prior decisions can carry forward/),
    ).toBeInTheDocument();
    // Cycle-1 P1: chain depth unknown → 're-captured' (not fabricated 'packet-2')
    expect(screen.getByText(/^re-captured$/)).toBeInTheDocument();
  });

  it('parent_packet_id null (root capture) → no RecaptureBanner', () => {
    render(
      <PacketView
        packetId="01ARZ3NDEKTSV4RRFFQ69G5FAV"
        persona="creator"
        loadedPacket={PACKET_FIXTURE}
      />,
    );
    expect(
      screen.queryByText(/Re-capture detected/),
    ).toBeNull();
  });

  it('Claims tab renders one ClaimRow per claim', () => {
    render(
      <PacketView
        packetId="01ARZ3NDEKTSV4RRFFQ69G5FAV"
        persona="creator"
        loadedPacket={PACKET_FIXTURE}
      />,
    );
    const items = screen.getAllByRole('listitem');
    expect(items).toHaveLength(2);
  });

  it('Trail tab renders empty-state when approval_trail is empty', async () => {
    const user = userEvent.setup();
    render(
      <PacketView
        packetId="01ARZ3NDEKTSV4RRFFQ69G5FAV"
        persona="creator"
        loadedPacket={PACKET_FIXTURE}
      />,
    );
    await user.click(screen.getByRole('tab', { name: /Trail/i }));
    expect(
      screen.getByText(/No approval decisions recorded for this packet/),
    ).toBeInTheDocument();
  });

  it('Trail tab + auditor + HIGH-risk-unrecorded → audit-elevated empty', () => {
    render(
      <PacketView
        packetId="01ARZ3NDEKTSV4RRFFQ69G5FAV"
        persona="auditor"
        loadedPacket={PACKET_FIXTURE}
      />,
    );
    // Auditor lands on Trail tab by default; histogram has high=1 → audit-elevated.
    expect(
      screen.getByText(/Audit-relevant: HIGH-risk packet without recorded approval/),
    ).toBeInTheDocument();
  });

  it('Diff tab renders DiffTab body with one hunk per semantic_change (Sprint 3b)', async () => {
    const user = userEvent.setup();
    render(
      <PacketView
        packetId="01ARZ3NDEKTSV4RRFFQ69G5FAV"
        persona="creator"
        loadedPacket={PACKET_FIXTURE}
      />,
    );
    await user.click(screen.getByRole('tab', { name: /Diff/i }));
    // Sprint 3b: tab body is real <DiffTab>, not a placeholder.
    expect(
      screen.getByRole('region', { name: /Diff hunk: src\/foo\.ts/ }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/pending Sprint 3b/i)).toBeNull();
  });

  it('Redaction tab renders RedactionTab body with summary + opt-in note (Sprint 3b)', async () => {
    const user = userEvent.setup();
    render(
      <PacketView
        packetId="01ARZ3NDEKTSV4RRFFQ69G5FAV"
        persona="creator"
        loadedPacket={PACKET_FIXTURE}
      />,
    );
    await user.click(screen.getByRole('tab', { name: /Redaction/i }));
    // Sprint 3b: tab body is real <RedactionTab>; for a 0-redactions
    // packet the empty-state copy surfaces.
    expect(screen.getByText(/No redactions applied/i)).toBeInTheDocument();
    expect(
      screen.getByText(/Preview-original is opt-in\. Enable in Settings → Redaction/),
    ).toBeInTheDocument();
    expect(screen.queryByText(/pending Sprint 3b/i)).toBeNull();
  });

  it('Redaction tab label includes count when redactions_applied > 0 (B4 §4.3)', () => {
    const recap = {
      ...PACKET_FIXTURE,
      redaction_summary: {
        ...PACKET_FIXTURE.redaction_summary,
        redactions_applied: 5,
        by_pattern: [{ pattern_name: 'aws', count: 5 }],
      },
    };
    render(
      <PacketView
        packetId="01ARZ3NDEKTSV4RRFFQ69G5FAV"
        persona="creator"
        loadedPacket={recap}
      />,
    );
    // B4 §4.3 spec: "Redaction (N)" — the count surfaces in the tab strip.
    expect(
      screen.getByRole('tab', { name: /Redaction \(5\)/ }),
    ).toBeInTheDocument();
  });

  it('IPC error path surfaces an EdgeFlowBanner with recovery action', async () => {
    // No loadedPacket supplied + no fixtureUrl → component falls back to
    // loadPacketViaIpc, which raises IpcUnavailableError in the test env.
    // Sprint 5 (gh#12 AC-8): E1/E2 edge-flow Banner replaces the prior
    // dead-end EmptyState; the user gets a Reload affordance.
    render(
      <PacketView
        packetId="01ARZ3NDEKTSV4RRFFQ69G5FAV"
        persona="creator"
      />,
    );
    await waitFor(() => {
      // Either E1 (corrupt-packet) or E2 (missing-fixture) banner — depends
      // on the IpcUnavailableError message text, which the heuristic
      // classifies based on "not found" vs other tokens.
      const banner =
        document.querySelector('[data-testid="edge-flow-corrupt-packet"]') ??
        document.querySelector('[data-testid="edge-flow-missing-fixture"]');
      expect(banner).not.toBeNull();
    });
  });

  // gh#12 cycle-3 V1 (N15 regression): the EdgeFlowBanner Recover button
  // MUST re-fire the packet loader, not re-open M4. Prior to V1 the
  // packet-not-found inline routing called setM4Open(true) — same dead-
  // loop anti-pattern that F11 fixed for gh-cli-absent. Reload via
  // reloadPacket is now the shared helper for BOTH the early-return
  // EdgeFlowBanner (corrupt/missing fixture) and the inline edge-flow
  // packet-not-found route. This test exercises the live early-return
  // path: drive PacketView into the error state via a failing fetch,
  // click Recover, verify fetch is invoked a second time AND no M4
  // modal mounts (which would happen if the legacy setM4Open route was
  // still wired).
  it('AC-8 cycle-3 V1 regression: EdgeFlowBanner Recover re-fires loader (no M4 reopen)', async () => {
    // First fetch rejects → EdgeFlowBanner appears.
    // Second fetch resolves with valid yaml → packet renders.
    const minimalYaml = `
packet_version: 0.1.1
_meta:
  packet_id: 01ARZ3NDEKTSV4RRFFQ69G5FAV
  generated_at: '2026-05-09T12:00:00.000+00:00'
  generator: { name: trail, version: 0.1.0-dev }
  schema_url: schema/pr-change-packet.v0.1.1.yml
  capture_method: post_hoc
  parent_packet_id: null
pr:
  provider: github
  repository: synaptiai/trail
  branch: main
  base_branch: origin/main
  pr_number: null
  author: t@e.com
task_intent: { source_type: prompt, source_ref: PROMPT-001, summary: x, acceptance_criteria: [] }
agent_session:
  tool: claude-code
  model: m
  models: [m]
  started_at: '2026-05-09T11:00:00.000+00:00'
  ended_at: '2026-05-09T11:30:00.000+00:00'
  session_id: aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee
  transcript_summary: []
  prompts: { initial: x, followups: [] }
  redaction_metadata:
    pattern_set_version: 0.1.3
    redactions_applied: 0
    redactions_by_pattern: {}
    validation_errors: []
    skipped_files: []
diff_summary:
  base_sha: '0000000000000000000000000000000000000000'
  head_sha: '1111111111111111111111111111111111111111'
  files_changed: 0
  lines_added: 0
  lines_deleted: 0
  modules_touched: []
  semantic_changes: []
commands_run: []
test_evidence: { passed: [], failed: [], not_run: [] }
provenance:
  authorship: { ai_generated_estimate: high, human_modified_estimate: low, method: post-hoc-transcript }
  agent_touched_files: []
  human_touched_files: []
summary:
  claims:
  - id: CLAIM-001
    text: x
    evidence_refs: [DIFF-001]
    confidence: supported
    synthesis_mode: mechanical
  ungrounded_claim_count: 0
`;
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    fetchSpy.mockImplementationOnce(async () => {
      throw new Error('not found');
    });
    fetchSpy.mockImplementationOnce(
      async () =>
        ({
          ok: true,
          status: 200,
          text: async () => minimalYaml,
        }) as Response,
    );
    render(
      <PacketView
        packetId="01ARZ3NDEKTSV4RRFFQ69G5FAV"
        persona="creator"
        fixtureUrl="/fixtures/missing.yml"
      />,
    );
    // First load fails → Banner appears.
    await waitFor(() => {
      const banner =
        document.querySelector('[data-testid="edge-flow-missing-fixture"]') ??
        document.querySelector('[data-testid="edge-flow-corrupt-packet"]');
      expect(banner).not.toBeNull();
    });
    // M4 modal must NOT have mounted in the error state.
    // M4 modal — when mounted, surfaces a 'm4-confirm-post' button.
    // Pre-V1 the packet-not-found route called setM4Open(true), which
    // would render this surface; post-V1 the route calls reloadPacket
    // and M4 stays unmounted.
    expect(document.querySelector('[data-testid="m4-confirm-post"]')).toBeNull();
    // Click the Recover button — this should invoke reloadPacket, which
    // re-fires the fetch loader. Pre-V1 the packet-not-found route called
    // setM4Open(true); the early-return path always called the loader, so
    // this exercises the shared helper that BOTH routes now share.
    const recoverBtn =
      document.querySelector('[data-testid="edge-flow-missing-fixture-recover"]') ??
      document.querySelector('[data-testid="edge-flow-corrupt-packet-recover"]');
    expect(recoverBtn).not.toBeNull();
    fireEvent.click(recoverBtn as Element);
    // Loader was re-fired → second fetch call → packet eventually renders.
    await waitFor(() => {
      expect(screen.getByText(/synaptiai\/trail/)).toBeInTheDocument();
    });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(fetchSpy).toHaveBeenNthCalledWith(1, '/fixtures/missing.yml');
    expect(fetchSpy).toHaveBeenNthCalledWith(2, '/fixtures/missing.yml');
    // M4 modal must STILL not be open — the cycle-3 V1 fix routes
    // packet-not-found-style recovery to the loader, never M4.
    // M4 modal — when mounted, surfaces a 'm4-confirm-post' button.
    // Pre-V1 the packet-not-found route called setM4Open(true), which
    // would render this surface; post-V1 the route calls reloadPacket
    // and M4 stays unmounted.
    expect(document.querySelector('[data-testid="m4-confirm-post"]')).toBeNull();
    fetchSpy.mockRestore();
  });

  it('passes axe-core a11y scan (creator mode + 2 claims)', async () => {
    const { container } = render(
      <PacketView
        packetId="01ARZ3NDEKTSV4RRFFQ69G5FAV"
        persona="creator"
        loadedPacket={PACKET_FIXTURE}
      />,
    );
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});

describe('<PacketView> — fixture-fallback fetch path (criterion 7)', () => {
  it('loads via fetch when fixtureUrl is provided', async () => {
    // Spy on the global fetch used by loadPacketViaFetch — the loader runs
    // js-yaml + Ajv on the response body, so a real minimal v0.1.1 packet
    // is what the fetch returns. This exercises the same parser-validator
    // path the production IPC uses end-to-end.
    const minimalYaml = `
packet_version: 0.1.1
_meta:
  packet_id: 01ARZ3NDEKTSV4RRFFQ69G5FAV
  generated_at: '2026-05-09T12:00:00.000+00:00'
  generator: { name: trail, version: 0.1.0-dev }
  schema_url: schema/pr-change-packet.v0.1.1.yml
  capture_method: post_hoc
  parent_packet_id: null
pr:
  provider: github
  repository: synaptiai/trail
  branch: main
  base_branch: origin/main
  pr_number: null
  author: t@e.com
task_intent: { source_type: prompt, source_ref: PROMPT-001, summary: x, acceptance_criteria: [] }
agent_session:
  tool: claude-code
  model: m
  models: [m]
  started_at: '2026-05-09T11:00:00.000+00:00'
  ended_at: '2026-05-09T11:30:00.000+00:00'
  session_id: aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee
  transcript_summary: []
  prompts: { initial: x, followups: [] }
  redaction_metadata:
    pattern_set_version: 0.1.3
    redactions_applied: 0
    redactions_by_pattern: {}
    validation_errors: []
    skipped_files: []
diff_summary:
  base_sha: '0000000000000000000000000000000000000000'
  head_sha: '1111111111111111111111111111111111111111'
  files_changed: 0
  lines_added: 0
  lines_deleted: 0
  modules_touched: []
  semantic_changes: []
commands_run: []
test_evidence: { passed: [], failed: [], not_run: [] }
provenance:
  authorship: { ai_generated_estimate: high, human_modified_estimate: low, method: post-hoc-transcript }
  agent_touched_files: []
  human_touched_files: []
summary:
  claims:
  - id: CLAIM-001
    text: x
    evidence_refs: [DIFF-001]
    confidence: supported
    synthesis_mode: mechanical
  ungrounded_claim_count: 0
`;
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => minimalYaml,
    } as Response);
    render(
      <PacketView
        packetId="01ARZ3NDEKTSV4RRFFQ69G5FAV"
        persona="creator"
        fixtureUrl="/fixtures/test.yml"
      />,
    );
    await waitFor(() => {
      expect(screen.getByText(/synaptiai\/trail/)).toBeInTheDocument();
    });
    expect(fetchSpy).toHaveBeenCalledWith('/fixtures/test.yml');
    fetchSpy.mockRestore();
  });
});
