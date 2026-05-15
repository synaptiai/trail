import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { axe } from 'jest-axe';
import { Toast } from '@/components/primitives';

/**
 * Sprint 6 (gh#13 AC-2): primitive axe-clean coverage.
 *
 * Toast itself does not own a role=status (the host does — see ToastHost
 * tests). It must therefore not double-announce; we assert tone class
 * plumbing, dismiss accessibility, and axe-clean rendering.
 */
describe('<Toast>', () => {
  it('renders the title and tone classes', () => {
    render(<Toast tone="success" title="Posted to PR" />);
    expect(screen.getByText('Posted to PR')).toBeInTheDocument();
  });

  it('renders the optional description', () => {
    render(
      <Toast
        tone="error"
        title="Decision could not be saved"
        description="Retry queued in 2s."
      />,
    );
    expect(screen.getByText('Retry queued in 2s.')).toBeInTheDocument();
  });

  it('exposes a dismiss button with an accessible name', () => {
    const onDismiss = vi.fn();
    render(<Toast tone="info" title="X" onDismiss={onDismiss} />);
    const dismiss = screen.getByRole('button', {
      name: 'Dismiss notification',
    });
    fireEvent.click(dismiss);
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it('axe-clean for all four tones', async () => {
    for (const tone of ['info', 'success', 'warning', 'error'] as const) {
      const { container, unmount } = render(
        <Toast
          tone={tone}
          title={`Tone ${tone}`}
          description={`Body for ${tone}.`}
        />,
      );
      expect(await axe(container)).toHaveNoViolations();
      unmount();
    }
  });
});
