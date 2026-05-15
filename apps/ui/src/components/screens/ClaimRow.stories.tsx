import type { Meta, StoryObj } from '@storybook/react';
import { ClaimRow } from './ClaimRow';
import type { PacketClaimShape } from '@/services/packet-loader';

const CLAIM_HIGH: PacketClaimShape = {
  id: 'CLAIM-001',
  stable_id: '15b335d83a23a339',
  text: 'updates redirect_uri allowlist to require https + subdomain match',
  evidence_refs: ['DIFF-045', 'TEST-012'],
  evidence_count: 2,
  confidence: 'supported',
  risk_level: 'high',
};

const meta: Meta<typeof ClaimRow> = {
  title: 'Screens/ClaimRow',
  component: ClaimRow,
};
export default meta;

type Story = StoryObj<typeof ClaimRow>;

export const HighRiskCollapsed: Story = { args: { claim: CLAIM_HIGH } };

export const HighRiskExpanded: Story = {
  args: { claim: CLAIM_HIGH, defaultExpanded: true },
};

export const LowRisk: Story = {
  args: {
    claim: { ...CLAIM_HIGH, id: 'CLAIM-002', risk_level: 'low', text: 'rename internal helper' },
  },
};

export const Critical: Story = {
  args: {
    claim: { ...CLAIM_HIGH, id: 'CLAIM-003', risk_level: 'crit', text: 'auth bypass via header parsing' },
  },
};

export const Unclassified: Story = {
  args: {
    claim: { ...CLAIM_HIGH, id: 'CLAIM-004', risk_level: null, text: 'phase-1-emitted unclassified claim' },
  },
};

export const LongText: Story = {
  args: {
    claim: {
      ...CLAIM_HIGH,
      id: 'CLAIM-005',
      text: 'x'.repeat(280),
    },
  },
};
