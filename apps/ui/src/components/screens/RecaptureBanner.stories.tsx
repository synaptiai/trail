import type { Meta, StoryObj } from '@storybook/react';
import { RecaptureBanner } from './RecaptureBanner';

const meta: Meta<typeof RecaptureBanner> = {
  title: 'Screens/RecaptureBanner',
  component: RecaptureBanner,
};
export default meta;

type Story = StoryObj<typeof RecaptureBanner>;

export const Default: Story = {
  args: {
    parent_packet_id: '01ARZ3NDEKTSV4RRFFQ69G5FAW',
    claim_count: 12,
  },
};

export const SingleClaim: Story = {
  args: { parent_packet_id: '01ARZ3NDEKTSV4RRFFQ69G5FAW', claim_count: 1 },
};

export const HighCardinality: Story = {
  args: { parent_packet_id: '01ARZ3NDEKTSV4RRFFQ69G5FAW', claim_count: 84 },
};

export const WithClickHandler: Story = {
  args: {
    parent_packet_id: '01ARZ3NDEKTSV4RRFFQ69G5FAW',
    claim_count: 12,
    onOpenRecaptureReview: (id: string) => {
      console.log('Recapture review opened for parent:', id);
    },
  },
};
