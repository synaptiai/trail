import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { axe } from 'jest-axe';
import { KeyboardKey } from '@/components/primitives';

/**
 * Sprint 6 (gh#13 AC-2): primitive axe-clean coverage.
 *
 * KeyboardKey wraps its content in a <kbd> element — the most precise
 * SR signal for "this is a key affordance."
 */
describe('<KeyboardKey>', () => {
  it('renders content inside a <kbd> element', () => {
    const { container } = render(<KeyboardKey>a</KeyboardKey>);
    const kbd = container.querySelector('kbd');
    expect(kbd).not.toBeNull();
    expect(kbd?.textContent).toBe('a');
  });

  it('axe-clean (single key)', async () => {
    const { container } = render(<KeyboardKey>?</KeyboardKey>);
    expect(await axe(container)).toHaveNoViolations();
  });

  it('axe-clean (chord composition with separator + sibling key)', async () => {
    const { container } = render(
      <p>
        Press <KeyboardKey>Shift</KeyboardKey>+<KeyboardKey>A</KeyboardKey>
      </p>,
    );
    expect(await axe(container)).toHaveNoViolations();
    expect(screen.getAllByText(/Shift|A/)).toHaveLength(2);
  });
});
