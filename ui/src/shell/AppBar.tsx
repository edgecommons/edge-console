/**
 * AppBar — the application-shell header (R0), realigned to the signed-off hi-fi mockup
 * (`docs/mockups-hifi.html` lines 251-259): burger · `EdgeCommons / Edge Console` name ·
 * global search · theme toggle · notifications (alarm-count badge) · account (RBAC role).
 *
 * The console previously shipped only `<Header><HeaderName>` — no search, no theme switch
 * (hard-pinned dark), no alert count, no identity. This restores the four app-bar
 * affordances, all over data the R0 foundation now carries: the notifications badge is the
 * live active-alarm count (AlarmTracker → `alarms` frame), the account indicator is the
 * connection's resolved RBAC role (the `welcome` frame). Purely presentational — state in,
 * DOM out — so it is component-testable without a socket.
 */
import {
  Header,
  HeaderGlobalAction,
  HeaderGlobalBar,
  HeaderMenuButton,
  HeaderName,
  SkipToContent,
} from "@carbon/react";
import { Asleep, Light, Notification, Search as SearchIcon, UserAvatar } from "@carbon/react/icons";
import type { EcTheme } from "./theme";

export interface AppBarProps {
  theme: EcTheme;
  onToggleTheme: () => void;
  /** Active (non-contained) alarm count — the notifications badge. */
  alarmCount: number;
  /** The connection's resolved RBAC role (from `welcome`); undefined until it arrives. */
  role?: string;
  /** Whether the gateway connection is live (dims the account glyph when not). */
  connected: boolean;
  /** The shared global-search query (controlled input). */
  search: string;
  onSearchChange: (query: string) => void;
  /** Side-rail collapse toggle (the burger). */
  navExpanded: boolean;
  onToggleNav: () => void;
}

export function AppBar({
  theme,
  onToggleTheme,
  alarmCount,
  role,
  connected,
  search,
  onSearchChange,
  navExpanded,
  onToggleNav,
}: AppBarProps): React.JSX.Element {
  const roleLabel = role ?? (connected ? "unknown" : "offline");
  return (
    <Header aria-label="EdgeCommons Edge Console" className="ec-appbar">
      <SkipToContent />
      <HeaderMenuButton
        aria-label={navExpanded ? "Close navigation" : "Open navigation"}
        onClick={onToggleNav}
        isActive={navExpanded}
        isCollapsible
      />
      <HeaderName href="#" prefix="EdgeCommons">
        Edge Console
      </HeaderName>

      <div className="ec-appbar__search" role="search">
        <SearchIcon size={16} className="ec-appbar__search-icon" aria-hidden="true" />
        <input
          className="ec-appbar__search-input"
          type="text"
          placeholder="Search components, things, signals…"
          aria-label="Search components, things, signals"
          value={search}
          onChange={(e) => onSearchChange(e.target.value)}
          data-testid="appbar-search"
        />
      </div>

      <HeaderGlobalBar>
        <HeaderGlobalAction
          aria-label={theme === "g100" ? "Switch to light theme" : "Switch to dark theme"}
          onClick={onToggleTheme}
          tooltipAlignment="center"
          data-testid="appbar-theme"
        >
          {theme === "g100" ? <Light size={20} /> : <Asleep size={20} />}
        </HeaderGlobalAction>

        <HeaderGlobalAction
          aria-label={`Notifications: ${alarmCount} active alarm${alarmCount === 1 ? "" : "s"}`}
          onClick={() => undefined}
          tooltipAlignment="center"
          className="ec-appbar__notif"
          data-testid="appbar-notifications"
        >
          <>
            <Notification size={20} />
            {alarmCount > 0 && (
              <span className="ec-appbar__badge" data-testid="appbar-alarm-count">
                {alarmCount > 99 ? "99+" : alarmCount}
              </span>
            )}
          </>
        </HeaderGlobalAction>

        <HeaderGlobalAction
          aria-label={`Account · role: ${roleLabel}`}
          onClick={() => undefined}
          tooltipAlignment="end"
          data-testid="appbar-account"
        >
          <UserAvatar size={20} />
        </HeaderGlobalAction>
        <span className="ec-appbar__role" data-testid="appbar-role">
          {roleLabel}
        </span>
      </HeaderGlobalBar>
    </Header>
  );
}
