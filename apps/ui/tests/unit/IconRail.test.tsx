import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { axe } from 'jest-axe';
import { IconRail } from '@/components/screens/IconRail';
import type { SidebarRow } from '@/db/queries';

function mkRow(over: Partial<SidebarRow>): SidebarRow {
  return {
    packet_id: '01ARZ3NDEKTSV4RRFFQ69G5F00',
    session_id: 'sess-1',
    display_name: 'Trail packet',
    captured_at: '2026-05-09T12:00:00Z',
    low_count: 0,
    med_count: 0,
    high_count: 1,
    crit_count: 0,
    redaction_count: 0,
    posted_to_pr_count: 0,
    ...over,
  };
}

describe('<IconRail> (gh#8 criterion 4 — narrow-width sidebar)', () => {
  it('renders one icon per packet up to maxIcons', () => {
    const rows = [
      mkRow({ packet_id: '01ARZ3NDEKTSV4RRFFQ69G5F00', display_name: 'A' }),
      mkRow({ packet_id: '01ARZ3NDEKTSV4RRFFQ69G5F01', display_name: 'B' }),
      mkRow({ packet_id: '01ARZ3NDEKTSV4RRFFQ69G5F02', display_name: 'C' }),
    ];
    render(
      <IconRail rows={rows} activePacketId={null} onSelect={() => {}} onExpand={() => {}} />,
    );
    expect(screen.getAllByRole('option')).toHaveLength(3);
  });

  it('marks the active packet with aria-selected', () => {
    const rows = [
      mkRow({ packet_id: '01ARZ3NDEKTSV4RRFFQ69G5F00', display_name: 'A' }),
      mkRow({ packet_id: '01ARZ3NDEKTSV4RRFFQ69G5F01', display_name: 'B' }),
    ];
    render(
      <IconRail
        rows={rows}
        activePacketId="01ARZ3NDEKTSV4RRFFQ69G5F01"
        onSelect={() => {}}
        onExpand={() => {}}
      />,
    );
    const options = screen.getAllByRole('option');
    // Index 0 is row A (active=false); index 1 is row B (active=true).
    expect(options[0]?.getAttribute('aria-selected')).toBe('false');
    expect(options[1]?.getAttribute('aria-selected')).toBe('true');
  });

  it('clicking an icon calls onSelect with packet_id', () => {
    const rows = [mkRow({ packet_id: '01ARZ3NDEKTSV4RRFFQ69G5F00', display_name: 'A' })];
    const onSelect = vi.fn();
    render(<IconRail rows={rows} activePacketId={null} onSelect={onSelect} onExpand={() => {}} />);
    fireEvent.click(screen.getByRole('option', { name: /Open packet A/i }));
    expect(onSelect).toHaveBeenCalledWith('01ARZ3NDEKTSV4RRFFQ69G5F00');
  });

  it('expand button calls onExpand', () => {
    const onExpand = vi.fn();
    render(<IconRail rows={[]} activePacketId={null} onSelect={() => {}} onExpand={onExpand} />);
    fireEvent.click(screen.getByRole('button', { name: /Expand sidebar/i }));
    expect(onExpand).toHaveBeenCalled();
  });

  it('respects maxIcons limit', () => {
    const rows = Array.from({ length: 20 }, (_, i) =>
      mkRow({ packet_id: `01ARZ3NDEKTSV4RRFFQ69G5F${String(i).padStart(2, '0')}` }),
    );
    render(
      <IconRail rows={rows} activePacketId={null} onSelect={() => {}} onExpand={() => {}} maxIcons={5} />,
    );
    expect(screen.getAllByRole('option')).toHaveLength(5);
  });

  it('passes axe scan with active row', async () => {
    const rows = [
      mkRow({ packet_id: '01ARZ3NDEKTSV4RRFFQ69G5F00' }),
      mkRow({ packet_id: '01ARZ3NDEKTSV4RRFFQ69G5F01' }),
    ];
    const { container } = render(
      <IconRail
        rows={rows}
        activePacketId="01ARZ3NDEKTSV4RRFFQ69G5F00"
        onSelect={() => {}}
        onExpand={() => {}}
      />,
    );
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });

  it('shows tooltip-eligible title attribute', () => {
    const rows = [mkRow({ packet_id: '01ARZ3NDEKTSV4RRFFQ69G5F00', display_name: 'Tooltip text' })];
    render(<IconRail rows={rows} activePacketId={null} onSelect={() => {}} onExpand={() => {}} />);
    const btn = screen.getByRole('option', { name: /Open packet Tooltip text/ });
    const title = btn.getAttribute('title');
    expect(title).toContain('Tooltip text');
  });
});
