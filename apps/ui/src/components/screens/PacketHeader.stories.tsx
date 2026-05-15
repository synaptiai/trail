import type { Meta, StoryObj } from '@storybook/react';
import { PacketHeader } from './PacketHeader';
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
  branch: 'main',
};

const meta: Meta<typeof PacketHeader> = {
  title: 'Screens/PacketHeader',
  component: PacketHeader,
};
export default meta;

type Story = StoryObj<typeof PacketHeader>;

export const RootCapture: Story = {
  args: { header: HEADER_BASE, claim_count: 12 },
};

export const RecaptureUnknownDepth: Story = {
  args: {
    header: {
      ...HEADER_BASE,
      parent_packet_id: '01ARZ3NDEKTSV4RRFFQ69G5FAW',
      packet_n: null, // chain depth unknown — Sprint 3a state
      is_recapture: true,
    },
    claim_count: 12,
  },
};

export const RecaptureKnownDepth: Story = {
  args: {
    header: {
      ...HEADER_BASE,
      parent_packet_id: '01ARZ3NDEKTSV4RRFFQ69G5FAW',
      packet_n: 3, // Sprint 4 will populate this from libSQL chain walk
      is_recapture: true,
    },
    claim_count: 12,
  },
};

export const WithDecisionsAndRedactions: Story = {
  args: { header: HEADER_BASE, claim_count: 12, decided_count: 8, redaction_count: 3 },
};

export const SingleClaim: Story = {
  args: { header: HEADER_BASE, claim_count: 1, redaction_count: 1 },
};
