import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerTodo } from "./src/pi/register.ts";

export default function piTodo(pi: ExtensionAPI): void {
  registerTodo(pi);
}
