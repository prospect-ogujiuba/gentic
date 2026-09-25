import { spawn } from "node:child_process";

export type BoundedProcessResult = {
  stdout?: string;
  stderr?: string;
  code?: number;
  killed?: boolean;
  stdoutTruncated?: boolean;
  stderrTruncated?: boolean;
};

export const MAX_CAPTURE_BYTES = 256 * 1024;

/** Spawn without a shell while retaining at most limit bytes from each output stream. */
export async function execBounded(
  command: string,
  args: string[],
  cwd: string,
  signal?: AbortSignal,
  timeout = 10_000,
  limit = MAX_CAPTURE_BYTES,
): Promise<BoundedProcessResult> {
  signal?.throwIfAborted();
  return new Promise<BoundedProcessResult>((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"], windowsHide: true, detached: process.platform !== "win32" });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let timedOut = false;
    let aborted = false;
    let settled = false;
    let escalationTimer: NodeJS.Timeout | undefined;

    const collect = (chunks: Buffer[], chunk: Buffer | string, stream: "stdout" | "stderr") => {
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const used = stream === "stdout" ? stdoutBytes : stderrBytes;
      const remaining = Math.max(0, limit - used);
      if (value.length > remaining) {
        if (stream === "stdout") stdoutTruncated = true;
        else stderrTruncated = true;
      }
      if (remaining > 0) chunks.push(value.subarray(0, remaining));
      if (stream === "stdout") stdoutBytes += Math.min(value.length, remaining);
      else stderrBytes += Math.min(value.length, remaining);
    };
    child.stdout?.on("data", (chunk) => collect(stdout, chunk, "stdout"));
    child.stderr?.on("data", (chunk) => collect(stderr, chunk, "stderr"));

    const cleanup = () => {
      clearTimeout(timer);
      if (escalationTimer) clearTimeout(escalationTimer);
      signal?.removeEventListener("abort", onAbort);
    };
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (aborted) {
        reject(signal?.reason instanceof Error ? signal.reason : new DOMException("The operation was aborted", "AbortError"));
        return;
      }
      resolve({
        stdout: Buffer.concat(stdout, stdoutBytes).toString("utf8"),
        stderr: Buffer.concat(stderr, stderrBytes).toString("utf8"),
        code: code ?? (timedOut ? 143 : 1),
        killed: timedOut,
        stdoutTruncated,
        stderrTruncated,
      });
    };
    const terminate = () => {
      const pid = child.pid;
      try {
        if (pid !== undefined && process.platform !== "win32") process.kill(-pid, "SIGTERM");
        else child.kill("SIGTERM");
      } catch { /* The process group already exited. */ }
      escalationTimer = setTimeout(() => {
        try {
          if (pid !== undefined && process.platform !== "win32") process.kill(-pid, "SIGKILL");
          else child.kill("SIGKILL");
        } catch { /* The process group already exited. */ }
      }, 100);
      escalationTimer.unref?.();
    };
    const onAbort = () => { aborted = true; terminate(); };
    const timer = setTimeout(() => { timedOut = true; terminate(); }, timeout);
    timer.unref?.();
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
    child.once("error", (error) => {
      if (settled) return;
      if (aborted) finish(null);
      else {
        collect(stderr, error.message, "stderr");
        finish(1);
      }
    });
    child.once("close", finish);
  });
}
