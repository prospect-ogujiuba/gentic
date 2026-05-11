import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export interface PiCommandModule {
  name: string;
  register(pi: ExtensionAPI): void;
}
