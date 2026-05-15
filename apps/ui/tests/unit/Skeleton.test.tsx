import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { axe } from 'jest-axe';
import { Skeleton } from '@/components/primitives';

/**
 * Sprint 6 (gh#13 AC-2): primitive axe-clean coverage.
 */
describe('<Skeleton>', () => {
  it('renders with role=status + aria-label="Loading" by default', () => {
    render(<Skeleton />);
    const skel = screen.getByRole('status');
    expect(skel).toHaveAttribute('aria-label', 'Loading');
    expect(skel).toHaveAttribute('aria-live', 'polite');
  });

  it('accepts a custom aria-label', () => {
    render(<Skeleton label="Loading sidebar" />);
    expect(
      screen.getByRole('status', { name: 'Loading sidebar' }),
    ).toBeInTheDocument();
  });

  it('plumbs variant class names', () => {
    const { container } = render(<Skeleton variant="row" />);
    const skel = container.querySelector('.skeleton');
    expect(skel?.className).toContain('skeleton--row');
  });

  it('axe-clean for all three variants', async () => {
    for (const variant of ['text', 'block', 'row'] as const) {
      const { container, unmount } = render(<Skeleton variant={variant} />);
      expect(await axe(container)).toHaveNoViolations();
      unmount();
    }
  });
});
