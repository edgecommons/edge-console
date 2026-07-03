/**
 * The inline notification strip — the mockup's "heartbeat stale" / "bridge offline"
 * notes: OFFLINE components as error notifications, STALE components and UNREACHABLE
 * devices (one containment note per device, never per-component alarm spam) as
 * warnings. Capped, with a "+N more" line, so a bad day stays readable.
 */
import { InlineNotification } from "@carbon/react";
import type { FleetIssue } from "../fleet/selectors";

/** Max notifications shown before collapsing to "+N more". */
export const MAX_VISIBLE_ISSUES = 4;

export function IssueNotifications({ issues }: { issues: FleetIssue[] }): React.JSX.Element | null {
  if (issues.length === 0) return null;
  const visible = issues.slice(0, MAX_VISIBLE_ISSUES);
  const hidden = issues.length - visible.length;
  return (
    <div className="ec-issues" data-testid="issue-notifications">
      {visible.map((issue) => (
        <InlineNotification
          key={issue.id}
          kind={issue.severity === "critical" ? "error" : "warning"}
          lowContrast
          hideCloseButton
          title={issue.title}
          subtitle={issue.subtitle}
        />
      ))}
      {hidden > 0 && (
        <p className="ec-dim ec-issues__more">
          +{hidden} more issue{hidden === 1 ? "" : "s"} — see the fleet table below.
        </p>
      )}
    </div>
  );
}
