import { appendFileSync } from "node:fs";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  type Model,
  type SimpleStreamOptions,
  type ToolCall,
} from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const usage = {
  input: 1,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function streamFixture(
  model: Model<string>,
  context: Context,
  options?: SimpleStreamOptions,
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  const capturePath = process.env.PI_SWE_FIXTURE_CAPTURE;
  if (capturePath) {
    appendFileSync(capturePath, `${JSON.stringify({
      model: { provider: model.provider, id: model.id },
      reasoning: options?.reasoning ?? "off",
      systemPrompt: context.systemPrompt,
      tools: context.tools?.map((tool) => tool.name) ?? [],
      messageCount: context.messages.length,
    })}\n`);
  }

  queueMicrotask(() => {
    const pending: AssistantMessage = {
      role: "assistant",
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage,
      stopReason: "pending",
      timestamp: Date.now(),
    };
    const toolCall: ToolCall = {
      type: "toolCall",
      id: "fixture-report-call",
      name: "runner_report",
      arguments: {
        outcome: "approved",
        summary: "local protocol fixture completed",
      },
    };
    stream.push({ type: "start", partial: pending });
    pending.content.push(toolCall);
    stream.push({ type: "toolcall_start", contentIndex: 0, partial: pending });
    stream.push({
      type: "toolcall_delta",
      contentIndex: 0,
      delta: JSON.stringify(toolCall.arguments),
      partial: pending,
    });
    stream.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial: pending });
    const complete: AssistantMessage = { ...pending, stopReason: "toolUse" };
    stream.push({ type: "done", reason: "toolUse", message: complete });
    stream.end();
  });

  return stream;
}

export default function fixtureExtension(pi: ExtensionAPI): void {
  if (process.env.PI_SWE_FIXTURE_PROVIDER_ONLY !== "1") pi.registerTool(defineTool({
    name: "runner_report",
    label: "Runner report",
    description: "Submit the fixture report and terminate the child.",
    parameters: Type.Object({
      outcome: Type.Literal("approved"),
      summary: Type.String(),
    }),
    async execute(_toolCallId, params) {
      return {
        content: [{ type: "text", text: "fixture report accepted" }],
        details: params,
        terminate: true,
      };
    },
  }));

  pi.registerProvider("swe-fixture", {
    api: "swe-fixture-api",
    baseUrl: "http://127.0.0.1/unused",
    apiKey: "local-fixture",
    models: [{
      id: "runner-fixture",
      name: "Runner fixture",
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 16_384,
      maxTokens: 2_048,
    }],
    streamSimple: streamFixture,
  });
}
