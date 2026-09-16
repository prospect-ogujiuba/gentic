import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";

import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { RUNNER_PROTOCOL_VERSION, type ChildRunConfig } from "./runner-protocol.ts";
import { scopeAllowsPath } from "./workflow.ts";

const MAX_FILE_BYTES = 1024 * 1024;
const MAX_SHELL_OUTPUT_BYTES = 128 * 1024;

function loadConfig(): ChildRunConfig {
  const path = process.env.PI_SWE_RUN_CONFIG;
  if (!path) throw new Error("PI_SWE_RUN_CONFIG is required");
  const raw = readFileSync(path, "utf8");
  if (Buffer.byteLength(raw) > 512 * 1024) throw new Error("runner child config exceeds 512 KiB");
  const expectedHash = process.env.PI_SWE_RUN_CONFIG_HASH;
  const actualHash = `sha256:${createHash("sha256").update(raw).digest("hex")}`;
  if (!expectedHash || expectedHash !== actualHash) throw new Error("runner child config hash mismatch");
  const config = JSON.parse(raw) as ChildRunConfig;
  if (config.version !== RUNNER_PROTOCOL_VERSION || typeof config.cwd !== "string" || !Array.isArray(config.tools)) throw new Error("invalid runner child config");
  return config;
}

function normalizedPath(value: string): string {
  const path = value.replace(/^\.\//, "");
  if (!path || isAbsolute(path) || path.includes("\\") || path.includes("\0") || path.split("/").some((part) => part === ".." || part === "")) throw new Error("path must be a normalized repository-relative path");
  return path;
}

function inside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function scopedPath(config: ChildRunConfig, value: string, operation: "read" | "write"): { relativePath: string; absolutePath: string } {
  const relativePath = normalizedPath(value);
  const scopes = operation === "read" ? config.readScope : config.writeScope;
  if (!scopes.some((scope) => scopeAllowsPath(scope, relativePath))) throw new Error(`${operation} path is outside the role capability scope`);
  const root = realpathSync(config.cwd);
  const absolutePath = resolve(root, relativePath);
  if (!inside(root, absolutePath)) throw new Error("path escapes the role workspace");
  let existing = absolutePath;
  for (;;) {
    try {
      const actual = realpathSync(existing);
      if (!inside(root, actual)) throw new Error("path resolves outside the role workspace");
      break;
    } catch (error) {
      if (error instanceof Error && /outside the role workspace/.test(error.message)) throw error;
      const parent = resolve(existing, "..");
      if (parent === existing) throw new Error("path has no existing workspace ancestor");
      existing = parent;
    }
  }
  return { relativePath, absolutePath };
}

function textResult(text: string, details: unknown = null) {
  return { content: [{ type: "text" as const, text }], details };
}

export default function runnerChildExtension(pi: ExtensionAPI): void {
  const config = loadConfig();

  pi.registerTool(defineTool({
    name: "runner_read",
    label: "Scoped read",
    description: "Read a repository file allowed by this role's explicit read scope.",
    parameters: Type.Object({
      path: Type.String({ maxLength: 512 }),
      offset: Type.Optional(Type.Integer({ minimum: 1, maximum: 1_000_000 })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 2_000 })),
    }),
    async execute(_toolCallId, params) {
      const target = scopedPath(config, params.path, "read");
      const stat = lstatSync(target.absolutePath);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("runner_read requires a regular non-symlink file");
      if (stat.size > MAX_FILE_BYTES) throw new Error(`runner_read file exceeds ${MAX_FILE_BYTES} bytes`);
      const lines = readFileSync(target.absolutePath, "utf8").split("\n");
      const offset = params.offset ?? 1;
      const limit = params.limit ?? 500;
      return textResult(lines.slice(offset - 1, offset - 1 + limit).join("\n"), { path: target.relativePath, offset, totalLines: lines.length });
    },
  }));

  if (config.role === "implementer") {
    pi.registerTool(defineTool({
      name: "runner_edit",
      label: "Scoped edit",
      description: "Replace one unique text block in a file allowed by the task write scope.",
      parameters: Type.Object({
        path: Type.String({ maxLength: 512 }),
        oldText: Type.String({ minLength: 1, maxLength: MAX_FILE_BYTES }),
        newText: Type.String({ maxLength: MAX_FILE_BYTES }),
      }),
      async execute(_toolCallId, params) {
        const target = scopedPath(config, params.path, "write");
        const stat = lstatSync(target.absolutePath);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_FILE_BYTES) throw new Error("runner_edit requires a bounded regular non-symlink file");
        const current = readFileSync(target.absolutePath, "utf8");
        const first = current.indexOf(params.oldText);
        if (first < 0) throw new Error("oldText was not found");
        if (current.indexOf(params.oldText, first + params.oldText.length) >= 0) throw new Error("oldText is not unique");
        const next = `${current.slice(0, first)}${params.newText}${current.slice(first + params.oldText.length)}`;
        if (Buffer.byteLength(next) > MAX_FILE_BYTES) throw new Error("edited file exceeds the runner file limit");
        writeFileSync(target.absolutePath, next);
        return textResult(`updated ${target.relativePath}`, { path: target.relativePath });
      },
    }));

    pi.registerTool(defineTool({
      name: "runner_write",
      label: "Scoped write",
      description: "Write a bounded file allowed by the task write scope.",
      parameters: Type.Object({
        path: Type.String({ maxLength: 512 }),
        content: Type.String({ maxLength: MAX_FILE_BYTES }),
      }),
      async execute(_toolCallId, params) {
        const target = scopedPath(config, params.path, "write");
        mkdirSync(resolve(target.absolutePath, ".."), { recursive: true });
        try {
          if (lstatSync(target.absolutePath).isSymbolicLink()) throw new Error("runner_write refuses symlink targets");
        } catch (error) {
          if (error instanceof Error && !/ENOENT/.test(String((error as NodeJS.ErrnoException).code))) throw error;
        }
        writeFileSync(target.absolutePath, params.content);
        return textResult(`wrote ${target.relativePath}`, { path: target.relativePath });
      },
    }));

    pi.registerTool(defineTool({
      name: "runner_shell",
      label: "Trusted workspace shell",
      description: "Run trusted local code in the isolated task workspace. This is not an OS sandbox.",
      parameters: Type.Object({
        command: Type.String({ minLength: 1, maxLength: 8_192 }),
        timeoutMs: Type.Optional(Type.Integer({ minimum: 1, maximum: 120_000 })),
      }),
      async execute(_toolCallId, params) {
        const result = spawnSync("/bin/sh", ["-lc", params.command], {
          cwd: config.cwd,
          env: process.env,
          encoding: "utf8",
          timeout: params.timeoutMs ?? 30_000,
          maxBuffer: MAX_SHELL_OUTPUT_BYTES,
        });
        const stdout = result.stdout ?? "";
        const stderr = result.stderr ?? "";
        const text = `${stdout}${stderr ? `${stdout ? "\n" : ""}${stderr}` : ""}`.slice(0, MAX_SHELL_OUTPUT_BYTES);
        return { ...textResult(text || `(exit ${result.status ?? 1})`, { exitCode: result.status ?? 1 }), isError: result.status !== 0 };
      },
    }));
  }

  pi.registerTool(defineTool({
    name: "runner_report",
    label: "Submit role report",
    description: "Submit the bounded role outcome and terminate this child. This is the only successful completion path.",
    promptSnippet: "Call runner_report exactly once as the final action.",
    promptGuidelines: [
      "Use runner_report as the final action; ordinary text is not a report.",
      "Use needs-input with concrete questions when a parent decision is required.",
      "Child-run tests are advisory and do not replace parent protected verification.",
    ],
    parameters: Type.Object({
      outcome: Type.Union([
        Type.Literal("approved"), Type.Literal("changes-requested"), Type.Literal("needs-input"),
        Type.Literal("completed"), Type.Literal("no-change"), Type.Literal("failed"),
      ]),
      summary: Type.String({ minLength: 1, maxLength: 2_048 }),
      rationale: Type.Optional(Type.String({ minLength: 1, maxLength: 2_048 })),
      changedPaths: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 512 }), { maxItems: 128 })),
      findings: Type.Optional(Type.Array(Type.Object({
        severity: Type.Union([Type.Literal("blocking"), Type.Literal("warning")]),
        summary: Type.String({ minLength: 1, maxLength: 1_024 }),
        evidence: Type.String({ minLength: 1, maxLength: 2_048 }),
      }), { maxItems: 64 })),
      questions: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 2_048 }), { maxItems: 32 })),
    }),
    async execute(_toolCallId, params) {
      return { ...textResult("role report accepted", params), terminate: true };
    },
  }));
}
