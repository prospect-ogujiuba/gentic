/** Public Todo registration and optional workflow-projection contracts. */
export { registerLightweightTodoSurface, type TodoSurfaceController } from "./pi/todo-surface.ts";
export { WorkflowTodoError, type TodoBackend, type TodoView, type TodoMutationResult } from "../../../src/todo-contracts/provider.ts";
export {
  TODO_WORKFLOW_FOCUS_CHANGED_EVENT,
  TODO_WORKFLOW_PROVIDER_AVAILABLE_EVENT,
  TODO_WORKFLOW_PROVIDER_REQUEST_EVENT,
  type TodoWorkflowProvider,
} from "../../../src/todo-contracts/workflow-integration.ts";
