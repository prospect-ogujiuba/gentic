import { spawn } from "node:child_process";
import process from "node:process";
import type { CommandResult } from "./types.js";
import type { CommandPolicy } from "./policy.js";
import { truncate } from "./util.js";

export interface ProgramOptions { cwd: string; timeoutMs?: number; signal?: AbortSignal; env?: NodeJS.ProcessEnv; maxOutput?: number }

async function terminate(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.exitCode !== null) return;
  try {
    if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGTERM"); else child.kill("SIGTERM");
  } catch { child.kill("SIGTERM"); }
  await new Promise((resolve) => setTimeout(resolve, 800));
  if (child.exitCode === null) {
    try { if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL"); else child.kill("SIGKILL"); } catch { child.kill("SIGKILL"); }
  }
}

export async function runProgram(program: string, args: string[], options: ProgramOptions): Promise<CommandResult> {
  const started = Date.now(); let stdout = ""; let stderr = ""; let timedOut = false;
  const child = spawn(program, args, {
    cwd: options.cwd, env: { ...process.env, ...options.env }, windowsHide: true,
    detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.setEncoding("utf8"); child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => { stdout += chunk; if (stdout.length > (options.maxOutput ?? 2_000_000)) stdout = truncate(stdout, options.maxOutput ?? 2_000_000); });
  child.stderr?.on("data", (chunk: string) => { stderr += chunk; if (stderr.length > (options.maxOutput ?? 2_000_000)) stderr = truncate(stderr, options.maxOutput ?? 2_000_000); });
  const onAbort = (): void => { timedOut = true; void terminate(child); };
  options.signal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => { timedOut = true; void terminate(child); }, options.timeoutMs ?? 120_000);
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject); child.once("close", resolve);
    });
    return { command: [program, ...args].join(" "), code, stdout, stderr, durationMs: Date.now() - started, timedOut, blocked: false };
  } finally { clearTimeout(timer); options.signal?.removeEventListener("abort", onAbort); }
}

export async function runCommand(command: string, options: ProgramOptions & { policy?: CommandPolicy }): Promise<CommandResult> {
  const decision = options.policy?.checkCommand(command);
  if (decision && !decision.allowed) return { command, code: null, stdout: "", stderr: "", durationMs: 0, timedOut: false, blocked: true, blockReason: decision.reason };
  return process.platform === "win32"
    ? runProgram("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command], options)
    : runProgram(process.env.SHELL || "/bin/sh", ["-lc", command], options);
}
