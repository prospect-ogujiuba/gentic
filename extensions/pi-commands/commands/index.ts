import type { PiCommandModule } from "../types.ts";
import { clearCommand } from "./clear.ts";

export const commands: PiCommandModule[] = [clearCommand];
