import { useCallback, useEffect, useId, useState } from 'react';
import { Button, Modal, Tabs, type TabItem } from '@/components/primitives';
import { invoke, readSettings, validateCaptureCliPath, writeSettings } from '@/ipc/client';
import type { Persona, Settings, ValidateCaptureCliPathResponse } from '@/ipc/contract';
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
function CapturePanel({ settings, onChange }: PanelProps) {
  const [draftPath, setDraftPath] = useState<string>(settings.capture_cli_path);
  const [probe, setProbe] = useState<
    | { state: 'idle' }
    | { state: 'probing' }
    | { state: 'verified'; version: string; verifiedPath: string }
    | { state: 'rejected'; kind: string; message: string; rejectedPath: string }
    | { state: 'system-error'; message: string }
  >({ state: 'idle' });

  // Keep the draft synced when the modal reopens with a different settings value.
  useEffect(() => {
    setDraftPath(settings.capture_cli_path);
    setProbe({ state: 'idle' });
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
            // Editing invalidates any prior probe outcome.
            if (probe.state !== 'idle') setProbe({ state: 'idle' });
          }}
          placeholder="@synapti/trail-capture"
          aria-describedby="m6-capture-status"
        />
        <span className="type-body-sm m6__hint">
          Default: <code>@synapti/trail-capture</code> (Phase 1 binary). Verify probes
          the binary via <code>--version</code> before saving.
        </span>
      </label>
      <div className="m6__capture-actions">
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
        role={probe.state === 'rejected' || probe.state === 'system-error' ? 'alert' : undefined}
        aria-live="polite"
      >
        {probe.state === 'idle' ? (
          <span className="m6__hint">Not yet verified.</span>
        ) : probe.state === 'probing' ? (
          <span className="m6__hint">Probing capture CLI…</span>
        ) : probe.state === 'verified' && verifiedMatchesDraft ? (
          <span className="m6__capture-status--ok" data-testid="m6-capture-verified">
            ✓ verified — version {probe.version}
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
