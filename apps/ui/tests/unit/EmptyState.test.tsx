import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { axe } from 'jest-axe';
import { EmptyState } from '@/components/primitives';

/**
 * Sprint 6 (gh#13 AC-2): primitive axe-clean coverage.
 */
describe('<EmptyState>', () => {
  it('renders the headline and optional body', () => {
    render(
      <EmptyState
        headline="No packets yet"
        body={<p>Run trail packet generate to capture one.</p>}
      />,
    );
    expect(screen.getByText('No packets yet')).toBeInTheDocument();
    expect(screen.getByText(/Run trail packet generate/)).toBeInTheDocument();
  });

  it('exposes a status role for SR announcements', () => {
    render(<EmptyState headline="Empty" />);
    expect(screen.getByRole('status')).toHaveTextContent('Empty');
  });

  it('renders the icon as aria-hidden (decorative)', () => {
    render(
      <EmptyState
        headline="X"
        icon={<svg data-testid="icon" />}
      />,
    );
    const iconWrapper = screen.getByTestId('icon').parentElement;
    expect(iconWrapper).toHaveAttribute('aria-hidden', 'true');
  });

  it('axe-clean for both variants', async () => {
    for (const variant of ['compact', 'full'] as const) {
      const { container, unmount } = render(
        <EmptyState
          variant={variant}
          headline={`${variant} empty`}
          body={<p>Body content for the {variant} variant.</p>}
        />,
      );
      expect(await axe(container)).toHaveNoViolations();
      unmount();
    }
  });
});
