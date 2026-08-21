import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { gitSnapshotService, type GitSnapshotService } from "../app/git-snapshot-service.ts";
import { createSnapshot, withLiveUsage } from "../app/snapshot.ts";
import { resetHudState, state } from "../app/state.ts";
import { createHudFooterComponent, createHudWidgetComponent, renderFooterLines } from "../ui/surfaces/footer.ts";
import type { HudModalHandle, Theme } from "../../types.ts";

const HUD_WIDGET_ID = "pi-hud";
const HUD_STATUS_ID = "pi-hud";
const RPC_RENDER_WIDTH = 120;
const RPC_THEME: Theme = { fg: (_color: unknown, text: string) => text };

export type HudUiContext = Pick<ExtensionContext, "cwd" | "getContextUsage" | "getSystemPrompt" | "mode" | "model" | "ui">;

export class HudRuntimeOwner {
  private active = false;
  private generation = 0;
  private context?: HudUiContext;
  private modal?: HudModalHandle;
  private readonly snapshots: Pick<GitSnapshotService, "reset" | "dispose" | "requestRefresh" | "currentGeneration" | "isCurrent">;

  constructor(snapshots: Pick<GitSnapshotService, "reset" | "dispose" | "requestRefresh" | "currentGeneration" | "isCurrent"> = gitSnapshotService) {
    this.snapshots = snapshots;
  }

  isActive(): boolean {
    return this.active;
  }

  currentGeneration(): number {
    return this.generation;
  }

  start(ctx: HudUiContext): void {
    if (this.active) this.shutdown(this.context ?? ctx);
    else this.disposeModal();
    this.generation += 1;
    this.active = true;
    this.context = ctx;
    resetHudState();
    this.snapshots.reset(ctx.cwd);
  }

  shutdown(ctx: HudUiContext = this.context as HudUiContext): void {
    if (!this.active) return;
    this.active = false;
    this.generation += 1;
    const ownedContext = this.context ?? ctx;
    this.context = undefined;
    this.disposeModal();
    if (ownedContext) this.clearOwnedUi(ownedContext);
    this.snapshots.dispose();
    resetHudState();
  }

  recordEvent(ctx: HudUiContext, name: string, refresh = true): void {
    if (!this.active) return;
    state.recentEvents = [name, ...state.recentEvents.filter((event) => event !== name)].slice(0, 8);
    this.apply(ctx);
    if (refresh && (ctx.mode === "tui" || ctx.mode === "rpc")) this.refresh(ctx);
  }

  apply(ctx: HudUiContext): void {
    if (!this.active) return;
    this.clearRendering(ctx);
    if (state.displayMode === "off" || (ctx.mode !== "tui" && ctx.mode !== "rpc")) return;

    const snapshot = createSnapshot(ctx);
    const liveSnapshot = () => withLiveUsage(snapshot, ctx);
    if (ctx.mode === "rpc") {
      ctx.ui.setWidget(HUD_WIDGET_ID, renderFooterLines(liveSnapshot(), RPC_THEME, RPC_RENDER_WIDTH));
      return;
    }

    this.modal?.update(liveSnapshot());
    if (state.displayMode === "footer") ctx.ui.setFooter(createHudFooterComponent(liveSnapshot));
    else ctx.ui.setWidget(HUD_WIDGET_ID, createHudWidgetComponent(liveSnapshot));
  }

  attachModal(handle: HudModalHandle): void {
    if (!this.active) {
      handle.dispose();
      return;
    }
    if (this.modal === handle) return;
    this.disposeModal();
    this.modal = handle;
  }

  detachModal(handle: HudModalHandle): void {
    if (this.modal === handle) this.modal = undefined;
  }

  private refresh(ctx: HudUiContext): void {
    const lifecycleGeneration = this.generation;
    const refresh = this.snapshots.requestRefresh(ctx.cwd);
    const snapshotGeneration = this.snapshots.currentGeneration();
    void refresh.then(() => {
      if (this.active
        && this.generation === lifecycleGeneration
        && this.snapshots.isCurrent(snapshotGeneration, ctx.cwd)) this.apply(ctx);
    });
  }

  private disposeModal(): void {
    const modal = this.modal;
    this.modal = undefined;
    try {
      modal?.dispose();
    } catch {
      // Cleanup is best-effort and must remain restart-safe.
    }
  }

  private clearRendering(ctx: HudUiContext): void {
    if (ctx.mode === "tui") {
      this.tryUi(() => ctx.ui.setFooter(undefined));
      this.tryUi(() => ctx.ui.setWidget(HUD_WIDGET_ID, undefined));
    } else if (ctx.mode === "rpc") {
      this.tryUi(() => ctx.ui.setWidget(HUD_WIDGET_ID, undefined));
    }
  }

  private clearOwnedUi(ctx: HudUiContext): void {
    this.clearRendering(ctx);
    if (ctx.mode === "tui" || ctx.mode === "rpc") this.tryUi(() => ctx.ui.setStatus(HUD_STATUS_ID, undefined));
  }

  private tryUi(effect: () => void): void {
    try {
      effect();
    } catch {
      // Continue clearing independently owned surfaces after partial setup failure.
    }
  }
}

export const hudRuntime = new HudRuntimeOwner();
