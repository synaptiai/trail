import type { Meta, StoryObj } from '@storybook/react';
import { RiskHistogram } from './RiskHistogram';

const meta: Meta<typeof RiskHistogram> = {
  title: 'Screens/RiskHistogram',
  component: RiskHistogram,
};
export default meta;

type Story = StoryObj<typeof RiskHistogram>;

/** Canonical 12-claim packet shape per B4 §4.2 ("LOW 7 · MED 3 · HIGH 1 · CRIT 0"). */
export const Canonical: Story = {
  args: {
    histogram: { low: 7, med: 3, high: 1, crit: 0, classified_total: 11 },
  },
};

export const HighDensity: Story = {
  args: {
    histogram: { low: 25, med: 18, high: 8, crit: 3, classified_total: 54 },
  },
};

/** Empty bins still render — four-bin structure preserved per B3 §4.3.1. */
export const AllZero: Story = {
  args: {
    histogram: { low: 0, med: 0, high: 0, crit: 0, classified_total: 0 },
  },
};

/** Single critical claim — exercises the CRIT pigment per B6 P1 (brightened). */
export const SingleCrit: Story = {
  args: {
    histogram: { low: 0, med: 0, high: 0, crit: 1, classified_total: 1 },
  },
};
