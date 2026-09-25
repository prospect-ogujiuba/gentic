import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { registerPiGit } from "./src/pi/register.ts";

export { collectGitSnapshot } from "./src/app/snapshot.ts";
export type {
  GitFailure,
  GitPath,
  GitRemote,
  GitSnapshot,
  GitSnapshotCollector,
} from "../../src/contracts/git-snapshot.ts";

export default function piGit(pi: ExtensionAPI): void {
  registerPiGit(pi);
}
