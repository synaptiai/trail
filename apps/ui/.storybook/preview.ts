import type { Preview } from '@storybook/react';
import '@/design/global.css';
import '@/design/tokens.css';
import '@/design/fonts.css';
import '@/design/motion.css';

/**
 * Storybook preview wiring (gh#9 criterion 9).
 *
 * Loads Trail's design-token CSS so every story renders in the production
 * theme. The default backgrounds are the dark-mode ink / paper-50 surfaces
 * mirroring tokens.css.
 */
const preview: Preview = {
  parameters: {
    backgrounds: {
      default: 'ink',
      values: [
        { name: 'ink', value: '#0E1116' },
        { name: 'paper', value: '#F8F6F2' },
      ],
    },
    a11y: {
      // Run the full axe rule set; the components in Sprint 3a are
      // accessibility-load-bearing (risk encoding, packet header landmark).
      element: '#storybook-root',
      manual: false,
    },
  },
};

export default preview;
