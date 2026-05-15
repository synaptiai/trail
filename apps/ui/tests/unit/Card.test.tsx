import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { axe } from 'jest-axe';
import { Card } from '@/components/primitives';

/**
 * Sprint 6 (gh#13 AC-2): primitive axe-clean coverage.
 */
describe('<Card>', () => {
  it('plumbs density + tone class names', () => {
    render(
      <Card density="compact" tone="elevated" data-testid="c">
        <p>Content</p>
      </Card>,
    );
    const card = screen.getByTestId('c');
    expect(card.className).toContain('card--compact');
    expect(card.className).toContain('card--elevated');
  });

  it('forwards arbitrary HTML attributes (role, aria-label)', () => {
    render(
      <Card role="region" aria-label="Packet header">
        <p>X</p>
      </Card>,
    );
    expect(screen.getByRole('region', { name: 'Packet header' })).toBeInTheDocument();
  });

  it('axe-clean for both densities and tones', async () => {
    for (const density of ['comfortable', 'compact'] as const) {
      for (const tone of ['default', 'elevated'] as const) {
        const { container, unmount } = render(
          <Card density={density} tone={tone}>
            <h2>Title</h2>
            <p>Body content for {density}/{tone}.</p>
          </Card>,
        );
        expect(await axe(container)).toHaveNoViolations();
        unmount();
      }
    }
  });
});
