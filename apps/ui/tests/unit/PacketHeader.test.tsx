import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { axe } from 'jest-axe';
import { PacketHeader } from '@/components/screens/PacketHeader';
import type { PacketHeaderShape } from '@/services/packet-loader';

const HEADER_BASE: PacketHeaderShape = {
  packet_id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
  session_id: '18e374b5-4eb9-424d-a3ff-a639d1c6fada',
  generated_at: '2026-05-09T12:00:00.000+00:00',
  generator_name: 'trail',
  generator_version: '0.1.0-dev',
  schema_version: '0.1.1',
  parent_packet_id: null,
  packet_n: 1,
  is_recapture: false,
  repository: 'synaptiai/trail',
  branch: 'feature/test',
};

describe('<PacketHeader>', () => {
  it('renders repository / branch + ULID + session + generated time', () => {
    render(<PacketHeader header={HEADER_BASE} claim_count={12} />);
    expect(screen.getByText(/synaptiai\/trail/)).toBeInTheDocument();
    expect(screen.getByText(/feature\/test/)).toBeInTheDocument();
    // Truncated ULID surface — full ID lives in title attribute
    expect(screen.getByText('01ARZ3ND…')).toBeInTheDocument();
    expect(screen.getByText('01ARZ3ND…').getAttribute('title')).toBe(
      '01ARZ3NDEKTSV4RRFFQ69G5FAV',
    );
    // Generator metadata
    expect(screen.getByText(/trail v0\.1\.0-dev/)).toBeInTheDocument();
    expect(screen.getByText(/v0\.1\.1/)).toBeInTheDocument();
  });

  it('omits the packet-N hint when is_recapture=false (root capture)', () => {
    render(<PacketHeader header={HEADER_BASE} claim_count={12} />);
    expect(screen.queryByText(/packet-1$/)).toBeNull();
    expect(screen.queryByText(/^re-captured$/)).toBeNull();
  });

  it('renders "re-captured" hint when is_recapture but chain depth unknown', () => {
    const recap: PacketHeaderShape = {
      ...HEADER_BASE,
      parent_packet_id: '01ARZ3NDEKTSV4RRFFQ69G5FAW',
      packet_n: null,
      is_recapture: true,
    };
    render(<PacketHeader header={recap} claim_count={12} />);
    const chip = screen.getByText(/^re-captured$/);
    expect(chip).toBeInTheDocument();
    expect(chip.getAttribute('aria-label')).toMatch(/Re-capture: this packet has a parent/);
  });

  it('renders "packet-N" hint when chain depth is known (Sprint 4 will populate this)', () => {
    const recap: PacketHeaderShape = {
      ...HEADER_BASE,
      parent_packet_id: '01ARZ3NDEKTSV4RRFFQ69G5FAW',
      packet_n: 3,
      is_recapture: true,
    };
    render(<PacketHeader header={recap} claim_count={12} />);
    const chip = screen.getByText(/^packet-3$/);
    expect(chip).toBeInTheDocument();
    expect(chip.getAttribute('aria-label')).toMatch(/Re-capture: this is packet number 3/);
  });

  it('renders decided/redaction counts when supplied', () => {
    render(
      <PacketHeader
        header={HEADER_BASE}
        claim_count={12}
        decided_count={4}
        redaction_count={3}
      />,
    );
    expect(screen.getByText(/12 claims · 4 of 12 decided · 3 redactions/)).toBeInTheDocument();
  });

  it('uses singular nouns when counts equal 1', () => {
    render(<PacketHeader header={HEADER_BASE} claim_count={1} redaction_count={1} />);
    expect(screen.getByText(/^1 claim · 1 redaction$/)).toBeInTheDocument();
  });

  it('exposes a header landmark for assistive tech', () => {
    render(<PacketHeader header={HEADER_BASE} claim_count={12} />);
    const banner = screen.getByRole('banner');
    expect(banner).toBeInTheDocument();
    expect(banner.getAttribute('aria-label')).toBe('Packet metadata');
  });

  it('passes axe-core a11y scan', async () => {
    const { container } = render(<PacketHeader header={HEADER_BASE} claim_count={12} />);
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});
