import { Banner, Button } from '@/components/primitives';

/**
 * <RecaptureBanner> (gh#9 criterion 5).
 *
 * Visible above <PacketHeader> when the loaded packet's
 * `_meta.parent_packet_id` is non-null — i.e., this packet is N≥2 in a
 * re-capture chain. Click triggers M5 (B4 §7.x re-capture-drift modal),
 * which Sprint 4 will wire in full; Sprint 3a ships the trigger only.
 *
 * The banner is `<Banner tone="info">` (not warning) because re-capture is
 * a normal workflow checkpoint — the parent reviewer's decisions are
 * proposed for carry-forward, not surfaced as a tamper risk. J12 (real
 * tamper) uses tone="warning" / "alert".
 *
 * ARIA: Banner primitive sets role="status" + aria-live="polite" for
 * info tone; the action button announces "Open re-capture review" so a
 * screen-reader user understands what the click does without seeing the
 * modal preview.
 */
export interface RecaptureBannerProps {
  parent_packet_id: string;
  /** Claim count for THE CURRENT packet (not the parent — Sprint 3a does
   *  not load the parent into memory). The banner phrasing surfaces this
   *  as "this capture has X claims" so a reviewer understands the scale of
   *  the diff before opening the M5 carry-forward modal. */
  claim_count: number;
  /** Click handler — Sprint 3a forwards a recapture intent up; Sprint 4
   *  binds it to the M5 modal open. The handler IS optional in Sprint 3a
   *  so Storybook / static contexts render the banner cleanly without a
   *  modal dependency. */
  onOpenRecaptureReview?: (parent_packet_id: string) => void;
}

function truncate(id: string, head = 8): string {
  if (id.length <= head + 1) return id;
  return `${id.slice(0, head)}…`;
}

export function RecaptureBanner({
  parent_packet_id,
  claim_count,
  onOpenRecaptureReview,
}: RecaptureBannerProps) {
  return (
    <Banner
      tone="info"
      title="Re-capture detected — prior decisions can carry forward."
      action={
        <Button
          variant="primary"
          size="sm"
          onClick={
            onOpenRecaptureReview
              ? () => onOpenRecaptureReview(parent_packet_id)
              : undefined
          }
          aria-label="Open re-capture review"
        >
          Review carry-forward
        </Button>
      }
    >
      Parent packet{' '}
      <code className="type-mono-sm" title={parent_packet_id}>
        {truncate(parent_packet_id)}
      </code>
      {' — this capture has '}
      <span className="tabular-nums">{claim_count}</span> claim
      {claim_count === 1 ? '' : 's'}; prior decisions may carry forward. The full carry-forward
      modal (M5) lands in Sprint 4.
    </Banner>
  );
}
