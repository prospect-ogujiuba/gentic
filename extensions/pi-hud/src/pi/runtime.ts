import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { gitSnapshotService, type GitSnapshotService } from "../app/git-snapshot-service.ts";
import { createSnapshot, withLiveUsage } from "../app/snapshot.ts";
import { resetHudState, state } from "../app/state.ts";
import { createHudWidgetComponent, renderHudWidgetLines } from "../ui/surfaces/widget.ts";
import type { Theme } from "../../types.ts";

const HUD_WIDGET_ID = "pi-hud";
const RPC_RENDER_WIDTH = 120;
const RPC_THEME: Theme = { fg: (_color: unknown, text: string) => text };

export type HudUiContext = Pick<ExtensionContext, "cwd" | "getContextUsage" | "getSystemPrompt" | "mode" | "model" | "ui">
  & Partial<Pick<ExtensionContext, "sessionManager">>;

export class HudRuntimeOwner {
  private active = false;
  private generation = 0;
  private context?: HudUiContext;
  private readonly snapshots: Pick<GitSnapshotService, "reset" | "dispose" | "requestRefresh" | "currentGeneration" | "isCurrent">;

  constructor(snapshots: Pick<GitSnapshotService, "reset" | "dispose" | "requestRefresh" | "currentGeneration" | "isCurrent"> = gitSnapshotService) {
    this.snapshots = snapshots;
  }

  isActive(): boolean { return this.active; }
  currentGeneration(): number { return this.generation; }

  start(ctx: HudUiContext): void {
    if (this.active) this.shutdown(this.context ?? ctx);
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
    if (ownedContext) this.clearWidget(ownedContext);
    this.snapshots.dispose();
    resetHudState();
  }

  update(ctx: HudUiContext, refreshGit = false): void {
    if (!this.active) return;
    this.apply(ctx);
    if (refreshGit && (ctx.mode === "tui" || ctx.mode === "rpc")) this.refresh(ctx);
  }

  apply(ctx: HudUiContext): void {
    if (!this.active || (ctx.mode !== "tui" && ctx.mode !== "rpc")) return;
    if (state.displayMode === "off") {
      this.clearWidget(ctx);
      return;
    }

    const snapshot = createSnapshot(ctx);
    const liveSnapshot = () => withLiveUsage(snapshot, ctx);
    if (ctx.mode === "rpc") ctx.ui.setWidget(HUD_WIDGET_ID, renderHudWidgetLines(liveSnapshot(), RPC_THEME, RPC_RENDER_WIDTH));
    else ctx.ui.setWidget(HUD_WIDGET_ID, createHudWidgetComponent(liveSnapshot));
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

  private clearWidget(ctx: HudUiContext): void {
    if (ctx.mode !== "tui" && ctx.mode !== "rpc") return;
    try {
      ctx.ui.setWidget(HUD_WIDGET_ID, undefined);
    } catch {
      // Cleanup remains restart-safe after partial UI failures.
    }
  }
}

export const hudRuntime = new HudRuntimeOwner();
