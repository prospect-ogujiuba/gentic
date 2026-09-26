/** Bounded, inert text extraction shared by the two fixed conditional policies. */
export function flattenTriggerText(value: unknown): string {
  const parts: string[] = [];
  const seen = new WeakSet<object>();
  let nodes = 0;
  let properties = 0;
  let characters = 0;
  let invalid = false;
  const visit = (entry: unknown, depth: number): void => {
    if (invalid) return;
    if (++nodes > 1024 || depth > 16) { invalid = true; return; }
    if (typeof entry === "string" || typeof entry === "number" || typeof entry === "boolean") {
      const text = String(entry);
      characters += text.length + (parts.length ? 1 : 0);
      if (characters > 32768) { invalid = true; return; }
      parts.push(text);
      return;
    }
    if (entry && typeof entry === "object") {
      if (seen.has(entry)) { invalid = true; return; }
      seen.add(entry);
      for (const key in entry) {
        if (invalid) break;
        if (++properties > 1024) { invalid = true; break; }
        if (!Object.hasOwn(entry, key)) continue;
        const descriptor = Object.getOwnPropertyDescriptor(entry, key);
        if (!descriptor || !("value" in descriptor)) { invalid = true; break; }
        visit(descriptor.value, depth + 1);
      }
      seen.delete(entry);
    }
  };
  try { visit(value, 0); } catch { invalid = true; }
  return invalid ? "" : parts.join("\n");
}

export function pathCandidates(text: string): string[] {
  const candidates: string[] = [];
  for (const match of text.matchAll(/\S+/g)) {
    if (match[0].length > 512 || candidates.length >= 1024) return [];
    candidates.push(match[0]);
  }
  return candidates;
}

/** Read only the four historically supported fields, independently and fail-closed. */
export function promptFields(event: { prompt?: unknown; systemPromptOptions?: { customPrompt?: unknown; appendSystemPrompt?: unknown; contextFiles?: unknown } }): string[] {
  const read = (get: () => unknown): string => {
    try { return flattenTriggerText(get()); } catch { return ""; }
  };
  return [read(() => event.prompt), read(() => event.systemPromptOptions?.customPrompt),
    read(() => event.systemPromptOptions?.appendSystemPrompt), read(() => event.systemPromptOptions?.contextFiles)];
}
