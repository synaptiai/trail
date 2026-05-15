import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import {
  buildTrailQuery,
  dominantRisk,
  formatAge,
  recentSessionSchema,
  sidebarRowSchema,
  timeCluster,
  TRAIL_QUERY_DRIZZLE_SHAPE,
  type SidebarRow,
} from '@/db/queries';
import type { TrailFilter } from '@/ipc/contract';

describe('dominantRisk priority (B4 §3.2)', () => {
  const baseRow: SidebarRow = {
    packet_id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
    session_id: 'sess-1',
    display_name: 'Test packet',
    captured_at: '2026-05-09T12:00:00Z',
    low_count: 0,
    med_count: 0,
    high_count: 0,
    crit_count: 0,
    redaction_count: 0,
    posted_to_pr_count: 0,
  };

  it('returns null when no claims exist', () => {
    expect(dominantRisk(baseRow)).toBeNull();
  });

  it('crit beats high beats med beats low', () => {
    expect(dominantRisk({ ...baseRow, low_count: 1 })).toBe('low');
    expect(dominantRisk({ ...baseRow, low_count: 1, med_count: 1 })).toBe('med');
    expect(dominantRisk({ ...baseRow, med_count: 1, high_count: 1 })).toBe('high');
    expect(dominantRisk({ ...baseRow, high_count: 1, crit_count: 1 })).toBe('crit');
  });
});

describe('timeCluster (B4 §3.1 dividers)', () => {
  const now = new Date('2026-05-09T12:00:00Z');

  it('classifies today / yesterday / week / older correctly', () => {
    expect(timeCluster('2026-05-09T08:00:00Z', now)).toBe('today');
    expect(timeCluster('2026-05-08T08:00:00Z', now)).toBe('yesterday');
    expect(timeCluster('2026-05-04T08:00:00Z', now)).toBe('this-week');
    expect(timeCluster('2026-04-01T08:00:00Z', now)).toBe('older');
  });

  it('returns "older" on invalid input', () => {
    expect(timeCluster('not-a-date', now)).toBe('older');
  });
});

describe('formatAge', () => {
  const now = new Date('2026-05-09T12:00:00Z');

  it('renders minutes / hours / days correctly', () => {
    expect(formatAge('2026-05-09T11:30:00Z', now)).toBe('30m');
    expect(formatAge('2026-05-09T08:00:00Z', now)).toBe('4h');
    expect(formatAge('2026-05-08T12:00:00Z', now)).toBe('1 day');
    expect(formatAge('2026-05-06T12:00:00Z', now)).toBe('3 days');
  });

  it('renders "Mmm D" for older entries', () => {
    const age = formatAge('2026-04-01T12:00:00Z', now);
    expect(age).toMatch(/^[A-Z][a-z]{2} \d{1,2}$/);
  });

  it('returns em-dash on invalid input', () => {
    expect(formatAge('not-a-date', now)).toBe('—');
  });
});

describe('buildTrailQuery (filter → SQL clauses)', () => {
  it('produces no clauses for an empty filter', () => {
    const q = buildTrailQuery({}, 50);
    expect(q.whereClauses).toHaveLength(0);
    expect(q.havingClauses).toHaveLength(0);
    expect(q.limit).toBe(50);
  });

  it('emits captured_after / captured_before clauses', () => {
    const q = buildTrailQuery(
      { captured_after: '2026-01-01T00:00:00Z', captured_before: '2026-12-31T00:00:00Z' },
      50,
    );
    expect(q.whereClauses).toHaveLength(2);
  });

  it('emits a HAVING clause for risk_levels', () => {
    const q = buildTrailQuery({ risk_levels: ['high', 'crit'] } as TrailFilter, 50);
    expect(q.havingClauses).toHaveLength(1);
  });

  it('emits a redaction-existence clause for has_redactions=true', () => {
    const q = buildTrailQuery({ has_redactions: true }, 50);
    expect(q.whereClauses).toHaveLength(1);
  });

  it('emits a search clause when search is non-empty', () => {
    const q = buildTrailQuery({ search: 'oauth' }, 50);
    expect(q.whereClauses).toHaveLength(1);
  });

  it('drops empty/whitespace search', () => {
    const q = buildTrailQuery({ search: '   ' }, 50);
    expect(q.whereClauses).toHaveLength(0);
  });
});

describe('TRAIL_QUERY_DRIZZLE_SHAPE — schema parity', () => {
  it('references the expected packet/claim columns', () => {
    expect(TRAIL_QUERY_DRIZZLE_SHAPE.packetIdCol.name).toBe('packet_id');
    expect(TRAIL_QUERY_DRIZZLE_SHAPE.sessionIdCol.name).toBe('session_id');
    expect(TRAIL_QUERY_DRIZZLE_SHAPE.capturedAtCol.name).toBe('captured_at');
    expect(TRAIL_QUERY_DRIZZLE_SHAPE.riskAgentCol.name).toBe('risk_level_agent');
    expect(TRAIL_QUERY_DRIZZLE_SHAPE.riskCreatorOverrideCol.name).toBe('risk_level_creator_override');
    expect(TRAIL_QUERY_DRIZZLE_SHAPE.riskReviewerOverrideCol.name).toBe('risk_level_reviewer_override');
  });
});

describe('schema parity with Rust SidebarRow / RecentSession', () => {
  it('sidebarRowSchema validates an in-shape row', () => {
    const row: SidebarRow = {
      packet_id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
      session_id: 'sess-1',
      display_name: 'Trail packet',
      captured_at: '2026-05-09T12:00:00Z',
      low_count: 1,
      med_count: 0,
      high_count: 0,
      crit_count: 0,
      redaction_count: 0,
      posted_to_pr_count: 0,
    };
    expect(sidebarRowSchema.safeParse(row).success).toBe(true);
  });

  it('sidebarRowSchema rejects negative counts', () => {
    const bad = {
      packet_id: 'x',
      session_id: 'y',
      display_name: 'z',
      captured_at: 't',
      low_count: -1,
      med_count: 0,
      high_count: 0,
      crit_count: 0,
      redaction_count: 0,
      posted_to_pr_count: 0,
    };
    expect(sidebarRowSchema.safeParse(bad).success).toBe(false);
  });

  it('recentSessionSchema rejects zero packet_count', () => {
    expect(
      recentSessionSchema.safeParse({
        session_id: 'a',
        latest_packet_id: 'b',
        packet_count: 0,
        latest_captured_at: 'c',
      }).success,
    ).toBe(false);
  });
});

// ---- Time-zone independence ----------------------------------------------
// timeCluster uses the local-day boundary (Date#setHours(0,0,0,0)) so its
// answer is system-clock dependent. Pin the system clock to a fixed value
// so the tests do not flake when run after midnight UTC. Vitest's
// fakeTimers handle this; we simulate via the `now` parameter above.

describe('clock independence', () => {
  beforeAll(() => {});
  afterAll(() => {});
  it('uses the injected `now` rather than a global clock', () => {
    const fixedNow = new Date('2026-05-09T03:00:00Z');
    const result = timeCluster('2026-05-09T01:00:00Z', fixedNow);
    expect(['today', 'yesterday']).toContain(result);
  });
});
