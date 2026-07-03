/**
 * Status treatment — the single source of the liveness → Carbon mapping (semantic
 * status, not decoration): Carbon `Tag` + `@carbon/react/icons` glyphs, colored with
 * Carbon support tokens. Where a stock Tag type exists it is used (green/red/gray);
 * WARN/STALE have no stock Carbon tag color (Carbon ships no yellow tag), so the
 * signed-off hi-fi's warn/stale chips are reproduced with the `$support-warning`
 * token family via SCSS (`.ec-tag--warn` / `.ec-tag--stale` in index.scss), and
 * UNREACHABLE gets the mockup's dashed-outline gray ("the road, not the house").
 */
import { Tag } from "@carbon/react";
import {
  CheckmarkFilled,
  CloudOffline,
  ErrorFilled,
  StopFilledAlt,
  WarningAltFilled,
  WarningFilled,
} from "@carbon/react/icons";
import type { Liveness } from "@edgecommons/edge-console-protocol";
import type { RollupLevel } from "../fleet/selectors";

type CarbonTagType = "green" | "red" | "gray" | "cool-gray" | "high-contrast" | "outline";

interface StatusStyle {
  label: string;
  /** Stock Carbon tag type, when one carries the right semantics. */
  tagType?: CarbonTagType;
  /** Custom token-styled class for the states Carbon has no stock tag color for. */
  className?: string;
  Icon: React.ElementType;
}

/** The liveness ladder's visual contract (labels follow the signed-off mockup). */
export const LIVENESS_STYLE: Record<Liveness, StatusStyle> = {
  FRESH: { label: "Healthy", tagType: "green", Icon: CheckmarkFilled },
  WARN: { label: "Warning", className: "ec-tag--warn", Icon: WarningAltFilled },
  STALE: { label: "Stale", className: "ec-tag--stale", Icon: WarningFilled },
  OFFLINE: { label: "Offline", tagType: "red", Icon: ErrorFilled },
  STOPPED: { label: "Stopped", tagType: "gray", Icon: StopFilledAlt },
  UNREACHABLE: {
    label: "Unreachable",
    tagType: "gray",
    className: "ec-tag--unreach",
    Icon: CloudOffline,
  },
};

/** Device rollup chips (the fleet table's group rows), worst-of semantics. */
export const ROLLUP_STYLE: Record<RollupLevel, StatusStyle> = {
  healthy: { label: "Healthy", tagType: "green", Icon: CheckmarkFilled },
  degraded: { label: "Degraded", className: "ec-tag--warn", Icon: WarningAltFilled },
  critical: { label: "Critical", tagType: "red", Icon: ErrorFilled },
  unreachable: LIVENESS_STYLE.UNREACHABLE,
  stopped: { label: "Stopped", tagType: "gray", Icon: StopFilledAlt },
  empty: { label: "No components", tagType: "gray", Icon: CloudOffline },
};

function StyledTag({
  style,
  size,
}: {
  style: StatusStyle;
  size: "sm" | "md";
}): React.JSX.Element {
  return (
    <Tag
      type={style.tagType ?? "gray"}
      size={size}
      renderIcon={style.Icon}
      className={`ec-tag ${style.className ?? ""}`.trim()}
    >
      {style.label}
    </Tag>
  );
}

/** One component's liveness chip. */
export function StatusTag({
  liveness,
  size = "md",
}: {
  liveness: Liveness;
  size?: "sm" | "md";
}): React.JSX.Element {
  return <StyledTag style={LIVENESS_STYLE[liveness]} size={size} />;
}

/** One device's rollup chip. */
export function RollupTag({
  level,
  size = "sm",
}: {
  level: RollupLevel;
  size?: "sm" | "md";
}): React.JSX.Element {
  return <StyledTag style={ROLLUP_STYLE[level]} size={size} />;
}
