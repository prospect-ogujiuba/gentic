import type { PrimitiveContext } from "./index.ts";

/** Only bundled policy text is appended; trigger content is never interpolated. */
export function loadPromptPolicy(ctx: PrimitiveContext): (systemPrompt: string) => { systemPrompt: string } | undefined {
  return promptPolicy(ctx.readText("injection.md"));
}

/** Pure text transformation; callers own their explicit bundled file reads. */
export function promptPolicy(text: string): (systemPrompt: string) => { systemPrompt: string } | undefined {
  const injection = text.trim();
  if (injection.length > 8192) throw new Error("Primitive prompt policy exceeds 8192 characters");
  const heading = injection.split(/\r?\n/, 1)[0]!;
  return (systemPrompt) => {
    if (!injection || systemPrompt.split(/\r?\n/).includes(heading)) return;
    return { systemPrompt: `${systemPrompt}\n\n${injection}` };
  };
}
