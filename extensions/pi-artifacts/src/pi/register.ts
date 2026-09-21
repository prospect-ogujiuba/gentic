import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";

import { ArtifactService, MAX_ARTIFACT_CONTENT_BYTES } from "../app/service.ts";
import { INITIATIVE_ARTIFACT_KINDS, SYSTEM_ARTIFACT_KINDS } from "../domain/types.ts";

const name = Type.String({ maxLength: 128 });
const content = Type.String({ maxLength: MAX_ARTIFACT_CONTENT_BYTES });
const parameters = Type.Union([
  Type.Object({
    scope: Type.Literal("initiative"),
    topic: Type.String({ maxLength: 128 }),
    kind: StringEnum(INITIATIVE_ARTIFACT_KINDS),
    name,
    content,
  }, { additionalProperties: false }),
  Type.Object({
    scope: Type.Literal("system"),
    kind: StringEnum(SYSTEM_ARTIFACT_KINDS),
    namespace: Type.Optional(Type.String({ maxLength: 128 })),
    name,
    content,
  }, { additionalProperties: false }),
]);

type ArtifactToolInput =
  | { scope: "initiative"; topic: string; kind: typeof INITIATIVE_ARTIFACT_KINDS[number]; name: string; content: string }
  | { scope: "system"; kind: typeof SYSTEM_ARTIFACT_KINDS[number]; namespace?: string; name: string; content: string };

export function registerArtifactSurface(pi: ExtensionAPI): void {
  const services = new Map<string, ArtifactService>();
  const service = (cwd: string) => {
    let current = services.get(cwd);
    if (!current) { current = new ArtifactService(cwd); services.set(cwd, current); }
    return current;
  };

  pi.registerTool({
    name: "artifact",
    label: "Artifact",
    description: "Create a Markdown model artifact at a safe canonical initiative or system path.",
    promptSnippet: "Use artifact to create durable model-generated specs, plans, todos, findings, reports, or logs in the canonical .model-artifacts layout.",
    promptGuidelines: [
      "Use initiative scope for work tied to one topic and system scope only for repository-wide reports or runtime logs.",
      "Do not use artifact to create or modify pi-swe workflow.json authority.",
    ],
    parameters,
    executionMode: "sequential",
    async execute(_id, input: ArtifactToolInput, signal, _update, ctx) {
      signal?.throwIfAborted();
      try {
        const created = service(ctx.cwd).create(input);
        return { content: [{ type: "text", text: `Created ${created.path}` }], details: { artifact: created } };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { content: [{ type: "text", text: message }], details: { error: message }, isError: true };
      }
    },
  });
}
