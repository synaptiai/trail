import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Button, Modal, Tabs, type TabItem } from '@/components/primitives';
import {
  detectCaptureCli,
  invoke,
  readSettings,
  validateCaptureCliPath,
  writeSettings,
} from '@/ipc/client';
import type {
  DetectCaptureCliResponse,
  Persona,
  Settings,
  ValidateCaptureCliPathResponse,
} from '@/ipc/contract';
import './M6SettingsModal.css';

/**
 * <M6SettingsModal> — Sprint 4 (gh#11 criterion 8).
 *
 * Global settings dialog with vertical Tabs primitive nav per B4 §7.4.
 * Sections:
 *   - General      theme + density
 *   - Redaction    heavy-redaction threshold + tamper-warnings toggle
 *   - Capture      CLI binary path
 *   - Pinned       pinned sessions (read-only display)
 *
 * On change → calls `write_settings` IPC + emits `settings_changed_via_ui`
 * audit event. Errors surface inline below the relevant control.
 */

export interface M6SettingsModalProps {
  open: boolean;
  onClose: () => void;
  /** Test override: skip the IPC fetch; useful in Storybook + unit tests. */
  initialSettings?: Settings;
  /** Called after every successful save. Allows callers to refetch. */
  onSettingsSaved?: (next: Settings) => void;
  /**
   * Cycle-4.5 W1 (PR #21): persona threading. The Rust `write_settings`
   * + `audit_log_append` IPCs reject auditor with PersonaForbidden;
   * the modal gates writes at the React layer too (auditor cannot
   * meaningfully open the modal in v0.1, but defence-in-depth threads
   * the persona regardless). Required so a missing prop fails type-
   * checking instead of silently coercing to undefined.
   */
  persona: Persona;
}

const SECTIONS: TabItem[] = [
  { id: 'general', label: 'General' },
  { id: 'redaction', label: 'Redaction' },
  { id: 'capture', label: 'Capture' },
  { id: 'pinned', label: 'Pinned sessions' },
];

export function M6SettingsModal({
  open,
  onClose,
  initialSettings,
  onSettingsSaved,
  persona,
}: M6SettingsModalProps) {
  const [section, setSection] = useState<string>('general');
  const [settings, setSettings] = useState<Settings | null>(initialSettings ?? null);
  const [loading, setLoading] = useState<boolean>(!initialSettings && open);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || initialSettings) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    readSettings()
      .then((s) => {
        if (cancelled) return;
        setSettings(s);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Failed to load settings');
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, initialSettings]);

  const persist = useCallback(
    async (partial: Partial<Settings>) => {
      try {
        await writeSettings(partial, persona);
        const next = await readSettings();
        setSettings(next);
        // Audit log (UI-attributable event — restricted enum).
        // Cycle-4.5 W2 (PR #21): persona threading on audit_log_append.
        invoke('audit_log_append', {
          event_type: 'settings_changed_via_ui',
          details: partial as Record<string, unknown>,
          persona,
        }).catch((e: unknown) => {
          console.warn('[Trail] settings audit log append failed:', e);
        });
        onSettingsSaved?.(next);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Save failed');
      }
    },
    [onSettingsSaved, persona],
  );

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Settings"
      subtitle="Trail global preferences"
      size="lg"
      footer={
        <Button variant="primary" size="md" onClick={onClose}>
          Done
        </Button>
      }
    >
      {loading ? (
        <p className="m6__loading type-body-sm">Loading settings…</p>
      ) : error ? (
        <p className="m6__error type-body-sm" role="alert">
          {error}
        </p>
      ) : settings ? (
        <Tabs
          orientation="vertical"
          items={SECTIONS}
          activeId={section}
          onChange={setSection}
          label="Settings sections"
          panel={
            section === 'general' ? (
              <GeneralPanel settings={settings} onChange={persist} />
            ) : section === 'redaction' ? (
              <RedactionPanel settings={settings} onChange={persist} />
            ) : section === 'capture' ? (
              <CapturePanel settings={settings} onChange={persist} />
            ) : (
              <PinnedPanel settings={settings} />
            )
          }
        />
      ) : null}
    </Modal>
  );
}

interface PanelProps {
  settings: Settings;
  onChange: (partial: Partial<Settings>) => void;
}

function GeneralPanel({ settings, onChange }: PanelProps) {
  return (
    <div className="m6__panel">
      <fieldset className="m6__field">
        <legend className="type-ui">Theme</legend>
        {(['system', 'dark', 'light'] as const).map((t) => (
          <label key={t} className="m6__radio">
            <input
              type="radio"
              name="theme"
              value={t}
              checked={settings.theme === t}
              onChange={() => onChange({ theme: t })}
            />
            <span>{t}</span>
          </label>
        ))}
      </fieldset>
      <fieldset className="m6__field">
        <legend className="type-ui">Density</legend>
        {(['comfortable', 'compact'] as const).map((d) => (
          <label key={d} className="m6__radio">
            <input
              type="radio"
              name="density"
              value={d}
              checked={settings.density === d}
              onChange={() => onChange({ density: d })}
            />
            <span>{d}</span>
          </label>
        ))}
      </fieldset>
    </div>
  );
}

function RedactionPanel({ settings, onChange }: PanelProps) {
  return (
    <div className="m6__panel">
      <label className="m6__field">
        <span className="type-ui">Heavy-redaction threshold</span>
        <input
          type="number"
          min={1}
          max={500}
          value={settings.heavy_redaction_threshold}
          onChange={(e) => {
            const n = Number.parseInt(e.target.value, 10);
            if (Number.isFinite(n) && n >= 1 && n <= 500) {
              onChange({ heavy_redaction_threshold: n });
            }
          }}
        />
        <span className="type-body-sm m6__hint">
          Packets with more than this many redactions show a warning banner.
        </span>
      </label>
      <label className="m6__field m6__field--checkbox">
        <input
          type="checkbox"
          checked={settings.disable_tamper_warnings}
          onChange={(e) => onChange({ disable_tamper_warnings: e.target.checked })}
        />
        <span className="type-ui">Disable tamper warnings (J12)</span>
        <span className="type-body-sm m6__hint">
          Suppress the J12 tamper banner. NOT recommended; logs a notice.
        </span>
      </label>
    </div>
  );
}

/**
 * <CapturePanel> — Sprint 4 cycle-1.5 F3 fix.
 *
 * Replaces the cycle-1 implementation that persisted the capture CLI
 * path string directly with no validation. The panel now:
 *   - Holds the path in a draft input separate from `settings`.
 *   - Provides a "Verify" button that calls `validateCaptureCliPath`
 *     IPC → cli_bridge::validate_capture_cli_path → real subprocess
 *     `--version` probe (B5 §6.6 + gh#11 criterion 11).
 *   - Shows a verified-with-version indicator on success, or a stable
 *     kebab-case error kind on failure.
 *   - "Save" persists the path AFTER successful verification, gating
 *     the round-trip per the founder brief: "no validation, no
 *     persistence". Unverified saves remain possible via "Save as-is"
 *     so the user can deliberately set a path that will only resolve
 *     on a different machine (e.g., a build pipeline path that doesn't
 *     exist on the dev box).
 *
 * The N15 anti-pattern this closes: the cli_bridge module had 5 cargo
 * unit tests but was never registered as a Tauri command, so the UI
 * couldn't reach it. The integration test in
 * tests/unit/M6SettingsModal-cli-bridge.test.tsx exercises the full
 * pathway and FAILS if the IPC handler is unwired.
 */
type DetectOutcome =
  | { state: 'idle' }
  | { state: 'detecting' }
  | { state: 'failed'; failure_kind: string; message: string; suggested_fix: string }
  | { state: 'system-error'; message: string };

function CapturePanel({ settings, onChange }: PanelProps) {
  const [draftPath, setDraftPath] = useState<string>(settings.capture_cli_path);
  const [probe, setProbe] = useState<
    | { state: 'idle' }
    | { state: 'probing' }
    | { state: 'verified'; version: string; verifiedPath: string; source?: string }
    | { state: 'rejected'; kind: string; message: string; rejectedPath: string }
    | { state: 'system-error'; message: string }
  >({ state: 'idle' });
  const [detect, setDetect] = useState<DetectOutcome>({ state: 'idle' });
  const [fixCopied, setFixCopied] = useState<boolean>(false);

  // gh#17 cycle-2 F1: monotonic counter to cancel stale in-flight Detect
  // promises. Every action that should INVALIDATE a pending detect (a new
  // Detect click, starting a Verify, editing the path, the modal re-syncing
  // from settings) increments this counter; when the IPC promise resolves
  // we compare against the snapshot taken at start and bail if the counter
  // advanced — preventing the late-resolve from overwriting `draftPath`
  // (e.g., user typed a different path after clicking Detect) or stomping
  // an in-flight `probe` state.
  const detectGenRef = useRef<number>(0);

  // Keep the draft synced when the modal reopens with a different settings value.
  useEffect(() => {
    detectGenRef.current++;
    setDraftPath(settings.capture_cli_path);
    setProbe({ state: 'idle' });
    setDetect({ state: 'idle' });
    setFixCopied(false);
  }, [settings.capture_cli_path]);

  const onProbe = useCallback(async () => {
    const candidate = draftPath.trim();
    if (candidate === '') {
      setProbe({
        state: 'rejected',
        kind: 'spawn',
        message: 'Path must be non-empty',
        rejectedPath: candidate,
      });
      return;
    }
    // F1: clear any stale Detect failure card before starting Verify so
    // the two state machines don't overlap visually. Bump the detect
    // generation so any in-flight Detect promise that resolves later
    // does not overwrite the verify result or the user's typed path
    // (gh#17 cycle-2 race fix).
    detectGenRef.current++;
    setDetect({ state: 'idle' });
    setProbe({ state: 'probing' });
    try {
      const result: ValidateCaptureCliPathResponse = await validateCaptureCliPath(candidate);
      if (result.ok === 'true') {
        setProbe({
          state: 'verified',
          version: result.version,
          verifiedPath: candidate,
        });
      } else {
        setProbe({
          state: 'rejected',
          kind: result.kind,
          message: result.message,
          rejectedPath: candidate,
        });
      }
    } catch (err) {
      // IPC-layer failure (handler unregistered, schema mismatch, etc.).
      // Surface explicitly so the user knows verification did NOT run.
      setProbe({
        state: 'system-error',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }, [draftPath]);

  // gh#17 AC#1 + AC#4 + AC#5: Detect button. On success, auto-fill the
  // path field and mark verified (the detect probe already ran --version
  // through the augmented spawn). On failure, render the failure card
  // with message + suggested_fix.
  const onDetect = useCallback(async () => {
    const gen = ++detectGenRef.current;
    setDetect({ state: 'detecting' });
    setFixCopied(false);
    try {
      const result: DetectCaptureCliResponse = await detectCaptureCli();
      // F1 race guard: bail if a newer Detect / Verify / edit invalidated
      // this promise. Without this, a slow IPC could overwrite a path the
      // user typed after clicking Detect, or stomp an in-flight Verify.
      if (gen !== detectGenRef.current) return;
      if (result.kind === 'detected') {
        setDraftPath(result.path);
        setProbe({
          state: 'verified',
          version: result.version,
          verifiedPath: result.path,
          source: result.source,
        });
        setDetect({ state: 'idle' });
      } else {
        setDetect({
          state: 'failed',
          failure_kind: result.failure_kind,
          message: result.message,
          suggested_fix: result.suggested_fix,
        });
      }
    } catch (err) {
      if (gen !== detectGenRef.current) return;
      setDetect({
        state: 'system-error',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }, []);

  const onCopyFix = useCallback(async () => {
    if (detect.state !== 'failed') return;
    if (typeof navigator !== 'undefined' && navigator.clipboard) {
      try {
        await navigator.clipboard.writeText(detect.suggested_fix);
        setFixCopied(true);
        window.setTimeout(() => setFixCopied(false), 2000);
      } catch (err) {
        // Clipboard permission denied or unsupported — leave the text
        // visible so the user can manually copy. Surface a console.warn
        // so the diagnostic exists when users report "I clicked Copy
        // and nothing happened" (gh#17 ERR-3).
        console.warn('[Trail] clipboard write failed:', err);
      }
    }
  }, [detect]);

  const onSaveVerified = useCallback(() => {
    if (probe.state !== 'verified') return;
    onChange({ capture_cli_path: probe.verifiedPath });
  }, [onChange, probe]);

  const onSaveAsIs = useCallback(() => {
    onChange({ capture_cli_path: draftPath.trim() });
  }, [onChange, draftPath]);

  const draftDiffersFromSettings = draftPath.trim() !== settings.capture_cli_path;
  const verifiedMatchesDraft =
    probe.state === 'verified' && probe.verifiedPath === draftPath.trim();
  const rejectedMatchesDraft =
    probe.state === 'rejected' && probe.rejectedPath === draftPath.trim();

  return (
    <div className="m6__panel">
      <label className="m6__field">
        <span className="type-ui">Capture CLI path</span>
        <input
          type="text"
          value={draftPath}
          onChange={(e) => {
            setDraftPath(e.target.value);
            // Editing invalidates any prior probe outcome — clear both
            // the verify-side probe state AND the detect-side failure
            // card so the user isn't looking at stale red text against
            // a path they just typed (gh#17 F1). Bump detectGen so an
            // in-flight Detect cannot overwrite the typed value when it
            // resolves (gh#17 cycle-2 race fix).
            detectGenRef.current++;
            if (probe.state !== 'idle') setProbe({ state: 'idle' });
            if (detect.state !== 'idle') setDetect({ state: 'idle' });
          }}
          placeholder="trail"
          aria-describedby="m6-capture-status"
        />
        <span className="type-body-sm m6__hint">
          Default: <code>trail</code> (installed by{' '}
          <code>npm install -g @synapti/trail-capture</code>). Verify probes the
          binary via <code>--version</code> before saving.
        </span>
      </label>
      <div className="m6__capture-actions">
        <Button
          variant="ghost"
          size="md"
          onClick={onDetect}
          disabled={detect.state === 'detecting'}
          data-testid="m6-capture-detect"
        >
          {detect.state === 'detecting' ? 'Detecting…' : 'Detect'}
        </Button>
        <Button
          variant="ghost"
          size="md"
          onClick={onProbe}
          disabled={probe.state === 'probing' || draftPath.trim() === ''}
        >
          {probe.state === 'probing' ? 'Verifying…' : 'Verify'}
        </Button>
        <Button
          variant="primary"
          size="md"
          onClick={onSaveVerified}
          disabled={!verifiedMatchesDraft || !draftDiffersFromSettings}
        >
          Save (verified)
        </Button>
        <Button
          variant="ghost"
          size="md"
          onClick={onSaveAsIs}
          disabled={!draftDiffersFromSettings}
        >
          Save as-is
        </Button>
      </div>
      <div
        id="m6-capture-status"
        className="m6__capture-status type-body-sm"
        role={
          probe.state === 'rejected' ||
          probe.state === 'system-error' ||
          detect.state === 'failed' ||
          detect.state === 'system-error'
            ? 'alert'
            : undefined
        }
        aria-live="polite"
      >
        {detect.state === 'detecting' ? (
          <span className="m6__hint">Detecting trail CLI…</span>
        ) : probe.state === 'idle' && detect.state === 'idle' ? (
          <span className="m6__hint">Not yet verified.</span>
        ) : probe.state === 'probing' ? (
          <span className="m6__hint">Probing capture CLI…</span>
        ) : probe.state === 'verified' && verifiedMatchesDraft ? (
          <span className="m6__capture-status--ok" data-testid="m6-capture-verified">
            ✓ verified — version {probe.version}
            {probe.source ? (
              <span className="m6__hint"> (detected via {probe.source.replace(/-/g, ' ')})</span>
            ) : null}
          </span>
        ) : probe.state === 'rejected' && rejectedMatchesDraft ? (
          <span className="m6__capture-status--err" data-testid="m6-capture-rejected">
            ✗ probe failed ({probe.kind}): {probe.message}
          </span>
        ) : probe.state === 'system-error' ? (
          <span
            className="m6__capture-status--err"
            data-testid="m6-capture-system-error"
          >
            ✗ verification could not run: {probe.message}
          </span>
        ) : (
          <span className="m6__hint">Path edited; verify before saving.</span>
        )}
      </div>
      {detect.state === 'failed' ? (
        <div
          className="m6__capture-detect-failure"
          data-testid="m6-capture-detect-failure"
          data-failure-kind={detect.failure_kind}
          role="alert"
        >
          <p className="m6__capture-detect-failure__title type-ui">
            ✗ Detect failed ({detect.failure_kind.replace(/-/g, ' ')})
          </p>
          <p className="m6__capture-detect-failure__message type-body-sm">
            {detect.message}
          </p>
          <div className="m6__capture-detect-failure__fix">
            <p className="type-ui">Suggested fix</p>
            <pre className="m6__capture-detect-failure__fix-text type-mono-sm">
              {detect.suggested_fix}
            </pre>
            <Button
              variant="ghost"
              size="sm"
              onClick={onCopyFix}
              data-testid="m6-capture-detect-failure-copy"
            >
              {fixCopied ? 'Copied' : 'Copy fix'}
            </Button>
          </div>
        </div>
      ) : detect.state === 'system-error' ? (
        <div
          className="m6__capture-detect-failure"
          data-testid="m6-capture-detect-system-error"
          role="alert"
        >
          <p className="m6__capture-detect-failure__title type-ui">
            ✗ Detect could not run
          </p>
          <p className="m6__capture-detect-failure__message type-body-sm">
            {detect.message}
          </p>
        </div>
      ) : null}
    </div>
  );
}

function PinnedPanel({ settings }: { settings: Settings }) {
  if (settings.pinned_sessions.length === 0) {
    return <p className="m6__empty type-body-sm">No pinned sessions.</p>;
  }
  return (
    <ul className="m6__panel m6__pinned">
      {settings.pinned_sessions.map((p) => (
        <li key={p.session_id} className="m6__pinned-item">
          <code className="type-mono-sm">{p.session_id}</code>
          <span className="type-body-sm m6__hint">pinned at {p.pinned_at}</span>
        </li>
      ))}
    </ul>
  );
}
