import { useCallback, useEffect, useRef, useState } from 'react';
import { Toast, type ToastTone } from '@/components/primitives';
import './ToastHost.css';

/**
 * <ToastHost> — single mount point for live-region toast announcements.
 *
 * Two channels (per B3 §12.5):
 *   polite — `<div role="status" aria-live="polite">` for routine surfaces
 *            (J1 "New packet captured", J5 "Posted to PR", info)
 *   assertive — `<div role="alert">` for errors and tamper-adjacent events
 *
 * AT only announces the latest message in each channel; replacing a polite
 * message with another polite message updates the same node so the queue
 * doesn't backlog.
 *
 * Per PR #6 cycle-1 review F12 (P2 accessibility refined):
 *   - Both regions carry `aria-atomic="true"` so ATs announce the full toast
 *     (title + description) on every update — without atomic the partial
 *     change re-announces the title only and confuses listeners.
 *   - When an assertive toast appears while a polite toast is live, the
 *     polite toast is dismissed immediately. WAI-ARIA APG recommends a
 *     single live region per priority class with explicit ordering; this
 *     prevents a polite "Posted to PR" from announcing on top of an
 *     assertive "Tamper detected".
 */

interface ToastEntry {
  id: number;
  tone: ToastTone;
  title: string;
  description?: string;
}

let nextId = 1;
const subscribers = new Set<(entry: ToastEntry) => void>();

/** Global toast emitter — call from anywhere, the host renders. */
export function emitToast(entry: Omit<ToastEntry, 'id'>): void {
  const next = { ...entry, id: nextId++ } satisfies ToastEntry;
  subscribers.forEach((sub) => sub(next));
}

export function ToastHost() {
  const [polite, setPolite] = useState<ToastEntry | null>(null);
  const [assertive, setAssertive] = useState<ToastEntry | null>(null);
  const timers = useRef<Map<number, number>>(new Map());

  useEffect(() => {
    const localTimers = timers.current;
    const handle = (entry: ToastEntry) => {
      if (entry.tone === 'error') {
        // F12: dismiss any live polite toast so the assertive announcement
        // is the only message AT consumes.
        setPolite(null);
        setAssertive(entry);
      } else {
        setPolite(entry);
      }
      const ttl = entry.tone === 'error' ? 8_000 : 4_000;
      const channelSetter = entry.tone === 'error' ? setAssertive : setPolite;
      const timeoutHandle = window.setTimeout(() => {
        channelSetter((current) => (current?.id === entry.id ? null : current));
        localTimers.delete(entry.id);
      }, ttl);
      localTimers.set(entry.id, timeoutHandle);
    };
    subscribers.add(handle);
    return () => {
      subscribers.delete(handle);
      localTimers.forEach((id) => window.clearTimeout(id));
      localTimers.clear();
    };
  }, []);

  const dismiss = useCallback((channel: 'polite' | 'assertive') => {
    if (channel === 'polite') setPolite(null);
    else setAssertive(null);
  }, []);

  return (
    <>
      <div
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className="toast-host toast-host--polite"
      >
        {polite ? (
          <Toast
            tone={polite.tone}
            title={polite.title}
            {...(polite.description ? { description: polite.description } : {})}
            onDismiss={() => dismiss('polite')}
          />
        ) : null}
      </div>
      <div
        role="alert"
        aria-live="assertive"
        aria-atomic="true"
        className="toast-host toast-host--assertive"
      >
        {assertive ? (
          <Toast
            tone={assertive.tone}
            title={assertive.title}
            {...(assertive.description ? { description: assertive.description } : {})}
            onDismiss={() => dismiss('assertive')}
          />
        ) : null}
      </div>
    </>
  );
}
