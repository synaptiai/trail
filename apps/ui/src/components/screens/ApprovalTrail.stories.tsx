import type { Meta, StoryObj } from '@storybook/react';
import { ApprovalTrail } from './ApprovalTrail';
import type { ApprovalTrailEntryShape } from '@/services/packet-loader';

const ENTRIES: ApprovalTrailEntryShape[] = [
  {
    claim_id: 'CLAIM-001',
    decision: 'accept',
    reason: 'looks fine — approved',
    by: 'daniel',
    at: '2026-05-09T11:50:00.000+00:00',
  },
  {
    claim_id: 'cccccccccccccccc',
    decision: 'reject',
    reason: 'cannot ship with auth bypass — please redo',
    by: 'reviewer-A',
    at: '2026-05-09T11:51:00.000+00:00',
  },
  {
    claim_id: 'CLAIM-007',
    decision: 'changes',
    reason: null,
    by: 'reviewer-B',
    at: '2026-05-09T11:55:00.000+00:00',
  },
  {
    claim_id: 'CLAIM-008',
    decision: 'block',
    reason: 'awaiting upstream policy decision',
    by: 'reviewer-A',
    at: '2026-05-09T11:58:00.000+00:00',
  },
];

const meta: Meta<typeof ApprovalTrail> = {
  title: 'Screens/ApprovalTrail',
  component: ApprovalTrail,
};
export default meta;

type Story = StoryObj<typeof ApprovalTrail>;

export const ThreeDecisions: Story = {
  args: { entries: ENTRIES.slice(0, 3), persona: 'creator' },
};

export const AllFourDecisionTones: Story = {
  args: { entries: ENTRIES, persona: 'reviewer' },
};

export const EmptyCreator: Story = { args: { entries: [], persona: 'creator' } };

export const EmptyAuditorHighRisk: Story = {
  args: { entries: [], persona: 'auditor', audit_high_risk_unrecorded: true },
};

export const EmptyAuditorLowRisk: Story = {
  args: { entries: [], persona: 'auditor', audit_high_risk_unrecorded: false },
};
