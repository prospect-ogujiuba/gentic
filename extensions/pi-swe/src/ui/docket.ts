import type { Initiative } from "../domain/initiative.ts";
import { projectWorkflowTodoView } from "../todo/workflow-backend.ts";
import type { TodoView, TodoViewItem } from "../todo/provider.ts";
import {
  createSharedDocketComponent,
  renderSharedDocketLines,
  visibleTodoViewItems,
  type SharedDocketRenderOptions,
} from "../todo/ui/shared-docket.ts";
import type { SweTheme } from "./theme.ts";

export type SweDocketItem = TodoViewItem;
export type SweDocket = TodoView & {
  initiativeId: string;
  initiativeStatus: Initiative["status"];
};
export type SweDocketRenderOptions = {
  width?: number;
  includeDone?: boolean;
  limit?: number;
  selectedWorkId?: string;
  expandedWorkIds?: ReadonlySet<string>;
};

export function projectSweDocket(initiative: Initiative): SweDocket {
  const view = projectWorkflowTodoView(initiative);
  return { ...view, initiativeId: initiative.id, initiativeStatus: initiative.status };
}

export function visibleSweDocketItems(docket: SweDocket, includeDone = false): SweDocketItem[] {
  return visibleTodoViewItems(docket, includeDone);
}

export function renderSweDocketLines(docket: SweDocket, theme: SweTheme, options: SweDocketRenderOptions = {}): string[] {
  const shared: SharedDocketRenderOptions = {
    width: options.width,
    includeDone: options.includeDone,
    limit: options.limit,
    selectedId: options.selectedWorkId,
    expandedIds: options.expandedWorkIds,
  };
  return renderSharedDocketLines(docket, theme, shared);
}

export function createSweDocketComponent(docket: SweDocket, theme: SweTheme) {
  return createSharedDocketComponent(docket, theme);
}
