/**
 * AttributeStore (browser) — the pure fold core for the R0 `attributes`/`attribute`
 * frames, the client-side mirror of the server AttributeStore: the latest per-component
 * runtime facts (cpu / memory / disk / threads / files / fds + the adapter southbound
 * connection state) that the Overview columns (R1) and the Component Detail Health tab
 * (R2) render.
 *
 * No IO, no clock reads; the {@link FleetClient} feeds it the `attributes` snapshot (a
 * full replace of every known component) and each `attribute` push (a latest-wins per
 * component batch). Identity-stable derived view for React, keyed by the canonical
 * `device/component/instance` id so a column projection is a single map lookup.
 */
import type { ComponentKey, RuntimeAttributes } from "@edgecommons/edge-console-protocol";
import { componentKeyId } from "@edgecommons/edge-console-protocol";

/** The derived view: the latest runtime attributes per component id. */
export interface AttributesView {
  byId: Record<string, RuntimeAttributes>;
}

const EMPTY_VIEW: AttributesView = { byId: {} };

/** The pure client attribute store: snapshot replace + per-component latest-wins updates. */
export class AttributeStore {
  private byId = new Map<string, RuntimeAttributes>();
  private version = 0;
  private cachedView: AttributesView = EMPTY_VIEW;
  private cachedVersion = -1;

  /** Fold an `attributes` frame: replaces every component's latest attributes wholesale. */
  applySnapshot(components: RuntimeAttributes[]): void {
    this.byId = new Map(components.map((c) => [componentKeyId(c.key), c]));
    this.version++;
  }

  /** Fold an `attribute` push: latest-wins upsert per component in the batch. */
  applyUpdates(updates: RuntimeAttributes[]): void {
    if (updates.length === 0) return;
    for (const update of updates) {
      this.byId.set(componentKeyId(update.key), update);
    }
    this.version++;
  }

  /** The latest attributes for one component, or `undefined` (nothing reported yet). */
  get(key: ComponentKey): RuntimeAttributes | undefined {
    return this.byId.get(componentKeyId(key));
  }

  /** The immutable derived view (cached; identity changes only when the store does). */
  view(): AttributesView {
    if (this.cachedVersion === this.version) return this.cachedView;
    const byId: Record<string, RuntimeAttributes> = {};
    for (const [id, attrs] of this.byId) byId[id] = attrs;
    this.cachedView = { byId };
    this.cachedVersion = this.version;
    return this.cachedView;
  }
}
