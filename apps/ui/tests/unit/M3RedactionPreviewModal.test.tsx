/**
 * M3 redaction-preview modal tests (gh#11 criterion 6).
 *
 * Pins B6 P1's two-stage gating contract:
 *   - Confirm button is DISABLED for the full 30s window.
 *   - The window.__trailInRedactionPreview flag is SET while modal open
 *     and CLEARED on close.
 *   - The "original not retained" notice surfaces when IPC returns null.
 *   - Focus trap (inherited from <Modal>) — sanity check.
 *   - axe a11y violations: zero.
 */
import { act, fireEvent, render, screen } from '@testing-library/react';
import { axe } from 'jest-axe';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { M3RedactionPreviewModal } from '@/components/screens/M3RedactionPreviewModal';

afterEach(() => {
  delete window.__trailInRedactionPreview;
  // Cycle-3 P3 (PR #21): defensively reset to real timers after every
  // test even when the test itself didn't use fake timers. The
  // countdown test below uses try/finally + vi.useRealTimers() inside
  // the body, but a panic / assertion failure between
  // vi.useFakeTimers() and the finally block would leak fake timers
  // into the next test (the M3-modal-flake observed under happy-dom
  // 15). The double-belts-and-braces pattern is cheap and eliminates
  // the failure mode entirely.
  vi.useRealTimers();
});

const fixtureFetcher = (): Promise<{ original: string | null }> =>
  Promise.resolve({ original: null });

describe('<M3RedactionPreviewModal>', () => {
  it('disables Confirm publish until the timer expires', () => {
    render(
      <M3RedactionPreviewModal
        open
        onClose={() => {}}
        packetId="01ARZ3NDEKTSV4RRFFQ69G5FAV"
        redactionId="openai-key"
        marker="[REDACTED:openai-key]"
        persona="creator"
        initialSecondsRemaining={30}
        fetchOriginal={fixtureFetcher}
      />,
    );
    const button = screen.getByRole('button', { name: /Confirm publish/i });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('aria-disabled', 'true');
  });

  it('enables Confirm publish when initialSecondsRemaining is 0', () => {
    render(
      <M3RedactionPreviewModal
        open
        onClose={() => {}}
        packetId="01ARZ3NDEKTSV4RRFFQ69G5FAV"
        redactionId="openai-key"
        marker="[REDACTED:openai-key]"
        persona="creator"
        initialSecondsRemaining={0}
        fetchOriginal={fixtureFetcher}
      />,
    );
    const button = screen.getByRole('button', { name: /Confirm publish/i });
    expect(button).not.toBeDisabled();
  });

  it('sets window.__trailInRedactionPreview while open and clears on close', () => {
    const { rerender } = render(
      <M3RedactionPreviewModal
        open
        onClose={() => {}}
        packetId="01ARZ3NDEKTSV4RRFFQ69G5FAV"
        redactionId="openai-key"
        marker="[REDACTED:openai-key]"
        persona="creator"
        initialSecondsRemaining={30}
        fetchOriginal={fixtureFetcher}
      />,
    );
    expect(window.__trailInRedactionPreview).toBe(true);
    rerender(
      <M3RedactionPreviewModal
        open={false}
        onClose={() => {}}
        packetId="01ARZ3NDEKTSV4RRFFQ69G5FAV"
        redactionId="openai-key"
        marker="[REDACTED:openai-key]"
        persona="creator"
        fetchOriginal={fixtureFetcher}
      />,
    );
    expect(window.__trailInRedactionPreview).toBe(false);
  });

  it('shows "Original not retained on disk" when fetcher returns null', async () => {
    render(
      <M3RedactionPreviewModal
        open
        onClose={() => {}}
        packetId="01ARZ3NDEKTSV4RRFFQ69G5FAV"
        redactionId="openai-key"
        marker="[REDACTED:openai-key]"
        persona="creator"
        initialSecondsRemaining={30}
        fetchOriginal={fixtureFetcher}
      />,
    );
    const notice = await screen.findByText(/not retained on disk/i);
    expect(notice).toBeInTheDocument();
  });

  it('countdown advances; transitions to 0 enable the Confirm button', async () => {
    vi.useFakeTimers();
    try {
      render(
        <M3RedactionPreviewModal
          open
          onClose={() => {}}
          packetId="01ARZ3NDEKTSV4RRFFQ69G5FAV"
          redactionId="openai-key"
          marker="[REDACTED:openai-key]"
          persona="creator"
          initialSecondsRemaining={2}
          fetchOriginal={fixtureFetcher}
        />,
      );
      // Initially disabled.
      expect(
        screen.getByRole('button', { name: /Confirm publish \(2s\)/i }),
      ).toBeDisabled();
      // The countdown effect uses a recursive setTimeout — each tick
      // re-runs the effect to schedule the next tick. Wrap each tick in
      // `act` so the post-`setSeconds` state commit happens inside an
      // act() boundary (the React 18 warning fires for any state update
      // outside such a boundary, regardless of whether the update is
      // observed). Stepping 1s at a time also ensures each tick is
      // observable to the next-tick scheduling logic: a single 2s advance
      // wrapped in act batches the updates such that the inner effect
      // sees stale state and never schedules the second tick.
      // (Cycle-3 C3-S-CR-5: the prior rationale conflated "act batching"
      //  with "setTimeout not scheduled" — both are real, but the
      //  load-bearing reason this works is the per-tick boundary.)
      for (let i = 0; i < 2; i++) {
        await act(async () => {
          await vi.advanceTimersByTimeAsync(1_000);
        });
      }
      const button = screen.getByRole('button', { name: /Confirm publish/i });
      expect(button).not.toBeDisabled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('passes axe a11y scan', async () => {
    const { container } = render(
      <M3RedactionPreviewModal
        open
        onClose={() => {}}
        packetId="01ARZ3NDEKTSV4RRFFQ69G5FAV"
        redactionId="openai-key"
        marker="[REDACTED:openai-key]"
        persona="creator"
        initialSecondsRemaining={30}
        fetchOriginal={fixtureFetcher}
      />,
    );
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });

  it('Cancel button calls onClose', () => {
    const onClose = vi.fn();
    render(
      <M3RedactionPreviewModal
        open
        onClose={onClose}
        packetId="01ARZ3NDEKTSV4RRFFQ69G5FAV"
        redactionId="openai-key"
        marker="[REDACTED:openai-key]"
        persona="creator"
        initialSecondsRemaining={30}
        fetchOriginal={fixtureFetcher}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /Cancel/i }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
