/**
 * The Components-screen navigable tree (slice R2) — built DYNAMICALLY from each
 * component's identity `hier` (never a hardcoded "line" tier), the same discipline the
 * Overview grouping uses. The UNS hierarchy may include levels above site (for example
 * `[enterprise, site, line, device]`) and the
 * components hang off the device, so the full navigable tree is
 *   Site → …intermediate levels… → device → component
 * with as many (or as few) intermediate levels as the fleet actually advertises:
 *   - `[enterprise, site, line, device]` → enterprise → Site → line → device → component;
 *   - `[site, line, device]`             → Site → line → device → component;
 *   - `[site, area, line, device]`       → Site → area → line → device → component;
 *   - `[site, device]`                   → Site → device → component (no intermediate tier);
 *   - `[device]` / empty            → device → component (degenerate — no site context).
 *
 * Selecting a **group** node (site / an intermediate level / a device) rosters everything
 * beneath it (the tree doubles as the site inventory); selecting a **component** leaf shows
 * that component's summary. Each group carries the worst-of health rollup over the components
 * beneath, and device-UNREACHABLE containment propagates up (the "road is down" treatment).
 *
 * Pure, no IO/clock — unit-tested over several `hier` shapes. The optional `query`/`statusFilter`
 * filter the fleet BEFORE the tree is built (so empty branches vanish); this is where the
 * app-bar global search meets the tree.
 */
import type { ComponentKey, Liveness } from "@edgecommons/edge-console-protocol";
import { componentKeyId } from "@edgecommons/edge-console-protocol";
import type { ComponentView, FleetView } from "../fleet/store";
import type { RollupLevel } from "../fleet/selectors";
import { matchesQuery, rollupOfComponents } from "../fleet/grouping";

/** One node of the Components tree — a group (site/level/device) or a component leaf. */
export interface ComponentTreeNode {
  /** `group` = site / intermediate level / device; `component` = a leaf. */
  kind: "group" | "component";
  /** The hier level name (e.g. `site`/`line`/`device`) or `component` for a leaf. */
  level: string;
  /** The value at this level (e.g. `dallas`/`packaging`/`pack-gw-01`) or the component name. */
  value: string;
  /** Human label (group value, or `component` name — the UI adds the instance tag). */
  label: string;
  /** Stable selection id + React key (group path key, or the component's canonical id). */
  key: string;
  /** Nesting depth (0 = the outermost site tier) — drives the row indent. */
  depth: number;
  /** Worst-of rollup over components beneath (group) or this component's own liveness (leaf). */
  rollup: RollupLevel;
  /** Components beneath (group) or 1 (leaf). */
  count: number;
  /** Whether any device beneath is UNREACHABLE (containment). */
  unreachable: boolean;
  /** Nested sub-nodes (child levels then component leaves); empty for a leaf. */
  children: ComponentTreeNode[];
  /** The component (present only on a leaf). */
  comp?: ComponentView;
  /** Effective liveness (present only on a leaf). */
  liveness?: Liveness;
}

/** The whole Components tree the screen renders. */
export interface ComponentTree {
  /** The `site` hierarchy value — the page-context label; undefined when no component carries it. */
  site?: string;
  /** The top-level nodes (usually a single Site root). */
  roots: ComponentTreeNode[];
  /** Total components across the whole tree (after filtering). */
  total: number;
}

/** The hier path segments for one component (`[{level,value}]`, last = device). */
function hierSegments(comp: ComponentView): { level: string; value: string }[] {
  if (comp.hier.length > 0) return comp.hier.map((e) => ({ level: e.level, value: e.value }));
  // Degenerate: no advertised hierarchy — group by the device alone.
  return [{ level: "device", value: comp.key.device }];
}

function siteValue(comp: ComponentView): string | undefined {
  return comp.hier.find((entry) => entry.level === "site")?.value;
}

/** A mutable trie builder assembled during the walk, converted to immutable nodes at the end. */
interface Builder {
  level: string;
  value: string;
  key: string;
  depth: number;
  /** Child level builders, keyed by value (insertion order preserved for stable-ish output). */
  children: Map<string, Builder>;
  /** Component leaves attached at this node (the terminal/device tier). */
  components: ComponentView[];
  /** Whether any device in/under this subtree is unreachable. */
  unreachable: boolean;
}

function newBuilder(level: string, value: string, key: string, depth: number): Builder {
  return { level, value, key, depth, children: new Map(), components: [], unreachable: false };
}

/** Every component beneath a builder (leaves at this node + all descendants). */
function componentsUnder(b: Builder): ComponentView[] {
  const out = [...b.components];
  for (const child of b.children.values()) out.push(...componentsUnder(child));
  return out;
}

/** Convert a group builder to an immutable {@link ComponentTreeNode} (rollups computed bottom-up). */
function toNode(b: Builder): ComponentTreeNode {
  const childNodes = [...b.children.values()]
    .sort((a, c) => a.value.localeCompare(c.value))
    .map(toNode);
  const leafNodes = [...b.components]
    .sort((a, c) => componentKeyId(a.key).localeCompare(componentKeyId(c.key)))
    .map((comp) => componentNode(comp, b.depth + 1));
  const all = componentsUnder(b);
  return {
    kind: "group",
    level: b.level,
    value: b.value,
    label: b.value,
    key: b.key,
    depth: b.depth,
    rollup: rollupOfComponents(all),
    count: all.length,
    unreachable: b.unreachable,
    children: [...childNodes, ...leafNodes],
  };
}

/** A component leaf node. */
function componentNode(comp: ComponentView, depth: number): ComponentTreeNode {
  return {
    kind: "component",
    level: "component",
    value: comp.key.component,
    label: comp.key.component,
    key: comp.id,
    depth,
    rollup: rollupOfComponents([comp]),
    count: 1,
    unreachable: comp.liveness === "UNREACHABLE",
    children: [],
    comp,
    liveness: comp.liveness,
  };
}

/**
 * Build the dynamic Components tree from the fleet view. The optional `query` (component /
 * device / hierarchy match) and `statusFilter` (keep only a given effective liveness) filter
 * the fleet BEFORE the tree is assembled, so empty branches vanish.
 */
export function buildComponentTree(
  view: FleetView,
  query = "",
  statusFilter?: Liveness,
): ComponentTree {
  const roots = new Map<string, Builder>();
  let total = 0;
  const siteCounts = new Map<string, number>();

  for (const device of view.devices) {
    for (const comp of device.components) {
      if (!matchesQuery(comp, query)) continue;
      if (statusFilter !== undefined && comp.liveness !== statusFilter) continue;
      total++;
      const segments = hierSegments(comp);
      // The page context is the named `site` level, not necessarily the first hierarchy level.
      const site = siteValue(comp);
      if (site !== undefined) {
        siteCounts.set(site, (siteCounts.get(site) ?? 0) + 1);
      }
      // Walk/insert the group path; attach the component at the terminal (device) node.
      let level = roots;
      let parentKey = "";
      let builder: Builder | undefined;
      for (let i = 0; i < segments.length; i++) {
        const seg = segments[i]!;
        const key = parentKey === "" ? `${seg.level}=${seg.value}` : `${parentKey}/${seg.level}=${seg.value}`;
        let node = level.get(seg.value);
        if (node === undefined) {
          node = newBuilder(seg.level, seg.value, key, i);
          level.set(seg.value, node);
        }
        builder = node;
        level = node.children;
        parentKey = key;
      }
      if (builder !== undefined) {
        builder.components.push(comp);
        if (device.unreachable) markUnreachable(roots, segments);
      }
    }
  }

  const site = mostCommon(siteCounts);
  return {
    ...(site !== undefined ? { site } : {}),
    roots: [...roots.values()].sort((a, b) => a.value.localeCompare(b.value)).map(toNode),
    total,
  };
}

/** Propagate a device's UNREACHABLE up the group path (each ancestor becomes contained). */
function markUnreachable(roots: Map<string, Builder>, segments: { level: string; value: string }[]): void {
  let level = roots;
  for (const seg of segments) {
    const node = level.get(seg.value);
    if (node === undefined) return;
    node.unreachable = true;
    level = node.children;
  }
}

/** Every component beneath a tree node (a leaf yields itself) — the roster of a group. */
export function collectComponents(node: ComponentTreeNode): ComponentView[] {
  if (node.kind === "component") return node.comp !== undefined ? [node.comp] : [];
  return node.children.flatMap(collectComponents);
}

/** Find a node by its stable `key` anywhere in the tree (depth-first), or undefined. */
export function findNode(roots: ComponentTreeNode[], key: string): ComponentTreeNode | undefined {
  for (const node of roots) {
    if (node.key === key) return node;
    const hit = findNode(node.children, key);
    if (hit !== undefined) return hit;
  }
  return undefined;
}

/** Find a live {@link ComponentView} by canonical id across the fleet, or undefined. */
export function findComponent(view: FleetView, key: ComponentKey): ComponentView | undefined {
  const id = componentKeyId(key);
  for (const device of view.devices) {
    for (const comp of device.components) {
      if (comp.id === id) return comp;
    }
  }
  return undefined;
}

/** The most frequent key in a count map, or undefined for an empty map. */
function mostCommon(counts: Map<string, number>): string | undefined {
  let best: string | undefined;
  let bestN = 0;
  for (const [value, n] of counts) {
    if (n > bestN) {
      bestN = n;
      best = value;
    }
  }
  return best;
}
