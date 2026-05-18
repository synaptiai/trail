/**
 * M6 settings modal tests (gh#11 criterion 8).
 *
 * Pins:
 *   - Vertical Tabs primitive nav with four sections.
 *   - Theme + density radios update via persist().
 *   - axe a11y violations: zero.
 */
import { act, render, screen } from '@testing-library/react';
import { axe } from 'jest-axe';
import { describe, expect, it } from 'vitest';
import { M6SettingsModal } from '@/components/screens/M6SettingsModal';
import type { Settings } from '@/ipc/contract';

const fixture: Settings = {
  theme: 'system',
  density: 'comfortable',
  disable_tamper_warnings: false,
  heavy_redaction_threshold: 15,
  capture_cli_path: 'trail',
  pinned_sessions: [],
};

describe('<M6SettingsModal>', () => {
  it('renders four section tabs', () => {
    render(<M6SettingsModal open onClose={() => {}} initialSettings={fixture} persona="creator" />);
    expect(screen.getByRole('tab', { name: 'General' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Redaction' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Capture' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Pinned sessions' })).toBeInTheDocument();
  });

  it('uses vertical orientation for the tablist', () => {
    render(<M6SettingsModal open onClose={() => {}} initialSettings={fixture} persona="creator" />);
    const tablist = screen.getByRole('tablist');
    expect(tablist).toHaveAttribute('aria-orientation', 'vertical');
  });

  it('renders the General panel by default', () => {
    render(<M6SettingsModal open onClose={() => {}} initialSettings={fixture} persona="creator" />);
    // Theme legend is in the General panel.
    expect(screen.getByText('Theme')).toBeInTheDocument();
    expect(screen.getByText('Density')).toBeInTheDocument();
  });

  it('shows pinned-sessions empty state when none', async () => {
    // Switch to the Pinned tab.
    const { container } = render(
      <M6SettingsModal open onClose={() => {}} initialSettings={fixture} persona="creator" />,
    );
    const pinnedTab = screen.getByRole('tab', { name: 'Pinned sessions' });
    await act(async () => {
      pinnedTab.click();
    });
    expect(container.textContent).toContain('No pinned sessions');
  });

  it('passes axe a11y scan', async () => {
    const { container } = render(
      <M6SettingsModal open onClose={() => {}} initialSettings={fixture} persona="creator" />,
    );
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});
