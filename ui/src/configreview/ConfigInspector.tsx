/**
 * Reusable effective-configuration inspector: provenance, structured tree, raw JSON,
 * redaction treatment, loading/unavailable states, and the re-announce refresh action.
 *
 * This is the configuration experience mounted inside Component Detail's
 * Configuration tab. The old top-level Configuration Review route should not own
 * separate behavior from this component.
 */
import { useEffect, useMemo, useState } from "react";
import {
  Button,
  InlineLoading,
  InlineNotification,
  Tab,
  TabList,
  TabPanel,
  TabPanels,
  Tabs,
  Tag,
  Tile,
} from "@carbon/react";
import { ChevronDown, ChevronRight, Renew } from "@carbon/react/icons";
import type { ComponentKey } from "@edgecommons/edge-console-protocol";
import type { ConfigEntryView } from "../fleet/config-store";
import type { ComponentView } from "../fleet/store";
import { formatDurationMs } from "../fleet/selectors";
import {
  buildConfigTree,
  configHash,
  defaultExpandedPaths,
  effectiveConfig,
  flattenConfig,
  jsonTokens,
  redactionCounts,
} from "./selectors";
import type { ConfigTreeNode } from "./selectors";

const NO_REFRESH = () => undefined;

/** One leaf value, styled honestly (redacted masked, secret-ref labeled as a pointer). */
function ConfigLeafValue({ node }: { node: ConfigTreeNode }): React.JSX.Element {
  if (node.valueKind === "redacted") {
    return (
      <span className="ec-redacted" title="redacted at the source - the value never left the component">
        ●●●●●●
        <Tag size="sm" type="red" className="ec-tag">
          redacted
        </Tag>
      </span>
    );
  }
  if (node.valueKind === "secret-ref") {
    return (
      <>
        {node.display}
        <Tag size="sm" type="outline" className="ec-tag" title="vault reference - a pointer, not the secret value">
          secret ref
        </Tag>
      </>
    );
  }
  return <>{node.display}</>;
}

/** One tree node (a container disclosure row, or a value leaf) + its expanded children. */
function ConfigTreeRow({
  node,
  depth,
  expanded,
  onToggle,
}: {
  node: ConfigTreeNode;
  depth: number;
  expanded: ReadonlySet<string>;
  onToggle: (path: string) => void;
}): React.JSX.Element {
  const isContainer = node.kind === "object" || node.kind === "array";
  const isOpen = isContainer && expanded.has(node.path);
  return (
    <>
      <div
        className={`ec-cfg-tnode${isContainer ? " ec-cfg-tnode--group" : ""}`}
        role="treeitem"
        aria-expanded={isContainer ? isOpen : undefined}
        data-testid={`config-node-${node.path}`}
      >
        <span className="ec-cfg-tnode__k" style={{ paddingInlineStart: `${0.5 + depth * 1.25}rem` }}>
          {isContainer ? (
            <button
              type="button"
              className="ec-cfg-tnode__tw"
              aria-label={`${isOpen ? "Collapse" : "Expand"} ${node.path}`}
              data-testid={`config-toggle-${node.path}`}
              onClick={() => onToggle(node.path)}
            >
              {isOpen ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
            </button>
          ) : (
            <span className="ec-cfg-tnode__tw ec-cfg-tnode__tw--leaf" aria-hidden="true" />
          )}
          <span className={`ec-cfg-tnode__label${isContainer ? " ec-cfg-tnode__label--group" : ""}`}>
            {node.label}
          </span>
        </span>
        <span className="ec-cfg-tnode__v ec-mono">
          {isContainer ? (
            <span className="ec-dim ec-cfg-tnode__summary">{node.summary}</span>
          ) : (
            <ConfigLeafValue node={node} />
          )}
        </span>
      </div>
      {isOpen &&
        node.children?.map((child) => (
          <ConfigTreeRow
            key={child.path}
            node={child}
            depth={depth + 1}
            expanded={expanded}
            onToggle={onToggle}
          />
        ))}
    </>
  );
}

/** The Structured tab: a genuinely hierarchical nested render of the effective config. */
export function StructuredTree({ body }: { body: unknown }): React.JSX.Element {
  const effective = useMemo(() => effectiveConfig(body), [body]);
  const treeKey = useMemo(() => configHash(effective), [effective]);
  const nodes = useMemo(() => buildConfigTree(effective), [effective]);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => defaultExpandedPaths(nodes, 2));

  useEffect(() => setExpanded(defaultExpandedPaths(nodes, 2)), [treeKey]);

  const toggle = (path: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  if (nodes.length === 0) {
    return <p className="ec-dim">The announced configuration is empty.</p>;
  }
  return (
    <div className="ec-cfg-tree" data-testid="config-tree" role="tree" aria-label="Effective configuration tree">
      {nodes.map((node) => (
        <ConfigTreeRow key={node.path} node={node} depth={0} expanded={expanded} onToggle={toggle} />
      ))}
    </div>
  );
}

/** The provenance badges: real configHash, and non-announced source/schema shown honestly. */
export function ConfigProvenance({
  body,
  sourceTimestamp,
}: {
  body: unknown;
  sourceTimestamp?: string;
}): React.JSX.Element {
  const hash = configHash(effectiveConfig(body));
  return (
    <div className="ec-cfg-prov" data-testid="config-provenance">
      <Tag
        size="sm"
        type="blue"
        className="ec-tag ec-mono"
        data-testid="config-hash"
        title="Content fingerprint of the effective config, computed by the console; the cfg envelope carries no publisher hash."
      >
        configHash {hash}
      </Tag>
      <Tag
        size="sm"
        type="outline"
        className="ec-tag"
        data-testid="config-source-pending"
        title="The cfg envelope carries no config-source provenance yet."
      >
        source: not announced
      </Tag>
      <Tag
        size="sm"
        type="outline"
        className="ec-tag"
        data-testid="config-schema-pending"
        title="The cfg envelope carries no schema-validation metadata yet."
      >
        schema: not announced
      </Tag>
      {sourceTimestamp !== undefined && (
        <Tag
          size="sm"
          type="gray"
          className="ec-tag ec-mono"
          data-testid="config-published"
          title="The publisher's own header.timestamp claim."
        >
          published {sourceTimestamp}
        </Tag>
      )}
    </div>
  );
}

/** The Raw JSON tab: pretty JSON with redaction sentinels and secret refs syntax-classified. */
export function RawJson({ body }: { body: unknown }): React.JSX.Element {
  const tokens = jsonTokens(effectiveConfig(body));
  return (
    <pre className="ec-cfg-json" data-testid="config-json">
      {tokens.map((t, i) => (
        <span key={i} className={`ec-json--${t.kind}`}>
          {t.text}
        </span>
      ))}
    </pre>
  );
}

export interface ConfigInspectorProps {
  /** The fleet's view of the selection (may be gone while still selected). */
  comp?: ComponentView;
  selectedKey: ComponentKey;
  entry: ConfigEntryView | undefined;
  nowServerMs: number;
  onRefresh?: (key: ComponentKey) => void;
}

/** The detail pane for one component's selected/effective configuration. */
export function ConfigInspector({
  comp,
  selectedKey,
  entry,
  nowServerMs,
  onRefresh = NO_REFRESH,
}: ConfigInspectorProps): React.JSX.Element {
  const refreshing = entry?.refreshing === true;
  const refreshButton = (
    <Button
      kind="ghost"
      size="sm"
      renderIcon={Renew}
      disabled={refreshing}
      data-testid="refresh-config"
      onClick={() => onRefresh(selectedKey)}
    >
      {refreshing ? "Refreshing…" : "Refresh"}
    </Button>
  );

  const header = (
    <div className="ec-cfg-head">
      <div className="ec-cfg-head__id">
        <b>{selectedKey.component}</b>
        <span className="ec-dim ec-mono">{selectedKey.device}</span>
        {entry?.phase === "loaded" && entry.receivedAt !== undefined && (
          <span className="ec-dim" data-testid="config-received">
            received {formatDurationMs(Math.max(0, nowServerMs - entry.receivedAt))} ago
          </span>
        )}
      </div>
      <div className="ec-cfg-head__actions">{refreshButton}</div>
    </div>
  );

  if (entry === undefined || entry.phase === "loading") {
    return (
      <div className="ec-cfg-inspector" data-testid="config-inspector">
        {header}
        <Tile className="ec-empty" data-testid="config-loading">
          <InlineLoading description="Requesting configuration…" />
        </Tile>
      </div>
    );
  }

  if (entry.phase === "unavailable") {
    return (
      <div className="ec-cfg-inspector" data-testid="config-inspector">
        {header}
        <Tile className="ec-empty" data-testid="config-unavailable">
          <h3>No configuration received</h3>
          <p className="ec-dim">
            The console holds no <code>cfg</code> announcement for this component. <b>Refresh</b>{" "}
            asks every component on <span className="ec-mono">{selectedKey.device}</span> to re-announce.
          </p>
        </Tile>
      </div>
    );
  }

  const rows = flattenConfig(effectiveConfig(entry.body));
  const counts = redactionCounts(rows);
  return (
    <div className="ec-cfg-inspector" data-testid="config-inspector">
      {header}
      <ConfigProvenance
        body={entry.body}
        {...(entry.sourceTimestamp !== undefined ? { sourceTimestamp: entry.sourceTimestamp } : {})}
      />
      {refreshing && (
        <InlineNotification
          kind="info"
          lowContrast
          hideCloseButton
          title="Re-announce requested"
          subtitle={`republish-cfg broadcast sent to ${selectedKey.device}; a fresh announcement replaces this view automatically.`}
        />
      )}
      {counts.redacted > 0 && (
        <InlineNotification
          kind="warning"
          lowContrast
          hideCloseButton
          title={`${counts.redacted} value${counts.redacted === 1 ? "" : "s"} redacted at the source`}
          subtitle={
            "Masked by the component's library before publish; the real values never left the device." +
            (counts.secretRefs > 0
              ? ` ${counts.secretRefs} $secret reference${counts.secretRefs === 1 ? "" : "s"} shown as vault pointers.`
              : "")
          }
        />
      )}
      {comp === undefined && (
        <InlineNotification
          kind="warning"
          lowContrast
          hideCloseButton
          title="Component no longer in the fleet view"
          subtitle="Showing its last announced configuration."
        />
      )}
      <Tabs>
        <TabList aria-label="Configuration representation" className="ec-cfg-tabs">
          <Tab>Structured</Tab>
          <Tab>Raw JSON</Tab>
        </TabList>
        <TabPanels>
          <TabPanel>
            <StructuredTree body={entry.body} />
          </TabPanel>
          <TabPanel>
            <RawJson body={entry.body} />
          </TabPanel>
        </TabPanels>
      </Tabs>
    </div>
  );
}
