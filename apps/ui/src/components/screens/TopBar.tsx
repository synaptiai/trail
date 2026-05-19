import { Button, Chip, KeyboardKey } from '@/components/primitives';
import type { Persona } from '@/ipc/contract';
import './TopBar.css';

/**
 * <TopBar> (B4 screen-level component).
 *
 * Renders the brand mark, the active persona chip, the global keyboard hint
 * (`?`), and the settings cog button per B4 §6.7. The horizon line that
 * anchors the top of the window is rendered separately by <App> via
 * <HorizonLine variant="app-chrome">.
 *
 * Sprint 4 (gh#11): the `?` shortcut now opens the KeyboardOverlay shell,
 * dispatched by the App via the decision-shortcuts service (no per-component
 * keydown listener). The settings cog opens M6.
 */

export interface TopBarProps {
  persona: Persona;
  onOpenSettings?: () => void;
  /** gh#18 C2 — current location for breadcrumb rendering. */
  location?: 'trail' | 'sessions' | 'packet';
  /** gh#18 C2 — clicked breadcrumb item navigates to sessions. */
  onOpenSessions?: () => void;
}

const PERSONA_LABEL: Record<Persona, string> = {
  creator: 'Creator',
  reviewer: 'Reviewer',
  auditor: 'Auditor',
};

export function TopBar({
  persona,
  onOpenSettings,
  location,
  onOpenSessions,
}: TopBarProps) {
  // Cycle-3 C8 (PR #21): the settings cog is gated by persona INSIDE
  // TopBar, not by the caller passing/omitting onOpenSettings. Auditor
  // mode is read-only per B5 §6.5; surfacing the cog at the
  // chrome layer would invite an auditor to attempt settings mutations
  // (the M6 modal itself enforces read-only on writeable fields, but
  // hiding the surface is the cleaner discipline). Creator + reviewer
  // see the cog when onOpenSettings is supplied; auditor never does,
  // even if a caller passes the prop. The previous test file rendered
  // both branches by toggling the prop; the persona-honest version
  // tests the persona axis directly so a regression that flipped the
  // gate from prop-based to persona-based (or vice versa) would surface.
  const showSettingsCog = persona !== 'auditor' && onOpenSettings !== undefined;
  return (
    <header className="topbar" role="banner">
      <div className="topbar__brand">
        <span className="topbar__mark type-h1" aria-hidden="true">
          Trail
        </span>
        <span className="sr-only">Trail — AI-native change-control</span>
        {location === 'sessions' && (
          <span className="topbar__breadcrumb" aria-current="page">
            <span className="topbar__breadcrumb-sep" aria-hidden> · </span>
            sessions
          </span>
        )}
        {location === 'packet' && onOpenSessions && (
          <span className="topbar__breadcrumb">
            <span className="topbar__breadcrumb-sep" aria-hidden> · </span>
            <button
              type="button"
              className="topbar__breadcrumb-link"
              onClick={onOpenSessions}
            >
              sessions
            </button>
            <span className="topbar__breadcrumb-sep" aria-hidden> · </span>
            <span aria-current="page">packet</span>
          </span>
        )}
      </div>
      <div className="topbar__meta">
        <Chip tone="accent">{PERSONA_LABEL[persona]}</Chip>
        <span className="topbar__hint type-body-sm">
          Press <KeyboardKey>?</KeyboardKey> for shortcuts
        </span>
        {showSettingsCog ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={onOpenSettings}
            aria-label="Open settings"
          >
            ⚙
          </Button>
        ) : null}
      </div>
    </header>
  );
}
