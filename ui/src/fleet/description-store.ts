/**
 * DescriptionStore (browser) — the pure fold core for Phase 3 descriptor discovery.
 *
 * The gateway owns `cmd/describe` invocation and sends `descriptor` /
 * `descriptor-unavailable` frames. This store keeps those results keyed by component,
 * with the same identity-stable derived view discipline as the other browser stores.
 */
import type { CommandError, ComponentDescribeManifest, ComponentKey } from "@edgecommons/edge-console-protocol";
import { componentKeyId } from "@edgecommons/edge-console-protocol";

export type DescriptorPhase = "loading" | "ready" | "unavailable";

export interface DescriptorEntryView {
  key: ComponentKey;
  id: string;
  phase: DescriptorPhase;
  manifest?: ComponentDescribeManifest;
  receivedAt?: number;
  reason?: string;
  code?: string;
  refreshing: boolean;
}

export interface DescriptionsView {
  entriesById: Record<string, DescriptorEntryView>;
}

const EMPTY_VIEW: DescriptionsView = { entriesById: {} };

export class DescriptionStore {
  private readonly entries = new Map<string, DescriptorEntryView>();
  private version = 0;
  private cachedView: DescriptionsView = EMPTY_VIEW;
  private cachedVersion = -1;

  noteRequested(key: ComponentKey): void {
    const id = componentKeyId(key);
    const prev = this.entries.get(id);
    this.entries.set(id, {
      key: { ...key },
      id,
      phase: prev?.phase === "ready" ? "ready" : "loading",
      ...(prev?.manifest !== undefined ? { manifest: prev.manifest } : {}),
      ...(prev?.receivedAt !== undefined ? { receivedAt: prev.receivedAt } : {}),
      ...(prev?.reason !== undefined ? { reason: prev.reason } : {}),
      ...(prev?.code !== undefined ? { code: prev.code } : {}),
      refreshing: prev !== undefined,
    });
    this.bump();
  }

  applyDescriptor(key: ComponentKey, manifest: ComponentDescribeManifest, receivedAt: number): void {
    const id = componentKeyId(key);
    this.entries.set(id, {
      key: { ...key },
      id,
      phase: "ready",
      manifest,
      receivedAt,
      refreshing: false,
    });
    this.bump();
  }

  applyUnavailable(key: ComponentKey, error: Pick<CommandError, "code" | "message">): void {
    const id = componentKeyId(key);
    const prev = this.entries.get(id);
    this.entries.set(id, {
      key: { ...key },
      id,
      phase: "unavailable",
      ...(prev?.manifest !== undefined ? { manifest: prev.manifest } : {}),
      ...(prev?.receivedAt !== undefined ? { receivedAt: prev.receivedAt } : {}),
      reason: error.message,
      ...(error.code !== "" ? { code: error.code } : {}),
      refreshing: false,
    });
    this.bump();
  }

  view(): DescriptionsView {
    if (this.cachedVersion === this.version) return this.cachedView;
    const entriesById: Record<string, DescriptorEntryView> = {};
    for (const entry of this.entries.values()) {
      entriesById[entry.id] = { ...entry, key: { ...entry.key } };
    }
    this.cachedView = { entriesById };
    this.cachedVersion = this.version;
    return this.cachedView;
  }

  private bump(): void {
    this.version++;
  }
}
