/**
 * The Components screen (slice R2) — faithful to the signed-off hi-fi
 * (`docs/mockups-hifi.html`, `#screen-components`): a navigable tree built DYNAMICALLY from
 * the identity hierarchy (Site → …intermediate levels… → device → component, never a
 * hardcoded "line"), beside a context pane. Selecting a **line/device** node rosters
 * everything beneath it (the tree doubles as the site inventory); selecting a **component**
 * leaf opens the real multi-tab component detail inline. The app-bar global search (shared
 * {@link SearchContext}) filters the tree — one of the mockup's four documented paths to a
 * component (this tree + the header search; an Overview row and a Topology chip are the
 * other two, and still use the standalone detail route as a deep-link surface).
 *
 * `ComponentsView` is purely presentational (state in, DOM out — component-testable without a
 * socket); `ConnectedComponentsView` binds it to the shared {@link FleetClient}.
 */
import { useEffect, useState } from "react";
import { Button, InlineLoading, Tag, Tile } from "@carbon/react";
import {
  ChevronDown,
  ChevronRight,
  ArrowRight,
} from "@carbon/react/icons";
import type { ComponentKey } from "@edgecommons/edge-console-protocol";
import type { RollupLevel } from "../fleet/selectors";
import type { ClientState, FleetClient } from "../fleet/client";
import type { ComponentView } from "../fleet/store";
import { formatDurationMs } from "../fleet/selectors";
import { useFleetState, useNowTick } from "../fleet/useFleet";
import { useSearch } from "../shell/search";
import { RollupTag, StatusTag } from "../health/StatusTag";
import { CommandToasts } from "../health/CommandToasts";
import type { InvokeCommand } from "../health/EdgeHealthView";
import { ComponentDetailView } from "./ComponentDetailView";
import {
  buildComponentTree,
  collectComponents,
  findNode,
} from "./components-tree";
import type { ComponentTreeNode } from "./components-tree";

/** A no-op command seam (presentational tests without a live client). */
const NO_INVOKE: InvokeCommand = () => undefined;

/** Rollup → the mockup's health-dot color class (`.ec-dot--*`). */
const ROLLUP_DOT: Record<RollupLevel, string> = {
  healthy: "ok",
  degraded: "warn",
  critical: "err",
  unreachable: "un",
  stopped: "idle",
  empty: "idle",
};

/** One tree row (a group or a component leaf) + its (uncollapsed) descendants. */
function TreeRow({
  node,
  selectedKey,
  collapsed,
  onSelect,
  onToggle,
}: {
  node: ComponentTreeNode;
  selectedKey: string | undefined;
  collapsed: ReadonlySet<string>;
  onSelect: (node: ComponentTreeNode) => void;
  onToggle: (key: string) => void;
}): React.JSX.Element {
  const isGroup = node.kind === "group";
  const hasChildren = node.children.length > 0;
  const isCollapsed = collapsed.has(node.key);
  const selected = node.key === selectedKey;
  return (
    <>
      <div
        className={`ec-tree__n${selected ? " ec-tree__n--sel" : ""}`}
        style={{ paddingInlineStart: `${0.75 + node.depth * 1.375}rem` }}
        role="treeitem"
        aria-selected={selected}
        aria-expanded={hasChildren ? !isCollapsed : undefined}
        data-testid={`tree-node-${node.key}`}
        onClick={() => onSelect(node)}
      >
        {hasChildren ? (
          <button
            type="button"
            className="ec-tree__tw"
            aria-label={`${isCollapsed ? "Expand" : "Collapse"} ${node.value}`}
            data-testid={`tree-toggle-${node.key}`}
            onClick={(e) => {
              e.stopPropagation();
              onToggle(node.key);
            }}
          >
            {isCollapsed ? <ChevronRight size={16} /> : <ChevronDown size={16} />}
          </button>
        ) : (
          <span className="ec-tree__tw ec-tree__tw--leaf" aria-hidden="true" />
        )}
        <span className={`ec-dot ec-dot--${ROLLUP_DOT[node.rollup]}`} aria-hidden="true" />
        <span className={`ec-tree__label${isGroup ? " ec-tree__label--group" : ""}`}>
          {node.depth === 0 && isGroup ? (
            <>
              <span className="ec-dim">{node.level}:</span> {node.label}
            </>
          ) : (
            node.label
          )}
        </span>
        {isGroup && (
          node.unreachable ? (
            <Tag size="sm" type="gray" className="ec-tag ec-tag--unreach">
              unreachable
            </Tag>
          ) : (
            <Tag size="sm" type="gray" className="ec-tag ec-tree__count">
              {node.count}
            </Tag>
          )
        )}
      </div>
      {hasChildren &&
        !isCollapsed &&
        node.children.map((child) => (
          <TreeRow
            key={child.key}
            node={child}
            selectedKey={selectedKey}
            collapsed={collapsed}
            onSelect={onSelect}
            onToggle={onToggle}
          />
        ))}
    </>
  );
}

/** The roster shown when a site/level/device node is selected — the site inventory. */
function Roster({
  node,
  nowServerMs,
  onOpen,
}: {
  node: ComponentTreeNode;
  nowServerMs: number;
  onOpen: (comp: ComponentView) => void;
}): React.JSX.Element {
  const comps = collectComponents(node);
  return (
    <div data-testid="components-roster">
      <div className="ec-roster__hd">
        <div>
          <div className="ec-roster__title">
            <span className="ec-dim">{node.level}</span> {node.value}
          </div>
          <div className="ec-dim ec-roster__sub">
            {comps.length} component{comps.length === 1 ? "" : "s"} beneath — the site inventory
            for this node
          </div>
        </div>
        <RollupTag level={node.rollup} size="md" />
      </div>
      <div className="ec-roster">
        <div className="ec-roster__row ec-roster__row--hd">
          <span>Health</span>
          <span>Component</span>
          <span>Device</span>
          <span>Heartbeat</span>
          <span>Action</span>
        </div>
        {comps.map((comp) => (
          <div className="ec-roster__row" key={comp.id} data-testid={`roster-row-${comp.id}`}>
            <StatusTag liveness={comp.liveness} size="sm" />
            <span className="ec-pri">{comp.key.component}</span>
            <span className="ec-mono">{comp.key.device}</span>
            <span className="ec-mono ec-tnum">
              {comp.lastStateAt !== undefined
                ? `${formatDurationMs(Math.max(0, nowServerMs - comp.lastStateAt))} ago`
                : "—"}
            </span>
            <Button
              kind="ghost"
              size="sm"
              renderIcon={ArrowRight}
              data-testid={`roster-open-${comp.id}`}
              onClick={() => onOpen(comp)}
            >
              Open
            </Button>
          </div>
        ))}
      </div>
    </div>
  );
}

export interface ComponentsViewProps {
  state: ClientState;
  /** Client-clock ms (the 1 Hz tick) — drives every age/heartbeat cell. */
  now: number;
  /** The shared global-search query (from the app-bar) — filters the tree. */
  query?: string;
  /** Mirror the app-bar search from the on-screen "Filter tree…" box. */
  onSearchChange?: (query: string) => void;
  /** Notify the connected wrapper which component is selected so it can request detail data. */
  onSelectedComponentChange?: (key: ComponentKey | undefined) => void;
  /** Refresh the selected component's panel descriptor. */
  onRefreshDescriptor?: (key: ComponentKey) => void;
  /** Refresh/re-announce configuration from the embedded detail. */
  onRefreshConfig?: (key: ComponentKey) => void;
  /** To the Events & Alarms screen from the embedded detail. */
  onOpenEvents?: () => void;
  /** To the Signals screen, scoped to the selected component. */
  onOpenSignals?: (key: ComponentKey) => void;
  /** Fire a C4 command (the embedded detail's Ping / Get config); defaults to a no-op. */
  onInvoke?: InvokeCommand;
}

export function ComponentsView({
  state,
  now,
  query = "",
  onSearchChange,
  onSelectedComponentChange,
  onRefreshConfig,
  onRefreshDescriptor,
  onOpenEvents,
  onOpenSignals,
  onInvoke = NO_INVOKE,
}: ComponentsViewProps): React.JSX.Element {
  const { fleet, status, hasSnapshot } = state;
  const tree = buildComponentTree(fleet, query);

  const [selectedKey, setSelectedKey] = useState<string | undefined>(undefined);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const toggle = (key: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  // The effective selection: the picked node if it still exists, else the first root
  // (so the site inventory rosters immediately — a sensible default first impression).
  const selectedNode =
    (selectedKey !== undefined ? findNode(tree.roots, selectedKey) : undefined) ?? tree.roots[0];

  const selectNode = (node: ComponentTreeNode) => {
    setSelectedKey(node.key);
    onSelectedComponentChange?.(node.kind === "component" && node.comp !== undefined ? node.comp.key : undefined);
  };

  const selectComp = (comp: ComponentView) => {
    setSelectedKey(comp.id);
    onSelectedComponentChange?.(comp.key);
  };

  return (
    <div className="ec-components">
      <h1 className="ec-ph">Components</h1>
      <div className="ec-ph-sub">
        <span>Browse the site inventory and drill into any component.</span>
      </div>

      {!hasSnapshot ? (
        <Tile className="ec-empty" data-testid="empty-state">
          {status === "connecting" || status === "reconnecting" ? (
            <InlineLoading description="Connecting to the console gateway…" />
          ) : (
            <>
              <h3>Not connected</h3>
              <p className="ec-dim">
                The console gateway is unreachable. The component tree appears as soon as the
                fleet stream is established.
              </p>
            </>
          )}
        </Tile>
      ) : tree.total === 0 && query.trim() === "" ? (
        <Tile className="ec-empty" data-testid="empty-fleet">
          <h3>No components discovered yet</h3>
          <p className="ec-dim">
            Components appear here automatically within one keepalive interval of coming up
            (default 5 s).
          </p>
        </Tile>
      ) : (
        <div className="ec-components__grid">
          <div className="ec-components__tree-col">
            <div className="ec-tree-filter">
              <span aria-hidden="true">🔍</span>
              <input
                className="ec-tree-filter__input"
                type="text"
                placeholder="Filter tree…"
                aria-label="Filter component tree"
                value={query}
                onChange={(e) => onSearchChange?.(e.target.value)}
                data-testid="tree-filter"
              />
            </div>
            {tree.total === 0 ? (
              <Tile className="ec-empty" data-testid="tree-empty-search">
                <p className="ec-dim">
                  No components match <b>{query}</b>. The tree filters on component, device, and
                  hierarchy names.
                </p>
              </Tile>
            ) : (
              <div className="ec-tree" role="tree" aria-label="Component hierarchy" data-testid="component-tree">
                {tree.roots.map((node) => (
                  <TreeRow
                    key={node.key}
                    node={node}
                    selectedKey={selectedNode?.key}
                    collapsed={collapsed}
                    onSelect={selectNode}
                    onToggle={toggle}
                  />
                ))}
              </div>
            )}
          </div>

          <div className="ec-components__pane">
            {selectedNode === undefined ? (
              <Tile className="ec-empty">
                <p className="ec-dim">Select a node in the tree to roster it or drill in.</p>
              </Tile>
            ) : selectedNode.kind === "component" && selectedNode.comp !== undefined ? (
              <ComponentDetailView
                state={state}
                now={now}
                detailKey={selectedNode.comp.key}
                embedded
                onInvoke={onInvoke}
                {...(onRefreshConfig !== undefined ? { onRefreshConfig } : {})}
                {...(onRefreshDescriptor !== undefined ? { onRefreshDescriptor } : {})}
                {...(onOpenEvents !== undefined ? { onOpenEvents } : {})}
                {...(onOpenSignals !== undefined ? { onOpenSignals: () => onOpenSignals(selectedNode.comp!.key) } : {})}
              />
            ) : (
              <Roster node={selectedNode} nowServerMs={now - fleet.clockOffsetMs} onOpen={selectComp} />
            )}
          </div>
        </div>
      )}
      <CommandToasts commands={state.commands} />
    </div>
  );
}

/** The live container: binds the view to the shared {@link FleetClient} + the 1 Hz tick. */
export function ConnectedComponentsView({
  client,
  onOpenEvents,
  onOpenSignals,
}: {
  client: FleetClient;
  onOpenEvents?: () => void;
  onOpenSignals?: (key: ComponentKey) => void;
}): React.JSX.Element {
  const state = useFleetState(client);
  const now = useNowTick(1000);
  const { query, setQuery } = useSearch();
  const [selectedComponent, setSelectedComponent] = useState<ComponentKey | undefined>(undefined);
  const selectedId = selectedComponent !== undefined ? `${selectedComponent.device}/${selectedComponent.component}` : undefined;
  const status = state.status;

  useEffect(() => {
    if (status === "connected" && selectedComponent !== undefined) {
      client.requestConfig(selectedComponent);
      client.requestDescriptor(selectedComponent);
      client.subscribeLogs(selectedComponent, { limit: 500 });
    }
  }, [client, selectedId, selectedComponent, status]);
  useEffect(
    () => () => {
      if (selectedComponent !== undefined) client.unsubscribeLogs(selectedComponent);
    },
    [client, selectedId, selectedComponent],
  );

  useEffect(() => {
    if (status === "connected") client.subscribeEvents();
  }, [client, status]);
  useEffect(() => () => client.unsubscribeEvents(), [client]);
  useEffect(() => {
    if (status === "connected") client.subscribeMetrics();
  }, [client, status]);
  useEffect(() => () => client.unsubscribeMetrics(), [client]);

  return (
    <ComponentsView
      state={state}
      now={now}
      query={query}
      onSearchChange={setQuery}
      onSelectedComponentChange={setSelectedComponent}
      onRefreshConfig={(key) => client.refreshConfig(key)}
      onRefreshDescriptor={(key) => client.refreshDescriptor(key)}
      {...(onOpenEvents !== undefined ? { onOpenEvents } : {})}
      {...(onOpenSignals !== undefined ? { onOpenSignals } : {})}
      onInvoke={(key, verb, args) => client.invokeCommand(key, verb, args)}
    />
  );
}
