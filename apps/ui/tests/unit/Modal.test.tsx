import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { axe } from 'jest-axe';
import { Modal, Button } from '@/components/primitives';

describe('<Modal>', () => {
  it('renders the dialog with ARIA wiring when open', () => {
    render(
      <Modal open onClose={() => {}} title="Override risk" subtitle="Bump from MED to HIGH">
        <p>Reason field</p>
      </Modal>,
    );
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAttribute('aria-labelledby');
    expect(screen.getByText('Override risk')).toBeInTheDocument();
    expect(screen.getByText('Bump from MED to HIGH')).toBeInTheDocument();
  });

  it('does not render when open=false', () => {
    render(<Modal open={false} onClose={() => {}} title="Closed" />);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('closes on Escape when dismissible (default)', async () => {
    const onClose = vi.fn();
    render(<Modal open onClose={onClose} title="X" />);
    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('does NOT close on Escape when dismissible=false', async () => {
    const onClose = vi.fn();
    render(<Modal open onClose={onClose} title="X" dismissible={false} />);
    await userEvent.keyboard('{Escape}');
    expect(onClose).not.toHaveBeenCalled();
  });

  it('closes on backdrop click when dismissible', () => {
    const onClose = vi.fn();
    const { container } = render(<Modal open onClose={onClose} title="X" />);
    const backdrop = container.querySelector('.modal__backdrop');
    expect(backdrop).not.toBeNull();
    fireEvent.click(backdrop!);
    expect(onClose).toHaveBeenCalled();
  });

  it('places initial focus on the first focusable child', () => {
    render(
      <Modal open onClose={() => {}} title="Decision">
        <Button>First</Button>
        <Button>Last</Button>
      </Modal>,
    );
    const buttons = screen.getAllByRole('button');
    expect(buttons.length).toBeGreaterThanOrEqual(2);
    expect(document.activeElement?.textContent).toBe('First');
  });

  it('Tab from the last focusable wraps to the first (focus-trap forward)', () => {
    // Per PR #6 cycle-1 review F7: the previous test only asserted initial
    // focus; the trap mechanism itself (Modal.tsx:82-95) had zero coverage.
    // Cycle-2 N12 strengthening: spy on preventDefault to confirm the trap
    // is the cause of the focus move (not some incidental DOM behavior).
    render(
      <Modal open onClose={() => {}} title="Decision">
        <Button>First</Button>
        <Button>Last</Button>
      </Modal>,
    );
    const buttons = screen.getAllByRole('button');
    const first = buttons[0]!;
    const last = buttons[buttons.length - 1]!;
    last.focus();
    expect(document.activeElement).toBe(last);
    // Tab from the last focusable: trap should preventDefault and wrap to first.
    const event = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    const preventSpy = vi.spyOn(event, 'preventDefault');
    fireEvent(last, event);
    expect(preventSpy).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(first);
  });

  it('Shift+Tab from the first focusable wraps to the last (focus-trap backward)', () => {
    // Cycle-2 N12 strengthening: spy on preventDefault.
    render(
      <Modal open onClose={() => {}} title="Decision">
        <Button>First</Button>
        <Button>Middle</Button>
        <Button>Last</Button>
      </Modal>,
    );
    const buttons = screen.getAllByRole('button');
    const first = buttons[0]!;
    const last = buttons[buttons.length - 1]!;
    first.focus();
    expect(document.activeElement).toBe(first);
    const event = new KeyboardEvent('keydown', {
      key: 'Tab',
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });
    const preventSpy = vi.spyOn(event, 'preventDefault');
    fireEvent(first, event);
    expect(preventSpy).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(last);
  });

  it('two modals stacked do NOT collide on aria-labelledby ID (cycle-1.5 F8)', () => {
    // Cycle-1 review F8 (P2): the Modal primitive used a hardcoded
    // `id="modal-title"` so two simultaneously-mounted modals (e.g.,
    // M5 + M6 stacked from PacketView) produced duplicate DOM IDs and
    // screen-reader ambiguity. The fix uses React's useId() to scope
    // each modal's title/subtitle IDs per-instance.
    const { container } = render(
      <div>
        <Modal open onClose={() => {}} title="First modal" subtitle="First subtitle">
          <p>First body</p>
        </Modal>
        <Modal open onClose={() => {}} title="Second modal" subtitle="Second subtitle">
          <p>Second body</p>
        </Modal>
      </div>,
    );
    const dialogs = container.querySelectorAll('[role="dialog"]');
    expect(dialogs).toHaveLength(2);
    const first = dialogs[0]!;
    const second = dialogs[1]!;
    const firstLabelId = first.getAttribute('aria-labelledby')!;
    const secondLabelId = second.getAttribute('aria-labelledby')!;
    expect(firstLabelId).not.toBe('');
    expect(secondLabelId).not.toBe('');
    // Critical invariant: the two aria-labelledby targets MUST be distinct.
    expect(firstLabelId).not.toBe(secondLabelId);
    // The corresponding <h2> elements must use those scoped IDs.
    expect(container.querySelector(`#${CSS.escape(firstLabelId)}`)?.textContent).toBe(
      'First modal',
    );
    expect(container.querySelector(`#${CSS.escape(secondLabelId)}`)?.textContent).toBe(
      'Second modal',
    );
    // Subtitle IDs must also be distinct.
    const firstSubId = first.getAttribute('aria-describedby')!;
    const secondSubId = second.getAttribute('aria-describedby')!;
    expect(firstSubId).not.toBe(secondSubId);
    // No two elements in the document share an ID — the lit invariant
    // any HTML validator catches.
    const ids = Array.from(container.querySelectorAll('[id]')).map((el) => el.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  // Per PR #21 cycle-1.5 review F1: the closure claim "all 13 primitives
  // axe-clean" required an explicit axe(container) scan in this file
  // (previously Modal was only verified transitively via M1-M6 + PacketView).
  // Cycle-1.5 fix converts the claim from approximately-true to literally-true.
  it('passes axe-core a11y scan with title + subtitle + body + footer', async () => {
    const { container } = render(
      <Modal
        open
        onClose={() => {}}
        title="Override risk"
        subtitle="Bump from MED to HIGH"
        footer={<Button>Confirm</Button>}
      >
        <p>Reason field</p>
      </Modal>,
    );
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });

  it('Tab in the middle does NOT preventDefault (browser default cycle within modal)', () => {
    // Cycle-2 N12: spy directly on preventDefault to make the assertion
    // robust against fireEvent return-value semantics.
    render(
      <Modal open onClose={() => {}} title="Decision">
        <Button>First</Button>
        <Button>Middle</Button>
        <Button>Last</Button>
      </Modal>,
    );
    const buttons = screen.getAllByRole('button');
    const middle = buttons[1]!;
    middle.focus();
    const event = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    const preventSpy = vi.spyOn(event, 'preventDefault');
    fireEvent(middle, event);
    expect(preventSpy).not.toHaveBeenCalled();
  });
});
