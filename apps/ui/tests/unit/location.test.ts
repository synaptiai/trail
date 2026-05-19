/**
 * services/location.ts — gh#18 AC#7.
 *
 * "Tab persists across launches; not modal. Available from main nav, not
 * nested in Settings."
 *
 * Tests cover the three resolution sources (URL > localStorage > default)
 * and the round-trip through persistLocation + readLocationFromStorage.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  defaultLocationForFirstLaunch,
  persistLocation,
  readLocationFromStorage,
  resolveInitialLocation,
} from '@/services/location';

// happy-dom doesn't always expose localStorage in test env; mirror the
// polyfill pattern from FirstRun-autodetect.test.tsx so reads + writes
// round-trip deterministically.
function ensureLocalStorage(): Storage {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const w = (globalThis as any).window ?? (globalThis as any);
  if (!w.localStorage) {
    const store = new Map<string, string>();
    const ls: Storage = {
      getItem: (k) => store.get(k) ?? null,
      setItem: (k, v) => {
        store.set(k, String(v));
      },
      removeItem: (k) => {
        store.delete(k);
      },
      clear: () => {
        store.clear();
      },
      key: (i) => Array.from(store.keys())[i] ?? null,
      get length() {
        return store.size;
      },
    };
    w.localStorage = ls;
  }
  return w.localStorage;
}

function setUrl(query: string) {
  window.history.replaceState({}, '', `/${query ? `?${query}` : ''}`);
}

beforeAll(() => {
  ensureLocalStorage();
});

beforeEach(() => {
  ensureLocalStorage().clear();
  setUrl('');
});

afterEach(() => {
  ensureLocalStorage().clear();
  setUrl('');
});

describe('services/location', () => {
  it('defaultLocationForFirstLaunch returns sessions when no settings', () => {
    expect(defaultLocationForFirstLaunch(false)).toEqual({ kind: 'sessions' });
  });
  it('defaultLocationForFirstLaunch returns trail when settings present', () => {
    expect(defaultLocationForFirstLaunch(true)).toEqual({ kind: 'trail' });
  });

  it('resolveInitialLocation honours ?view=sessions', () => {
    setUrl('view=sessions');
    expect(resolveInitialLocation(true)).toEqual({ kind: 'sessions' });
  });

  it('resolveInitialLocation honours ?packet=<id>', () => {
    setUrl('packet=01HZX-PACKET-FOO');
    expect(resolveInitialLocation(true)).toEqual({
      kind: 'packet',
      packet_id: '01HZX-PACKET-FOO',
    });
  });

  it('falls back to localStorage when no URL params', () => {
    persistLocation({ kind: 'sessions' });
    setUrl('');
    expect(resolveInitialLocation(true)).toEqual({ kind: 'sessions' });
  });

  it('persistLocation + readLocationFromStorage round-trips', () => {
    persistLocation({ kind: 'packet', packet_id: 'p-1' });
    expect(readLocationFromStorage()).toEqual({
      kind: 'packet',
      packet_id: 'p-1',
    });
  });

  it('falls back to first-launch default when neither URL nor storage', () => {
    expect(resolveInitialLocation(false)).toEqual({ kind: 'sessions' });
    expect(resolveInitialLocation(true)).toEqual({ kind: 'trail' });
  });

  it('readLocationFromStorage tolerates malformed JSON', () => {
    if (window.localStorage) {
      window.localStorage.setItem('trail_last_location', '{not-json');
    }
    expect(readLocationFromStorage()).toBeNull();
  });
});
