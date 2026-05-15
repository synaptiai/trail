import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { axe } from 'jest-axe';
import { TopBar } from '@/components/screens/TopBar';

/**
 * <TopBar> screen-level a11y scan.
 *
 * Per PR #21 cycle-1.5 review F5 (P3): the AC-2 spec line names "All 6 B4
 * screens axe-clean" — TrailSidebar / TrailFilters / IconRail / PacketView /
 * KeyboardOverlay each have explicit `axe(container)` calls in their own
 * test files; TopBar previously had no test file and was only verified
 * transitively via App-level renders. Cycle-1.5 fix converts the claim from
 * approximately-true to literally-true: 6 of 6 B4 screens now have explicit
 * axe scans in tests/unit/.
 *
 * The TopBar renders three distinct surfaces: the brand mark + sr-only
 * label, the persona chip, and the keyboard hint + settings cog button.
 * The two-render pattern below covers both branches (with vs without
 * onOpenSettings).
 */

describe('<TopBar>', () => {
  it('passes axe-core a11y scan with settings cog (creator persona)', async () => {
    const { container } = render(<TopBar persona="creator" onOpenSettings={() => {}} />);
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });

  it('passes axe-core a11y scan without settings cog (auditor persona)', async () => {
    const { container } = render(<TopBar persona="auditor" />);
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });

  // Cycle-2 C18 (PR #21): test surface beyond axe — verify the brand
  // mark renders, the persona chip surfaces the right label per
  // persona, and the settings cog actually fires its callback.
  // Previously the file only ran axe scans; a regression that broke
  // the persona chip label or the cog click handler would have passed
  // green.
  it('renders the brand mark and sr-only label', () => {
    render(<TopBar persona="creator" />);
    // Visually-shown brand mark (aria-hidden):
    expect(screen.getByText('Trail')).toBeInTheDocument();
    // sr-only descriptive label is a separate element:
    expect(
      screen.getByText('Trail — AI-native change-control'),
    ).toBeInTheDocument();
  });

  it('shows the correct persona chip per persona prop', () => {
    const { rerender } = render(<TopBar persona="creator" />);
    expect(screen.getByText('Creator')).toBeInTheDocument();
    rerender(<TopBar persona="reviewer" />);
    expect(screen.getByText('Reviewer')).toBeInTheDocument();
    rerender(<TopBar persona="auditor" />);
    expect(screen.getByText('Auditor')).toBeInTheDocument();
  });

  it('shows the keyboard hint surface (`?`)', () => {
    render(<TopBar persona="creator" />);
    expect(screen.getByText(/Press/)).toBeInTheDocument();
    expect(screen.getByText(/for shortcuts/)).toBeInTheDocument();
  });

  it('omits the settings cog when onOpenSettings is undefined (any persona)', () => {
    render(<TopBar persona="creator" />);
    expect(screen.queryByLabelText('Open settings')).toBeNull();
  });

  it('renders the settings cog for creator when onOpenSettings is provided', () => {
    render(<TopBar persona="creator" onOpenSettings={() => {}} />);
    expect(screen.getByLabelText('Open settings')).toBeInTheDocument();
  });

  it('renders the settings cog for reviewer when onOpenSettings is provided', () => {
    render(<TopBar persona="reviewer" onOpenSettings={() => {}} />);
    expect(screen.getByLabelText('Open settings')).toBeInTheDocument();
  });

  // Cycle-3 C8 (PR #21): persona-based gating — auditor never sees the
  // cog even when the caller supplies onOpenSettings. The previous
  // tests labelled cases as "(persona)" but actually toggled the prop;
  // the gate was caller-dependent, not persona-dependent. The honest
  // test renders auditor + onOpenSettings supplied and asserts the cog
  // is absent. A regression that flipped the gate back to "prop only"
  // would fail this test.
  it('omits the settings cog for auditor even when onOpenSettings IS provided (C8)', () => {
    const onOpenSettings = vi.fn();
    render(<TopBar persona="auditor" onOpenSettings={onOpenSettings} />);
    expect(screen.queryByLabelText('Open settings')).toBeNull();
  });

  it('fires onOpenSettings when the cog is clicked', async () => {
    const onOpenSettings = vi.fn();
    const user = userEvent.setup();
    render(<TopBar persona="creator" onOpenSettings={onOpenSettings} />);
    await user.click(screen.getByLabelText('Open settings'));
    expect(onOpenSettings).toHaveBeenCalledOnce();
  });
});
