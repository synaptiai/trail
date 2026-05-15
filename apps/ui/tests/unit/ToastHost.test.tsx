import { render, screen, act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastHost, emitToast } from '@/components/screens/ToastHost';

/**
 * Live-region semantics (B3 §12.5; per PR #6 cycle-1 review F12).
 *
 * Asserts:
 *   1. The polite + assertive regions are mounted with the correct ARIA
 *      attributes (role, aria-live, aria-atomic).
 *   2. An assertive toast dismisses any live polite toast (single-message
 *      ordering, per WAI-ARIA APG).
 *   3. Polite toasts auto-expire on a timer.
 */

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('<ToastHost>', () => {
  it('mounts both live regions with the correct ARIA wiring', () => {
    const { container } = render(<ToastHost />);
    const polite = container.querySelector('[role="status"]');
    const assertive = container.querySelector('[role="alert"]');
    expect(polite).not.toBeNull();
    expect(polite!.getAttribute('aria-live')).toBe('polite');
    expect(polite!.getAttribute('aria-atomic')).toBe('true');
    expect(assertive).not.toBeNull();
    expect(assertive!.getAttribute('aria-live')).toBe('assertive');
    expect(assertive!.getAttribute('aria-atomic')).toBe('true');
  });

  it('an assertive (error) toast dismisses any live polite toast', () => {
    render(<ToastHost />);
    act(() => {
      emitToast({ tone: 'info', title: 'Posted to PR' });
    });
    expect(screen.getByText('Posted to PR')).toBeInTheDocument();
    act(() => {
      emitToast({ tone: 'error', title: 'Tamper detected' });
    });
    // Polite toast must be gone — single-message ordering per F12.
    expect(screen.queryByText('Posted to PR')).toBeNull();
    expect(screen.getByText('Tamper detected')).toBeInTheDocument();
    // Cycle-2 N24: the polite toast's auto-dismiss timer should be a no-op
    // by the time it fires (the polite slot is already null). Advancing
    // through the polite TTL must NOT resurrect the polite text and must NOT
    // affect the assertive toast's persistence.
    act(() => {
      vi.advanceTimersByTime(4_001);
    });
    expect(screen.queryByText('Posted to PR')).toBeNull();
    expect(screen.getByText('Tamper detected')).toBeInTheDocument();
  });

  it('polite toast auto-dismisses after 4 seconds', () => {
    render(<ToastHost />);
    act(() => {
      emitToast({ tone: 'info', title: 'New packet captured' });
    });
    expect(screen.getByText('New packet captured')).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(4_001);
    });
    expect(screen.queryByText('New packet captured')).toBeNull();
  });

  it('assertive toast persists 8 seconds', () => {
    render(<ToastHost />);
    act(() => {
      emitToast({ tone: 'error', title: 'IPC failed' });
    });
    expect(screen.getByText('IPC failed')).toBeInTheDocument();
    // Still present at 7s.
    act(() => {
      vi.advanceTimersByTime(7_000);
    });
    expect(screen.getByText('IPC failed')).toBeInTheDocument();
    // Gone at 8s+.
    act(() => {
      vi.advanceTimersByTime(1_500);
    });
    expect(screen.queryByText('IPC failed')).toBeNull();
  });
});
