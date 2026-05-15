import { useCallback, useEffect, useMemo, useState } from 'react';
import { HorizonLine } from '@/components/primitives';
import { TopBar } from '@/components/screens/TopBar';
import { TrailSidebar } from '@/components/screens/TrailSidebar';
import { PacketView } from '@/components/screens/PacketView';
import { FirstRun } from '@/components/screens/FirstRun';
import { ToastHost } from '@/components/screens/ToastHost';
import { KeyboardOverlay } from '@/components/screens/KeyboardOverlay';
import { M6SettingsModal } from '@/components/screens/M6SettingsModal';
import {
  DiffHunkPerfHarness,
  type PerfKind,
} from '@/components/screens/DiffHunkPerfHarness';
import { prewarmHighlighter } from '@/services/highlight';
import { isTextEntryTarget } from '@/services/keyboard';
import type { Persona } from '@/ipc/contract';
import './App.css';

/**
 * <App> — Trail's single-window React shell.
 *
 * Sprint 4 (gh#11) layer additions:
 *   - App-level handlers for `?` (KeyboardOverlay) + settings cog (M6).
 *   - Defensive clipboard.writeText wrapper (B5 §6.2): when M3 is open,
 *     the wrapper rejects writes so a third-party paste-button cannot
 *     extract the previewed value.
 */

function readPersonaFromUrl(): Persona {
  if (typeof window === 'undefined') return 'creator';
  const param = new URLSearchParams(window.location.search).get('mode');
  if (param === 'reviewer' || param === 'auditor') return param;
  if (param === 'creator' || param == null) return 'creator';
  console.warn(`[Trail] Unknown ?mode=${param} — falling back to creator.`);
  return 'creator';
}

function readPerfModeFromUrl(): PerfKind | null {
  if (typeof window === 'undefined') return null;
  const param = new URLSearchParams(window.location.search).get('perf');
  if (param === 'diff-hunk-cold' || param === 'diff-hunk-warm' || param === 'diff-hunk-stress') {
    return param;
  }
  return null;
}

export function App() {
  const persona = useMemo(readPersonaFromUrl, []);
  const perfMode = useMemo(readPerfModeFromUrl, []);
  const [activePacketId, setActivePacketId] = useState<string | null>(null);
  const [overlayOpen, setOverlayOpen] = useState<boolean>(false);
  const [settingsOpen, setSettingsOpen] = useState<boolean>(false);

  useEffect(() => {
    if (perfMode === 'diff-hunk-cold') return;
    prewarmHighlighter().catch((err: unknown) => {
      console.warn('[Trail] shiki pre-warm failed:', err);
    });
  }, [perfMode]);

  // Sprint 4: app-level `?` shortcut opens the keyboard overlay shell.
  // Single document-level listener; suppresses inside text-entry targets
  // per the shared isTextEntryTarget helper.
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key !== '?') return;
      if (isTextEntryTarget(event)) return;
      event.preventDefault();
      setOverlayOpen(true);
    };
    document.addEventListener('keydown', handler);
    return () => {
      document.removeEventListener('keydown', handler);
    };
  }, []);

  // Sprint 4 (B5 §6.2): clipboard.writeText defense-in-depth wrapper.
  // M3 sets window.__trailInRedactionPreview=true while the modal is
  // open; this wrapper rejects every writeText call in that window so a
  // third-party "Copy" button cannot extract the preview value.
  //
  // Cycle-1.5 F7 (P3 — layered-defense documentation). This wrapper is
  // ONE LAYER of defense, not the only one:
  //   1. The capture pipeline writes redacted YAML only; the original
  //      token is never persisted on disk (B6 P1). The
  //      `preview_redacted` IPC at apps/ui/src-tauri/src/ipc.rs:712
  //      always returns `{ original: None }`. Even with full IPC
  //      compromise, no original can be exfiltrated because none
  //      exists.
  //   2. The YAML rendering pipeline is sanitized — packets parse
  //      through `js-yaml#safeLoad` + Ajv schema validation in
  //      `parsePacketYaml`, so an injected `<script>` or
  //      `Object.defineProperty(navigator.clipboard, 'writeText', ...)`
  //      payload cannot reach the DOM via packet content. This
  //      wrapper assumes no XSS surface in the rendering layer.
  //   3. Race on rapid open-close: if a future M3 stack pattern is
  //      added (currently impossible — only one M3 mounts at a time
  //      from RedactionTab), the cleanup uses prev-snapshot semantics
  //      which would race. Document for any future stacking work.
  // Without these complementary defenses the wrapper is bypassable
  // (delete the descriptor, re-define vanilla); this is acceptable in
  // the current threat model because (1) makes a bypass useless.
  useEffect(() => {
    if (typeof navigator === 'undefined' || !navigator.clipboard?.writeText) return;
    const original = navigator.clipboard.writeText.bind(navigator.clipboard);
    const wrapped = async (text: string): Promise<void> => {
      if (window.__trailInRedactionPreview) {
        throw new Error(
          'Clipboard writes are blocked while the redaction-preview modal is open',
        );
      }
      return original(text);
    };
    Object.defineProperty(navigator.clipboard, 'writeText', {
      configurable: true,
      writable: true,
      value: wrapped,
    });
    return () => {
      Object.defineProperty(navigator.clipboard, 'writeText', {
        configurable: true,
        writable: true,
        value: original,
      });
    };
  }, []);

  const handleOpenSettings = useCallback(() => setSettingsOpen(true), []);
  const handleCloseSettings = useCallback(() => setSettingsOpen(false), []);

  if (perfMode) {
    return (
      <div className="app app--perf-mode" data-perf-mode={perfMode}>
        <main className="app__main">
          <DiffHunkPerfHarness kind={perfMode} />
        </main>
      </div>
    );
  }

  return (
    <div className="app" data-persona={persona}>
      <TopBar persona={persona} onOpenSettings={handleOpenSettings} />
      <HorizonLine variant="app-chrome" />
      <main className="app__main">
        <TrailSidebar
          persona={persona}
          activePacketId={activePacketId}
          onSelect={setActivePacketId}
        />
        <section
          id="main-content"
          className="app__content"
          aria-label="Packet view"
          tabIndex={-1}
        >
          {activePacketId ? (
            <PacketView
              packetId={activePacketId}
              persona={persona}
              settingsOpen={settingsOpen}
              onSettingsClose={handleCloseSettings}
            />
          ) : (
            <FirstRun />
          )}
        </section>
      </main>
      <ToastHost />
      {overlayOpen ? (
        <KeyboardOverlay open onClose={() => setOverlayOpen(false)} />
      ) : null}
      {/* When no packet is open, settings still needs to render. */}
      {settingsOpen && !activePacketId ? (
        <M6SettingsModal open onClose={handleCloseSettings} persona={persona} />
      ) : null}
    </div>
  );
}
