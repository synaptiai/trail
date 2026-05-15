import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { axe } from 'jest-axe';
import { useState } from 'react';
import { Tabs } from '@/components/primitives';

function Harness({ orientation = 'horizontal' as 'horizontal' | 'vertical' }: { orientation?: 'horizontal' | 'vertical' } = {}) {
  const [active, setActive] = useState('a');
  return (
    <Tabs
      orientation={orientation}
      activeId={active}
      onChange={setActive}
      items={[
        { id: 'a', label: 'Alpha' },
        { id: 'b', label: 'Beta' },
        { id: 'c', label: 'Gamma' },
      ]}
      panel={<span data-testid="panel">Panel for {active}</span>}
    />
  );
}

describe('<Tabs>', () => {
  it('renders tablist with correct ARIA wiring', () => {
    render(<Harness />);
    const list = screen.getByRole('tablist');
    expect(list).toHaveAttribute('aria-orientation', 'horizontal');
    const tabs = screen.getAllByRole('tab');
    expect(tabs).toHaveLength(3);
    expect(tabs[0]).toHaveAttribute('aria-selected', 'true');
    const panel = screen.getByRole('tabpanel');
    expect(panel).toHaveAttribute('aria-labelledby');
  });

  it('moves selection with ArrowRight/Left in horizontal mode', async () => {
    render(<Harness />);
    const tabs = screen.getAllByRole('tab');
    tabs[0]!.focus();
    await userEvent.keyboard('{ArrowRight}');
    expect(screen.getByText('Panel for b')).toBeInTheDocument();
    await userEvent.keyboard('{ArrowLeft}');
    expect(screen.getByText('Panel for a')).toBeInTheDocument();
  });

  it('uses ArrowUp/Down in vertical mode', async () => {
    render(<Harness orientation="vertical" />);
    const tabs = screen.getAllByRole('tab');
    tabs[0]!.focus();
    await userEvent.keyboard('{ArrowDown}');
    expect(screen.getByText('Panel for b')).toBeInTheDocument();
  });

  it('Home/End jump to first / last', async () => {
    render(<Harness />);
    const tabs = screen.getAllByRole('tab');
    tabs[0]!.focus();
    await userEvent.keyboard('{End}');
    expect(screen.getByText('Panel for c')).toBeInTheDocument();
    await userEvent.keyboard('{Home}');
    expect(screen.getByText('Panel for a')).toBeInTheDocument();
  });

  it('invokes onChange on click', async () => {
    const onChange = vi.fn();
    render(
      <Tabs
        items={[{ id: 'x', label: 'X' }, { id: 'y', label: 'Y' }]}
        activeId="x"
        onChange={onChange}
        panel={<span>P</span>}
      />,
    );
    await userEvent.click(screen.getByRole('tab', { name: 'Y' }));
    expect(onChange).toHaveBeenCalledWith('y');
  });

  // Per PR #21 cycle-1.5 review F1: the closure claim "all 13 primitives
  // axe-clean" required an explicit axe(container) scan in this file
  // (previously Tabs was only verified transitively via PacketView + M6).
  // Cycle-1.5 fix converts the claim from approximately-true to literally-true.
  it('passes axe-core a11y scan with 3 panes (horizontal)', async () => {
    const { container } = render(<Harness />);
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});
