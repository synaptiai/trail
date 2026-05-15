/**
 * EdgeFlowBanner unit tests (gh#12 AC-8 — each E1-E7 tested).
 *
 * Cycle-1.5 F3: adds axe-core a11y assertion (parity with M3 / M5 modals
 * and PacketView). Cycle-1.5 F4: adds pr-not-found + packet-not-found
 * Banner kinds with regression test against title-collapse.
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { axe } from 'jest-axe';
import { describe, expect, it, vi } from 'vitest';
import {
  EdgeFlowBanner,
  type EdgeFlowKind,
} from '@/components/screens/EdgeFlowBanner';

const ALL_KINDS: EdgeFlowKind[] = [
  'corrupt-packet',
  'missing-fixture',
  'libsql-out-of-sync',
  'gh-cli-absent',
  'gh-auth-expired',
  'network-failure-mid-post',
  'concurrent-edit',
  'pr-not-found',
  'packet-not-found',
];

describe('<EdgeFlowBanner>', () => {
  it.each(ALL_KINDS)('renders a Banner + recovery action for %s', (kind) => {
    const onRecover = vi.fn();
    render(<EdgeFlowBanner kind={kind} onRecover={onRecover} />);
    expect(screen.getByTestId(`edge-flow-${kind}`)).toBeInTheDocument();
    const recover = screen.getByTestId(`edge-flow-${kind}-recover`);
    fireEvent.click(recover);
    expect(onRecover).toHaveBeenCalledTimes(1);
  });

  it('Dismiss appears only when onDismiss is supplied', () => {
    const { rerender } = render(
      <EdgeFlowBanner
        kind="network-failure-mid-post"
        onRecover={() => {}}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Dismiss' })).toBeNull();
    const onDismiss = vi.fn();
    rerender(
      <EdgeFlowBanner
        kind="network-failure-mid-post"
        onRecover={() => {}}
        onDismiss={onDismiss}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(onDismiss).toHaveBeenCalled();
  });

  it('renders detail string when supplied', () => {
    render(
      <EdgeFlowBanner
        kind="corrupt-packet"
        detail="line 4: invalid mapping"
        onRecover={() => {}}
      />,
    );
    expect(
      screen.getByTestId('edge-flow-corrupt-packet-detail').textContent,
    ).toContain('line 4: invalid mapping');
  });

  it('omits detail block when detail is null/undefined', () => {
    render(
      <EdgeFlowBanner kind="corrupt-packet" onRecover={() => {}} />,
    );
    expect(
      screen.queryByTestId('edge-flow-corrupt-packet-detail'),
    ).toBeNull();
  });

  it('each kind has distinct title (no copy collisions)', () => {
    const titles = new Set<string>();
    for (const kind of ALL_KINDS) {
      const { unmount } = render(
        <EdgeFlowBanner kind={kind} onRecover={() => {}} />,
      );
      const banner = screen.getByTestId(`edge-flow-${kind}`);
      const title = banner.querySelector('.banner__title')?.textContent;
      if (title) titles.add(title);
      unmount();
    }
    expect(titles.size).toBe(ALL_KINDS.length);
  });

  // Cycle-1.5 F3 (gh#12): a11y scan parity with Sprint 4 surfaces.
  it('passes axe a11y scan for each kind', async () => {
    for (const kind of ALL_KINDS) {
      const { container, unmount } = render(
        <EdgeFlowBanner
          kind={kind}
          detail="optional detail line"
          onRecover={() => {}}
          onDismiss={() => {}}
        />,
      );
      const results = await axe(container);
      expect(results, `axe violations for kind=${kind}`).toHaveNoViolations();
      unmount();
    }
  });

  // gh#12 cycle-1.5 F4 N15 regression: PR-not-found and packet-not-found
  // MUST surface distinct titles. The original cycle-1 implementation
  // collapsed both into IpcError::NotFound → 'pr-not-found' Banner, so a
  // user with a missing local packet was told "PR not found" — opposite
  // recovery path. Lock the distinction here.
  it('AC-7 regression: pr-not-found and packet-not-found have distinct titles', () => {
    render(<EdgeFlowBanner kind="pr-not-found" onRecover={() => {}} />);
    const prTitle = screen
      .getByTestId('edge-flow-pr-not-found')
      .querySelector('.banner__title')?.textContent;
    expect(prTitle).toBeTruthy();
    expect(prTitle).toMatch(/pull request/i);

    render(<EdgeFlowBanner kind="packet-not-found" onRecover={() => {}} />);
    const packetTitle = screen
      .getByTestId('edge-flow-packet-not-found')
      .querySelector('.banner__title')?.textContent;
    expect(packetTitle).toBeTruthy();
    expect(packetTitle).toMatch(/packet/i);

    expect(prTitle).not.toBe(packetTitle);
  });
});
