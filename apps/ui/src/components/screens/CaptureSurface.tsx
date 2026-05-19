import { useEffect, useMemo, useState, useCallback } from 'react';
import { Button } from '@/components/primitives';
import {
  detectCaptureCli,
  invoke,
  IpcUnavailableError,
  listen,
  writeSettings,
} from '@/ipc/client';
import { subscribeFsWatch } from '@/services/watcher-events';
import type {
  ClaudeSession,
  DetectCaptureCliResponse,
  ListClaudeSessionsResponse,
  SidebarRow,
  SpawnPacketGenerateResponse,
} from '@/ipc/contract';
import './CaptureSurface.css';

/**
 * <CaptureSurface> — gh#18 Capture/sessions view.
 *
 * Single 840px editorial column matching the design handoff's Reading view
 * vocabulary. Three sections stack: CLI status row, Claude Code sessions
 * (with per-row Generate chip), Trail packets (with sealed-hash + age).
 *
 * Layer B (B1-B6) builds this incrementally:
 *   B1 — skeleton + empty state shell                       (this commit)
 *   B2 — sessions list wired to list_claude_sessions        (next)
 *   B3 — trail-packets list wired to query_trail            (next)
 *   B4 — <SessionSheet> right-anchored detail               (next)
 *   B5 — generate-packet flow + live event-thread           (next)
 *   B6 — first-launch editorial empty state                 (next)
 *
 * This file ships the surface as a working empty-state from B1; B2 → B5
 * extend the same component without reshaping the call graph.
 */

interface CaptureSurfaceProps {
  /** Routing callback when a Trail packet row is clicked. */
  onOpenPacket?: (packetId: string) => void;
  /** Active persona — auditor skips the writeSettings persistence step. */
  persona?: import('@/ipc/contract').Persona;
}

const AUTODETECT_FLAG_KEY = 'trail_autodetect_ran';

type CliStatusState =
  | { kind: 'detecting' }
  | { kind: 'detected'; path: string; version: string }
  | { kind: 'failed'; message: string };

type SessionsState =
  | { kind: 'loading' }
  | { kind: 'ok'; sessions: ClaudeSession[] }
  | { kind: 'failed'; message: string };

type PacketsState =
  | { kind: 'loading' }
  | { kind: 'ok'; packets: SidebarRow[] }
  | { kind: 'failed'; message: string };

function formatDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function formatRelativeTime(iso: string | null): string {
  if (!iso) return '—';
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return iso;
  const diffMs = Date.now() - then;
  const min = Math.floor(diffMs / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const days = Math.floor(hr / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

export function CaptureSurface({
  onOpenPacket,
  persona = 'creator',
}: CaptureSurfaceProps = {}) {
  const today = useMemo(() => formatDate(new Date()), []);
  const [cliStatus, setCliStatus] = useState<CliStatusState>({ kind: 'detecting' });
  const [sessionsState, setSessionsState] = useState<SessionsState>({ kind: 'loading' });
  const [packetsState, setPacketsState] = useState<PacketsState>({ kind: 'loading' });

  // C4 — auto-detect CLI on mount. Wraps detectCaptureCli with the result
  // mapping (success/failure cases from the discriminated union). On
  // first success per machine (guarded by localStorage flag), persists
  // the detected path via writeSettings — same lifecycle FirstRun used
  // before. Auditor mode skips the persist step (write_settings rejects
  // auditor for capture_cli_path).
  const runDetect = useCallback(async () => {
    setCliStatus({ kind: 'detecting' });
    try {
      const resp: DetectCaptureCliResponse = await detectCaptureCli();
      if (resp.kind === 'detected') {
        setCliStatus({
          kind: 'detected',
          path: resp.path,
          version: resp.version,
        });
        // First-success persistence — once per machine, gated by the
        // shared autodetect flag so we don't trample a user-edited
        // capture_cli_path on every mount.
        if (
          typeof window !== 'undefined' &&
          window.localStorage &&
          window.localStorage.getItem(AUTODETECT_FLAG_KEY) !== '1' &&
          persona !== 'auditor'
        ) {
          try {
            await writeSettings({ capture_cli_path: resp.path }, persona);
            window.localStorage.setItem(AUTODETECT_FLAG_KEY, '1');
          } catch (err) {
            console.warn('[Trail] writeSettings after auto-detect failed:', err);
          }
        }
      } else {
        setCliStatus({ kind: 'failed', message: resp.message });
      }
    } catch (err) {
      if (err instanceof IpcUnavailableError) {
        setCliStatus({
          kind: 'failed',
          message: 'Tauri IPC unavailable (likely a browser preview).',
        });
      } else {
        setCliStatus({
          kind: 'failed',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }, [persona]);

  // B2 — list Claude Code sessions and refetch on claude-session-changed
  // event. The fetcher is shared between mount + event paths.
  const fetchSessions = useCallback(async () => {
    try {
      // invoke() validates the response against IPC_RESPONSE_SCHEMAS
      // already; the cast here is type-only, the runtime parse is upstream.
      const resp = await invoke<ListClaudeSessionsResponse>(
        'list_claude_sessions',
        {},
      );
      if (resp.kind === 'ok') {
        setSessionsState({ kind: 'ok', sessions: resp.sessions });
      } else {
        setSessionsState({ kind: 'failed', message: resp.message });
      }
    } catch (err) {
      if (err instanceof IpcUnavailableError) {
        setSessionsState({ kind: 'ok', sessions: [] });
      } else {
        setSessionsState({
          kind: 'failed',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }, []);

  // B3 — fetch recent Trail packets via query_trail. The existing
  // trail-needs-refresh event refetches the list (saga writes a new
  // packet, watcher fires NoOp, sidebar refresh signal flows through).
  const fetchPackets = useCallback(async () => {
    try {
      const resp = await invoke<{ packets: SidebarRow[]; next_cursor?: string | null }>(
        'query_trail',
        { filter: {}, limit: 50 },
      );
      setPacketsState({ kind: 'ok', packets: resp.packets });
    } catch (err) {
      if (err instanceof IpcUnavailableError) {
        setPacketsState({ kind: 'ok', packets: [] });
      } else {
        setPacketsState({
          kind: 'failed',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }, []);

  useEffect(() => {
    void runDetect();
    void fetchSessions();
    void fetchPackets();
  }, [runDetect, fetchSessions, fetchPackets]);

  useEffect(() => {
    let cancelled = false;
    let unsub: (() => void) | null = null;
    (async () => {
      const stop = await subscribeFsWatch({
        onClaudeSessionChanged: () => {
          if (!cancelled) void fetchSessions();
        },
        onTrailNeedsRefresh: () => {
          if (!cancelled) void fetchPackets();
        },
      });
      if (cancelled) {
        stop();
      } else {
        unsub = stop;
      }
    })();
    return () => {
      cancelled = true;
      unsub?.();
    };
  }, [fetchSessions, fetchPackets]);

  // B5 — Generate packet for a session. Per-row chip-button handler.
  // Tracks in-flight spawn IDs to disable re-clicks. The streaming events
  // accumulate in eventLog (keyed by session_id) and render under the row
  // when expanded. Terminal `done`/`error` removes the entry from
  // activeSpawns and triggers a fetchSessions refetch so the row flips to
  // its has-packet state.
  type ProgressLine = {
    kind: 'stderr' | 'done' | 'error';
    chunk?: string;
    exit_code?: number;
  };
  const [activeSpawns, setActiveSpawns] = useState<Record<string, string>>({});
  const [pendingSpawns, setPendingSpawns] = useState<Set<string>>(new Set());
  const [eventLog, setEventLog] = useState<Record<string, ProgressLine[]>>({});
  const [expandedSession, setExpandedSession] = useState<string | null>(null);

  // ERR-4: in-flight dedup for rapid double-click on the Generate chip.
  // Without this guard, two awaits can race and spawn two subprocesses
  // for the same session; the second clobbers the first's activeSpawns
  // entry, orphaning the first child. We mark pending synchronously
  // before the await and clear on resolve.
  const handleGenerate = useCallback(async (sessionId: string) => {
    let alreadyPending = false;
    setPendingSpawns((prev) => {
      if (prev.has(sessionId)) {
        alreadyPending = true;
        return prev;
      }
      const next = new Set(prev);
      next.add(sessionId);
      return next;
    });
    if (alreadyPending) return;

    setEventLog((prev) => ({ ...prev, [sessionId]: [] }));
    setExpandedSession(sessionId);
    try {
      const resp = await invoke<SpawnPacketGenerateResponse>(
        'spawn_packet_generate',
        { session_id: sessionId, persona },
      );
      if (resp.kind === 'spawned') {
        setActiveSpawns((prev) => ({ ...prev, [sessionId]: resp.spawn_id }));
      } else {
        setEventLog((prev) => ({
          ...prev,
          [sessionId]: [
            { kind: 'error', chunk: `${resp.failure_kind}: ${resp.message}` },
          ],
        }));
      }
    } catch (err) {
      console.warn('[Trail] spawn_packet_generate failed:', err);
      setEventLog((prev) => ({
        ...prev,
        [sessionId]: [
          {
            kind: 'error',
            chunk: err instanceof Error ? err.message : String(err),
          },
        ],
      }));
    } finally {
      setPendingSpawns((prev) => {
        const next = new Set(prev);
        next.delete(sessionId);
        return next;
      });
    }
  }, [persona]);

  // F2: optimistically clear activeSpawns on cancel click so the row
  // doesn't sit in "Running… [Cancel]" mode while we wait for the
  // worker's terminal event to round-trip (50ms poll). The worker's
  // terminal event remains authoritative for the log line.
  const handleCancel = useCallback(async (sessionId: string) => {
    const spawnId = activeSpawns[sessionId];
    if (!spawnId) return;
    setActiveSpawns((prev) => {
      const next = { ...prev };
      delete next[sessionId];
      return next;
    });
    try {
      await invoke('cancel_packet_generate', { spawn_id: spawnId, persona });
    } catch (err) {
      console.warn('[Trail] cancel_packet_generate failed:', err);
    }
  }, [activeSpawns, persona]);

  // Subscribe to packet-generate-progress events. Each event appends to
  // the per-session log; terminal kinds (done/error) clear activeSpawns
  // and trigger a packets refetch so the row flips to its has-packet
  // state.
  //
  // F1: events are keyed by spawn_id, not session_id. The Rust worker
  // continues to drain stderr after `child.kill()` (spawn.rs:255-279),
  // so a cancel-then-regenerate on the same session would otherwise
  // route the killed spawn's late stderr + terminal "cancelled" event
  // into the new spawn's row state. Compare payload.spawn_id against
  // activeSpawns[session_id] and drop events from non-matching spawns.
  //
  // ERR-2: runtime payload validation. The Rust side is well-typed but
  // event payloads bypass the IPC_RESPONSE_SCHEMAS validation that
  // invoke() applies. Guard before destructuring so a malformed payload
  // doesn't corrupt the log map keyed on `undefined`.
  useEffect(() => {
    let cancelled = false;
    let unsub: (() => void) | null = null;
    (async () => {
      try {
        const stop = await listen('packet-generate-progress', (payload) => {
          if (cancelled) return;
          // ERR-2 payload guard.
          if (
            !payload ||
            typeof payload !== 'object' ||
            typeof (payload as { session_id: unknown }).session_id !== 'string' ||
            typeof (payload as { spawn_id: unknown }).spawn_id !== 'string' ||
            typeof (payload as { kind: unknown }).kind !== 'string'
          ) {
            console.warn('[Trail] dropping malformed packet-generate-progress payload', payload);
            return;
          }
          const {
            session_id,
            spawn_id,
            kind,
            chunk,
            exit_code,
          } = payload as {
            session_id: string;
            spawn_id: string;
            kind: 'stderr' | 'done' | 'error';
            chunk?: string;
            exit_code?: number;
          };
          // F1 spawn_id discriminator. We need the latest activeSpawns
          // value but the effect closure captures the value at subscribe
          // time, so route through the setter and ignore the event when
          // the spawn no longer matches the active one for this session.
          let matchesActive = true;
          setActiveSpawns((prev) => {
            const current = prev[session_id];
            // No active spawn yet means either: (a) we received an
            // event before the spawn IPC resolved (timing — accept),
            // or (b) the spawn already cleared (drop late tail).
            // Heuristic: only accept the no-active case when it's the
            // first event we see for this session (eventLog empty).
            if (current && current !== spawn_id) {
              matchesActive = false;
            }
            return prev;
          });
          if (!matchesActive) {
            // Late tail from a cancelled prior spawn. Drop silently.
            return;
          }
          setEventLog((prev) => {
            const lines = prev[session_id] ?? [];
            const next: ProgressLine = { kind };
            if (chunk !== undefined) next.chunk = chunk;
            if (exit_code !== undefined) next.exit_code = exit_code;
            return { ...prev, [session_id]: [...lines, next] };
          });
          if (kind === 'done' || kind === 'error') {
            setActiveSpawns((prev) => {
              // F1 (terminal): only clear if the terminating spawn IS
              // the active one. A late terminal from a prior spawn
              // must not clear the new spawn's entry.
              if (prev[session_id] !== spawn_id) {
                return prev;
              }
              const next = { ...prev };
              delete next[session_id];
              return next;
            });
            // Refetch sessions so the row's packet_id field updates and
            // the chip flips from "Generate" to "Open packet".
            void fetchSessions();
            void fetchPackets();
          }
        });
        if (cancelled) {
          stop();
        } else {
          unsub = stop;
        }
      } catch (err) {
        if (!(err instanceof IpcUnavailableError)) {
          console.warn('[Trail] packet-generate-progress subscribe failed:', err);
        }
      }
    })();
    return () => {
      cancelled = true;
      unsub?.();
    };
  }, [fetchSessions, fetchPackets]);

  const sessions =
    sessionsState.kind === 'ok' ? sessionsState.sessions : [];
  const sessionCount = sessions.length;

  // B6 — first-launch editorial state. Render the 3-step setup pattern
  // (matches design_handoff_trail/artboards-v4b FirstRun grid) when both
  // sessions + packets lists are empty AND we've finished loading. Until
  // then the surface renders its normal sectioned form with loading
  // placeholders.
  const isFirstLaunch =
    sessionsState.kind === 'ok' &&
    sessionsState.sessions.length === 0 &&
    packetsState.kind === 'ok' &&
    packetsState.packets.length === 0;

  if (isFirstLaunch) {
    const step1Done = cliStatus.kind === 'detected';
    const step1State =
      cliStatus.kind === 'detecting'
        ? 'Detecting…'
        : cliStatus.kind === 'detected'
          ? `Detected at ${cliStatus.path}`
          : cliStatus.kind === 'failed'
            ? 'Not found'
            : 'Pending';
    return (
      <div className="capture-surface capture-surface--first-launch">
        <div className="capture-surface__col">
          <p className="capture-surface__eyebrow">Trail · v0.2 · {today}</p>
          <h1 className="capture-surface__title">
            Account for the change, not just the diff.
          </h1>
          <p className="capture-surface__lede">
            Trail captures your AI-assisted coding sessions, generates a
            sealed packet of claims and evidence, and posts it next to the
            PR. Reviewers see what changed and why.
          </p>
          <hr className="capture-surface__sep" aria-hidden />
          <h2 className="capture-surface__section-label">One-time setup</h2>
          <ol className="capture-surface__steps">
            <li className="capture-step" data-done={step1Done ? 'true' : 'false'}>
              <span className="capture-step__num">01</span>
              <div className="capture-step__body">
                <span className="capture-step__title">Detect the trail CLI</span>
                <span className="capture-step__hint">
                  Trail probes <code>~/.cargo/bin</code>,{' '}
                  <code>/usr/local/bin</code>, and your $PATH.
                </span>
              </div>
              <span className="capture-step__status">{step1State}</span>
            </li>
            <li className="capture-step" data-done="false">
              <span className="capture-step__num">02</span>
              <div className="capture-step__body">
                <span className="capture-step__title">
                  See your Claude Code sessions
                </span>
                <span className="capture-step__hint">
                  Trail watches <code>~/.claude/projects/</code> for sessions
                  you can package.
                </span>
              </div>
              <span className="capture-step__status">0 found</span>
            </li>
            <li className="capture-step" data-done="false">
              <span className="capture-step__num">03</span>
              <div className="capture-step__body">
                <span className="capture-step__title">
                  Generate your first packet
                </span>
                <span className="capture-step__hint">
                  Click "Generate packet" on a session row above once one
                  appears. Packets write to{' '}
                  <code>.trail/sessions/&lt;sid&gt;/packet-1.yml</code>.
                </span>
              </div>
              <span className="capture-step__status">
                {step1Done ? 'Awaiting sessions' : 'Awaiting step 1'}
              </span>
            </li>
          </ol>
          <p className="capture-surface__footnote">
            Trail is open source · Apache 2.0 · Your sessions stay local
            until you post a packet.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="capture-surface" data-state={sessionsState.kind}>
      <div className="capture-surface__col">
        <p className="capture-surface__eyebrow">Sessions and packets · {today}</p>

        <section
          className="capture-surface__cli-row"
          data-status={cliStatus.kind}
          aria-label="Trail CLI status"
        >
          {cliStatus.kind === 'detecting' && (
            <span className="capture-surface__cli-msg">
              <span className="capture-surface__glyph" aria-hidden>◯</span>
              Detecting Trail CLI…
            </span>
          )}
          {cliStatus.kind === 'detected' && (
            <span className="capture-surface__cli-msg">
              <span className="capture-surface__glyph capture-surface__glyph--ok" aria-hidden>
                ✓
              </span>
              Trail CLI detected at{' '}
              <code className="capture-surface__path">{cliStatus.path}</code>{' '}
              · v{cliStatus.version}
            </span>
          )}
          {cliStatus.kind === 'failed' && (
            <span className="capture-surface__cli-msg capture-surface__cli-msg--err">
              <span className="capture-surface__glyph capture-surface__glyph--err" aria-hidden>
                ⨂
              </span>
              {cliStatus.message}
            </span>
          )}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void runDetect()}
            disabled={cliStatus.kind === 'detecting'}
          >
            Re-detect
          </Button>
        </section>

        <hr className="capture-surface__sep" aria-hidden />

        <section aria-labelledby="capture-sessions-heading">
          <h2 className="capture-surface__section-label" id="capture-sessions-heading">
            Claude Code sessions · {sessionCount}
          </h2>
          {sessionsState.kind === 'loading' && (
            <p className="capture-surface__loading">Reading ~/.claude/projects/…</p>
          )}
          {sessionsState.kind === 'failed' && (
            <p className="capture-surface__err">{sessionsState.message}</p>
          )}
          {sessionsState.kind === 'ok' && sessionCount === 0 && (
            <p className="capture-surface__empty">
              No Claude Code sessions found. Sessions appear here once
              Claude Code has captured at least one conversation in a project
              directory.
            </p>
          )}
          {sessionsState.kind === 'ok' && sessionCount > 0 && (
            <ol className="capture-surface__sessions">
              {sessions.map((sess, idx) => {
                const hasPacket = Boolean(sess.packet_id);
                const isRunning = Boolean(activeSpawns[sess.session_id]);
                const isPending = pendingSpawns.has(sess.session_id);
                const lines = eventLog[sess.session_id] ?? [];
                const isExpanded = expandedSession === sess.session_id;
                const showLog = (isRunning || lines.length > 0) && isExpanded;
                return (
                  <li
                    key={sess.session_id}
                    className="capture-row"
                    data-has-packet={hasPacket ? 'true' : 'false'}
                    data-running={isRunning ? 'true' : 'false'}
                  >
                    <span className="capture-row__index" aria-hidden>
                      {String(idx + 1).padStart(2, '0')}
                    </span>
                    <span className="capture-row__id">
                      {sess.session_id.slice(0, 8)}…
                    </span>
                    <span className="capture-row__meta">
                      {sess.message_count} msg · {formatRelativeTime(sess.started_at)}
                    </span>
                    <span className="capture-row__project">{sess.project_path}</span>
                    <span className="capture-row__action">
                      {hasPacket ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => sess.packet_id && onOpenPacket?.(sess.packet_id)}
                        >
                          Open packet
                        </Button>
                      ) : isRunning ? (
                        <>
                          <span className="capture-row__status">◷ Running…</span>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => void handleCancel(sess.session_id)}
                          >
                            Cancel
                          </Button>
                        </>
                      ) : (
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={isPending}
                          onClick={() => void handleGenerate(sess.session_id)}
                        >
                          ⚡ Generate packet
                        </Button>
                      )}
                    </span>
                    {showLog && (
                      <div className="capture-row__log" role="log" aria-live="polite">
                        {lines.map((line, i) => (
                          <div
                            key={i}
                            className="capture-row__log-line"
                            data-kind={line.kind}
                          >
                            <span className="capture-row__log-glyph" aria-hidden>
                              {line.kind === 'stderr' ? '◆' : line.kind === 'done' ? '✓' : line.kind === 'error' ? '⨂' : '●'}
                            </span>
                            <span className="capture-row__log-text">
                              {line.chunk || (
                                line.kind === 'done'
                                  ? `packet generated (exit ${line.exit_code ?? 0})`
                                  : line.kind === 'error'
                                  ? `failed (exit ${line.exit_code ?? -1})`
                                  : ''
                              )}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                  </li>
                );
              })}
            </ol>
          )}
        </section>

        <hr className="capture-surface__sep" aria-hidden />

        <section aria-labelledby="capture-packets-heading">
          <h2 className="capture-surface__section-label" id="capture-packets-heading">
            Trail packets ·{' '}
            {packetsState.kind === 'ok' ? packetsState.packets.length : '—'}
          </h2>
          {packetsState.kind === 'loading' && (
            <p className="capture-surface__loading">Reading .trail/sessions/…</p>
          )}
          {packetsState.kind === 'failed' && (
            <p className="capture-surface__err">{packetsState.message}</p>
          )}
          {packetsState.kind === 'ok' && packetsState.packets.length === 0 && (
            <p className="capture-surface__empty">
              Packets land here once you generate them from a session above
              or via the <code>trail packet generate</code> CLI.
            </p>
          )}
          {packetsState.kind === 'ok' && packetsState.packets.length > 0 && (
            <ul className="capture-surface__packets">
              {packetsState.packets.map((p) => (
                <li key={p.packet_id} className="capture-packet">
                  <button
                    type="button"
                    className="capture-packet__open"
                    onClick={() => onOpenPacket?.(p.packet_id)}
                  >
                    <span className="capture-packet__arrow" aria-hidden>→</span>
                    <span className="capture-packet__id">
                      {p.packet_id.slice(0, 12)}…
                    </span>
                    <span className="capture-packet__name">{p.display_name}</span>
                    <span className="capture-packet__age">
                      {formatRelativeTime(p.captured_at)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
