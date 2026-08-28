import { describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useDialog } from './useDialog';

/** A dialog with two focusable controls, which is the minimum a trap can be wrong about. */
function Harness({ onClose, open = true }: { onClose: () => void; open?: boolean }) {
  const ref = useDialog<HTMLDivElement>(open, onClose);
  if (!open) return <button type="button">outside</button>;
  return (
    <>
      <button type="button">outside</button>
      <div ref={ref} role="dialog" aria-modal="true" aria-label="Test dialog" tabIndex={-1}>
        <button type="button">first</button>
        <button type="button">last</button>
      </div>
    </>
  );
}

describe('a dialog and the keyboard', () => {
  test('it takes focus when it opens, once', () => {
    render(<Harness onClose={() => {}} />);
    expect(screen.getByRole('dialog')).toHaveFocus();

    /**
     * Focus is taken on open and never taken back. An inline ref callback re-runs on every commit,
     * and while an agent streams there is a commit every few hundred milliseconds - so focus was
     * dragged out of whatever the operator had moved to, continuously.
     */
    screen.getByText('last').focus();
    fireEvent.keyDown(document, { key: 'a' });
    expect(screen.getByText('last')).toHaveFocus();
  });

  test('Escape closes it', () => {
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test('Tab cannot leave it', () => {
    render(<Harness onClose={() => {}} />);
    const [first, last] = [screen.getByText('first'), screen.getByText('last')];

    // Forward off the end wraps to the start rather than reaching the page underneath.
    last.focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(first).toHaveFocus();

    // And backwards off the start wraps to the end.
    first.focus();
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(last).toHaveFocus();

    // The button outside is never reachable while the dialog is open.
    expect(screen.getByText('outside')).not.toHaveFocus();
  });

  test('the page behind it does not scroll, and can again afterwards', () => {
    const { unmount } = render(<Harness onClose={() => {}} />);
    expect(document.body.style.overflow).toBe('hidden');
    unmount();
    // Restored to what it was, not to a hardcoded value - the page may have had its own.
    expect(document.body.style.overflow).toBe('');
  });

  test('focus goes back where it came from', () => {
    // Dismissing a dialog used to drop you at the top of the document, which on a long
    // conversation means losing your place entirely.
    render(<Harness onClose={() => {}} open={false} />);
    const opener = screen.getByText('outside');
    opener.focus();
    cleanup();

    render(<Harness onClose={() => {}} open={false} />);
    const outside = screen.getByText('outside');
    outside.focus();
    const { unmount } = render(<Harness onClose={() => {}} />);
    unmount();
    expect(outside).toHaveFocus();
  });

  test('a closed dialog listens for nothing', () => {
    const onClose = vi.fn();
    render(<Harness onClose={onClose} open={false} />);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
    expect(document.body.style.overflow).toBe('');
  });
});
