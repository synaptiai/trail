import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { axe } from 'jest-axe';
import { RecaptureBanner } from '@/components/screens/RecaptureBanner';

describe('<RecaptureBanner>', () => {
  it('renders the banner with parent_packet_id (truncated) + claim_count', () => {
    render(
      <RecaptureBanner
        parent_packet_id="01ARZ3NDEKTSV4RRFFQ69G5FAW"
        claim_count={12}
      />,
    );
    expect(screen.getByText('01ARZ3ND…')).toBeInTheDocument();
    expect(screen.getByText('12')).toBeInTheDocument();
    // Banner role=status (info tone)
    expect(screen.getByRole('status')).toBeInTheDocument();
    expect(
      screen.getByText(/Re-capture detected — prior decisions can carry forward/),
    ).toBeInTheDocument();
  });

  it('uses singular "claim" when count = 1', () => {
    const { container } = render(
      <RecaptureBanner parent_packet_id="01ARZ3NDEKTSV4RRFFQ69G5FAW" claim_count={1} />,
    );
    // Walk the body of the banner (single rendered instance) and assert the
    // composed sentence — getByText is over-eager when the predicate matches
    // multiple ancestors of the same text node. Wording-fixed in cycle-1
    // (P3): banner refers to "this capture" not "parent packet has X claims"
    // since Sprint 3a does NOT load the parent's claim count.
    const body = container.querySelector('.banner__body');
    expect(body?.textContent).toMatch(/this capture has\s+1 claim;/);
    expect(body?.textContent).not.toMatch(/has\s+1 claims/);
  });

  it('exposes the parent_packet_id full value via title', () => {
    render(
      <RecaptureBanner
        parent_packet_id="01ARZ3NDEKTSV4RRFFQ69G5FAW"
        claim_count={12}
      />,
    );
    const truncated = screen.getByText('01ARZ3ND…');
    expect(truncated.getAttribute('title')).toBe('01ARZ3NDEKTSV4RRFFQ69G5FAW');
  });

  it('invokes onOpenRecaptureReview with parent_packet_id on click', async () => {
    const handler = vi.fn();
    const user = userEvent.setup();
    render(
      <RecaptureBanner
        parent_packet_id="01ARZ3NDEKTSV4RRFFQ69G5FAW"
        claim_count={12}
        onOpenRecaptureReview={handler}
      />,
    );
    const btn = screen.getByRole('button', { name: 'Open re-capture review' });
    await user.click(btn);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith('01ARZ3NDEKTSV4RRFFQ69G5FAW');
  });

  it('renders without a click handler (Storybook / static contexts)', () => {
    render(
      <RecaptureBanner
        parent_packet_id="01ARZ3NDEKTSV4RRFFQ69G5FAW"
        claim_count={12}
      />,
    );
    const btn = screen.getByRole('button', { name: 'Open re-capture review' });
    expect(btn).toBeInTheDocument();
  });

  it('passes axe-core a11y scan', async () => {
    const { container } = render(
      <RecaptureBanner
        parent_packet_id="01ARZ3NDEKTSV4RRFFQ69G5FAW"
        claim_count={12}
      />,
    );
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});
