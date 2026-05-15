/**
 * M2 GH-auth modal unit tests (gh#12 AC-1; B4 §7.2).
 *
 * Cycle-1.5 F3: adds axe-core a11y assertion (parity with the Sprint 4
 * M3 / M5 / PacketView specs).
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { axe } from 'jest-axe';
import { describe, expect, it, vi } from 'vitest';
import { M2GhAuthModal } from '@/components/screens/M2GhAuthModal';

describe('<M2GhAuthModal>', () => {
  it('renders the gh auth login command in mono', () => {
    render(<M2GhAuthModal open onClose={() => {}} onRetry={() => {}} />);
    const cmd = screen.getByLabelText('Run this command in your terminal');
    expect(cmd.textContent).toBe('gh auth login');
  });

  it('Retry calls onRetry once and disables itself while pending', async () => {
    let resolveRetry: () => void = () => {};
    const retryPromise = new Promise<void>((resolve) => {
      resolveRetry = resolve;
    });
    const onRetry = vi.fn().mockImplementation(() => retryPromise);
    render(<M2GhAuthModal open onClose={() => {}} onRetry={onRetry} />);
    const retryBtn = screen.getByTestId('m2-retry') as HTMLButtonElement;
    await act(async () => {
      retryBtn.click();
    });
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(retryBtn.disabled).toBe(true);
    expect(retryBtn.textContent).toContain('Retrying');
    await act(async () => {
      resolveRetry();
      await retryPromise;
    });
    await waitFor(() => {
      expect(retryBtn.disabled).toBe(false);
    });
  });

  it('Cancel calls onClose', () => {
    const onClose = vi.fn();
    render(<M2GhAuthModal open onClose={onClose} onRetry={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalled();
  });

  it('renders the original error detail when supplied', () => {
    render(
      <M2GhAuthModal
        open
        onClose={() => {}}
        onRetry={() => {}}
        errorDetail="exit 3: not logged in"
      />,
    );
    expect(screen.getByTestId('m2-error-detail').textContent).toContain(
      'exit 3: not logged in',
    );
  });

  it('omits the error banner when errorDetail is null/undefined', () => {
    render(<M2GhAuthModal open onClose={() => {}} onRetry={() => {}} />);
    expect(screen.queryByTestId('m2-error-detail')).toBeNull();
  });

  // Cycle-1.5 F3 (gh#12): a11y scan parity with Sprint 4 modals.
  it('passes axe a11y scan', async () => {
    const { container } = render(
      <M2GhAuthModal
        open
        onClose={() => {}}
        onRetry={() => {}}
        errorDetail="exit 3: not logged in"
      />,
    );
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });

  it('Copy button toggles label to "Copied" on click (best-effort)', async () => {
    // Mock navigator.clipboard.writeText so it resolves; the modal
    // should flip the label and revert after the timer.
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });
    render(<M2GhAuthModal open onClose={() => {}} onRetry={() => {}} />);
    const copyBtn = screen.getByTestId('m2-copy') as HTMLButtonElement;
    await act(async () => {
      copyBtn.click();
    });
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith('gh auth login');
    });
    expect(copyBtn.textContent).toContain('Copied');
  });
});
