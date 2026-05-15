import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { axe } from 'jest-axe';
import { Banner } from '@/components/primitives';

/**
 * Sprint 6 (gh#13 AC-2): primitive axe-clean coverage.
 *
 * Banner is the J12 tamper / E2 schema-mismatch / E5 heavy-redaction
 * surface. Asserts ARIA wiring (role + aria-live), tone-class plumbing,
 * dismiss button accessibility, axe-clean rendering across all three
 * tones.
 */
describe('<Banner>', () => {
  it('renders with role=status + aria-live=polite for info/warning tones', () => {
    const { rerender } = render(<Banner tone="info" title="Info" />);
    let banner = screen.getByRole('status');
    expect(banner).toHaveAttribute('aria-live', 'polite');
    expect(banner).toHaveAttribute('data-tone', 'info');

    rerender(<Banner tone="warning" title="Warning" />);
    banner = screen.getByRole('status');
    expect(banner).toHaveAttribute('aria-live', 'polite');
    expect(banner).toHaveAttribute('data-tone', 'warning');
  });

  it('renders with role=alert + aria-live=assertive for alert tone', () => {
    render(<Banner tone="alert" title="Tamper detected" />);
    const banner = screen.getByRole('alert');
    expect(banner).toHaveAttribute('aria-live', 'assertive');
    expect(banner).toHaveAttribute('data-tone', 'alert');
  });

  it('renders the title and optional body children', () => {
    render(
      <Banner tone="warning" title="Heavy redaction">
        <span>15 redactions in this packet.</span>
      </Banner>,
    );
    expect(screen.getByText('Heavy redaction')).toBeInTheDocument();
    expect(screen.getByText('15 redactions in this packet.')).toBeInTheDocument();
  });

  it('exposes a dismiss button with an accessible name when onDismiss is set', () => {
    const onDismiss = vi.fn();
    render(<Banner tone="info" title="X" onDismiss={onDismiss} />);
    const dismiss = screen.getByRole('button', { name: 'Dismiss' });
    fireEvent.click(dismiss);
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it('renders the showNewBadge fallback for reduced-motion users', () => {
    render(
      <Banner tone="alert" title="Tamper" showNewBadge>
        <span>Body</span>
      </Banner>,
    );
    // The badge is aria-hidden so it isn't double-announced; we assert
    // its DOM presence.
    expect(screen.getByText(/NEW/)).toBeInTheDocument();
  });

  it('axe-clean across all three tones', async () => {
    for (const tone of ['info', 'warning', 'alert'] as const) {
      const { container, unmount } = render(
        <Banner tone={tone} title={`Tone ${tone}`}>
          <span>Body content for {tone}.</span>
        </Banner>,
      );
      expect(await axe(container)).toHaveNoViolations();
      unmount();
    }
  });
});
