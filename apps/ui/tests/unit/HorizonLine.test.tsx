import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { axe } from 'jest-axe';
import { HorizonLine } from '@/components/primitives';
import type { HorizonVariant } from '@/components/primitives';

describe('<HorizonLine>', () => {
  const variants: HorizonVariant[] = [
    'app-chrome',
    'packet-header',
    'sidebar-divider',
    'override-stack-vertical',
    'first-run-hero',
    'timeline-rail-vertical',
  ];

  for (const variant of variants) {
    it(`renders variant ${variant}`, () => {
      const { container } = render(<HorizonLine variant={variant} />);
      const node = container.querySelector('.horizon');
      expect(node).not.toBeNull();
      expect(node?.classList.contains(`horizon--${variant}`)).toBe(true);
    });
  }

  it('animates first-run-hero by default; static otherwise', () => {
    const { container: animated } = render(<HorizonLine variant="first-run-hero" />);
    expect(animated.querySelector('.motion-horizon-inscribe')).not.toBeNull();

    const { container: still } = render(<HorizonLine variant="app-chrome" />);
    expect(still.querySelector('.motion-horizon-inscribe')).toBeNull();
  });

  it('exposes aria-label when supplied; otherwise hidden', () => {
    const { container: labeled } = render(
      <HorizonLine variant="first-run-hero" aria-label="Trail horizon" />,
    );
    expect(labeled.querySelector('[aria-label="Trail horizon"]')).not.toBeNull();

    const { container: hidden } = render(<HorizonLine variant="app-chrome" />);
    expect(hidden.querySelector('[aria-hidden="true"]')).not.toBeNull();
  });

  // Per PR #6 cycle-1 review F16: real axe scan on the rendered output.
  it('passes axe-core a11y scan on the labelled hero variant', async () => {
    const { container } = render(
      <HorizonLine variant="first-run-hero" aria-label="Trail horizon" />,
    );
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});
