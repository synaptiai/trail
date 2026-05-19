/**
 * Location routing — gh#18 C1.
 *
 * Trail's React shell now has three locations:
 *   - `trail`    — the existing TrailSidebar + PacketView surface
 *   - `sessions` — the new <CaptureSurface> for gh#18
 *   - `packet`   — a specific packet open in PacketView
 *
 * Location is parsed from URL params + localStorage on mount; updates
 * write both. `?view=sessions` deep-links to the Capture surface;
 * `?packet=<id>` opens a specific packet. `trail_last_location` is the
 * localStorage key that persists the last location across launches.
 */

const STORAGE_KEY = 'trail_last_location';

export type Location =
  | { kind: 'trail' }
  | { kind: 'sessions' }
  | { kind: 'packet'; packet_id: string };

function readUrlParams(): URLSearchParams | null {
  if (typeof window === 'undefined') return null;
  return new URLSearchParams(window.location.search);
}

export function readLocationFromUrl(): Location | null {
  const params = readUrlParams();
  if (!params) return null;
  const view = params.get('view');
  if (view === 'sessions') return { kind: 'sessions' };
  const packet = params.get('packet');
  if (packet) return { kind: 'packet', packet_id: packet };
  if (view === 'trail') return { kind: 'trail' };
  return null;
}

export function readLocationFromStorage(): Location | null {
  if (typeof window === 'undefined' || !window.localStorage) return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'kind' in parsed
    ) {
      const kind = (parsed as { kind: unknown }).kind;
      if (kind === 'sessions' || kind === 'trail') {
        return { kind };
      }
      if (
        kind === 'packet' &&
        'packet_id' in parsed &&
        typeof (parsed as { packet_id: unknown }).packet_id === 'string'
      ) {
        return {
          kind: 'packet',
          packet_id: (parsed as { packet_id: string }).packet_id,
        };
      }
    }
  } catch {
    // ignore — malformed JSON in storage shouldn't crash the app
  }
  return null;
}

export function persistLocation(loc: Location): void {
  if (typeof window === 'undefined' || !window.localStorage) return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(loc));
  } catch {
    // localStorage may be disabled (private mode); ignore
  }
}

/**
 * First-launch default: `sessions` when no settings.json yet exists,
 * otherwise `trail`. Settings probe is async so we accept a hint and
 * the caller decides; this helper just expresses the contract.
 */
export function defaultLocationForFirstLaunch(hasSettings: boolean): Location {
  return hasSettings ? { kind: 'trail' } : { kind: 'sessions' };
}

/**
 * Resolve the initial location: URL param wins; then localStorage;
 * then the first-launch default.
 */
export function resolveInitialLocation(hasSettings: boolean): Location {
  return (
    readLocationFromUrl() ??
    readLocationFromStorage() ??
    defaultLocationForFirstLaunch(hasSettings)
  );
}
