import { useEffect, useState } from 'react';
import { Banner, Button, Chip, Modal, Skeleton } from '@/components/primitives';
import { invoke } from '@/ipc/client';
import { packetResponseSchema } from '@/ipc/contract';
import { parsePacketYaml } from '@/services/packet-loader';
import './M5RecaptureDriftModal.css';

/**
 * <M5RecaptureDriftModal> — Sprint 4 (gh#11 criterion 7).
 *
 * Surfaces re-capture drift: compares the parent packet's claims to the
 * current packet's claims and lists the differences (added / removed /
 * modified). Reviewer reviews + the M3-equivalent carry-forward
 * proposals are out of scope for v0.1; the modal is the read-only diff
 * view per B4 §7.x.
 *
 * Sprint 3a's RecaptureBanner click forwards `parent_packet_id`; this
 * modal owns the parent fetch + diff computation.
 */
export interface M5RecaptureDriftModalProps {
  open: boolean;
  onClose: () => void;
  /** ULID of the parent packet to fetch + diff against. */
  parentPacketId: string | null;
  /** Current packet's claims; supplied by the calling PacketView so we
   *  do not re-load it. */
  currentClaims: ReadonlyArray<ClaimSummary>;
}

export interface ClaimSummary {
  id: string;
  stable_id?: string | undefined;
  claim_text: string;
  risk_level: string;
}

interface DriftRow {
  kind: 'added' | 'removed' | 'unchanged' | 'modified';
  current?: ClaimSummary;
  parent?: ClaimSummary;
}

export function M5RecaptureDriftModal({
  open,
  onClose,
  parentPacketId,
  currentClaims,
}: M5RecaptureDriftModalProps) {
  const [parentClaims, setParentClaims] = useState<ClaimSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(false);

  useEffect(() => {
    if (!open || !parentPacketId) {
      setParentClaims(null);
      setError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    setParentClaims(null);
    fetchParentClaims(parentPacketId)
      .then((claims) => {
        if (cancelled) return;
        setParentClaims(claims);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Failed to load parent packet');
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, parentPacketId]);

  const drift = parentClaims ? computeDrift(parentClaims, currentClaims) : [];
  const counts = countByKind(drift);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Re-capture drift"
      subtitle="Compare claims against the prior capture in this session."
      size="md"
      footer={
        <Button variant="secondary" size="md" onClick={onClose}>
          Close
        </Button>
      }
    >
      {loading ? (
        <div className="m5__loading">
          <Skeleton variant="block" />
          <Skeleton variant="block" />
        </div>
      ) : error ? (
        <Banner tone="warning" title="Could not load parent packet">
          {error}
        </Banner>
      ) : parentClaims ? (
        <>
          <div className="m5__summary" role="status">
            <Chip tone="low">{counts.added} added</Chip>
            <Chip tone="med">{counts.modified} modified</Chip>
            <Chip tone="neutral">{counts.removed} removed</Chip>
            <Chip tone="neutral">{counts.unchanged} unchanged</Chip>
          </div>
          <ul className="m5__rows">
            {drift.map((row, i) => (
              <DriftRowView key={`${row.kind}-${i}`} row={row} />
            ))}
          </ul>
        </>
      ) : null}
    </Modal>
  );
}

function DriftRowView({ row }: { row: DriftRow }) {
  const claim = row.current ?? row.parent;
  if (!claim) return null;
  const kindLabel: Record<DriftRow['kind'], string> = {
    added: 'NEW',
    modified: 'MOD',
    removed: 'GONE',
    unchanged: 'SAME',
  };
  return (
    <li className={`m5__row m5__row--${row.kind}`}>
      <span className={`m5__kind m5__kind--${row.kind} type-mono-sm`}>
        {kindLabel[row.kind]}
      </span>
      <div className="m5__row-body">
        <span className="m5__claim-id type-mono-sm">{claim.id}</span>
        <p className="m5__claim-text type-body-sm">{claim.claim_text}</p>
        {row.kind === 'modified' && row.parent && row.current ? (
          <p className="m5__diff type-body-sm">
            risk: <code>{row.parent.risk_level}</code> →{' '}
            <code>{row.current.risk_level}</code>
          </p>
        ) : null}
      </div>
    </li>
  );
}

async function fetchParentClaims(parentPacketId: string): Promise<ClaimSummary[]> {
  const response = await invoke<unknown>('read_packet', { packet_id: parentPacketId });
  const validated = packetResponseSchema.parse(response);
  // parsePacketSchema runs the YAML safety + Ajv validation; reuse the
  // existing path so M5 inherits all defenses.
  const parsed = parsePacketYaml(validated.yaml_text, validated.yaml_path);
  return parsed.claims.map((c) => ({
    id: c.id,
    stable_id: c.stable_id,
    claim_text: c.text,
    risk_level: c.risk_level ?? 'unknown',
  }));
}

function computeDrift(
  parent: ReadonlyArray<ClaimSummary>,
  current: ReadonlyArray<ClaimSummary>,
): DriftRow[] {
  const rows: DriftRow[] = [];
  // Match by stable_id when present; fall back to id. AB-5 makes
  // stable_id the primary join key (claims survive re-capture by
  // stable_id).
  const matchKey = (c: ClaimSummary) => c.stable_id ?? c.id;
  const parentByKey = new Map(parent.map((c) => [matchKey(c), c]));
  const currentByKey = new Map(current.map((c) => [matchKey(c), c]));
  // Walk the union in deterministic order (parent first, then current
  // newcomers) so the rendered order is stable across renders.
  const seen = new Set<string>();
  for (const p of parent) {
    const key = matchKey(p);
    seen.add(key);
    const c = currentByKey.get(key);
    if (!c) {
      rows.push({ kind: 'removed', parent: p });
      continue;
    }
    if (
      c.claim_text === p.claim_text &&
      c.risk_level === p.risk_level
    ) {
      rows.push({ kind: 'unchanged', parent: p, current: c });
    } else {
      rows.push({ kind: 'modified', parent: p, current: c });
    }
  }
  for (const c of current) {
    const key = matchKey(c);
    if (seen.has(key)) continue;
    rows.push({ kind: 'added', current: c });
  }
  return rows;
}

function countByKind(rows: ReadonlyArray<DriftRow>) {
  const counts = { added: 0, removed: 0, modified: 0, unchanged: 0 };
  for (const row of rows) counts[row.kind] += 1;
  return counts;
}
