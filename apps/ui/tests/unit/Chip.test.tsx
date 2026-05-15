import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { axe } from 'jest-axe';
import { Chip } from '@/components/primitives';

/**
 * Sprint 6 (gh#13 AC-2): primitive axe-clean coverage.
 */
describe('<Chip>', () => {
  it('plumbs tone class names', () => {
    render(<Chip tone="high">CRIT</Chip>);
    const chip = screen.getByText('CRIT');
    expect(chip.className).toContain('chip--high');
  });

  it('forwards aria-hidden when set', () => {
    render(
      <Chip tone="accent" aria-hidden="true">
        Hidden
      </Chip>,
    );
    expect(screen.getByText('Hidden')).toHaveAttribute('aria-hidden', 'true');
  });

  it('axe-clean across all six tones', async () => {
    for (const tone of [
      'neutral',
      'accent',
      'low',
      'med',
      'high',
      'crit',
    ] as const) {
      const { container, unmount } = render(<Chip tone={tone}>{tone}</Chip>);
      expect(await axe(container)).toHaveNoViolations();
      unmount();
    }
  });
});
