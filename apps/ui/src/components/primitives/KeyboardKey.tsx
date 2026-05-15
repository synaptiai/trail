import type { ReactNode } from 'react';
import './KeyboardKey.css';

/**
 * <KeyboardKey> primitive (B3 §15.2 #9, B4 §6.7 keyboard overlay).
 *
 * Renders a single key affordance — Commit Mono, uppercase, sharp corners —
 * for shortcut hints (e.g., "Accept (a)", "Bulk-accept (Shift+A)").
 *
 * Compose multiple keys with separators for chords:
 *   <KeyboardKey>shift</KeyboardKey>+<KeyboardKey>a</KeyboardKey>
 */

export interface KeyboardKeyProps {
  children: ReactNode;
}

export function KeyboardKey({ children }: KeyboardKeyProps) {
  return <kbd className="kbd type-mono-sm">{children}</kbd>;
}
