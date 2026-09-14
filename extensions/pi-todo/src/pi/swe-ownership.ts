import { activeWorkflowTopics } from "../../../pi-swe/src/store.ts";

/** pi-swe owns tool lifecycle only while a discoverable workflow task is active. */
export function hasActiveSweWorkflow(cwd: string): boolean {
  return activeWorkflowTopics(cwd).length > 0;
}
