import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { axe } from 'jest-axe';
import { Button } from '@/components/primitives';

/**
 * Sprint 6 (gh#13 AC-2): primitive axe-clean coverage.
 *
 * Asserts default type=button, variant + size class plumbing, and
 * axe-clean rendering across all four variants.
 */
describe('<Button>', () => {
  it('defaults to type=button (avoids accidental form submit)', () => {
    render(<Button>Click</Button>);
    expect(screen.getByRole('button', { name: 'Click' })).toHaveAttribute(
      'type',
      'button',
    );
  });

  it('plumbs variant + size class names', () => {
    render(
      <Button variant="primary" size="sm">
        Go
      </Button>,
    );
    const btn = screen.getByRole('button', { name: 'Go' });
    expect(btn.className).toContain('button--primary');
    expect(btn.className).toContain('button--sm');
  });

  it('forwards click handlers + native button attributes', () => {
    const onClick = vi.fn();
    render(
      <Button onClick={onClick} disabled aria-label="Disabled save">
        Save
      </Button>,
    );
    const btn = screen.getByRole('button', { name: 'Disabled save' });
    expect(btn).toBeDisabled();
    fireEvent.click(btn);
    expect(onClick).not.toHaveBeenCalled();
  });

  it('axe-clean across all four variants', async () => {
    for (const variant of [
      'primary',
      'secondary',
      'danger',
      'ghost',
    ] as const) {
      const { container, unmount } = render(
        <Button variant={variant}>{variant}</Button>,
      );
      expect(await axe(container)).toHaveNoViolations();
      unmount();
    }
  });
});
