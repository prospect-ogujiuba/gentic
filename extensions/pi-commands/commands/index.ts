import type { PiCommandModule } from "../types.ts";
import { clearCommand } from "./clear.ts";
import { scaffoldCommand } from "./scaffold.ts";

export const commands: PiCommandModule[] = [clearCommand, scaffoldCommand];
