import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { auditArtifacts } from "../domain/inventory.ts";
import { isNoopMigrationPlan } from "../domain/plan.ts";
import { planMigration } from "../app/service.ts";
import { applyMigration, finalizeMigration, recoverMigration, rollbackMigration } from "../app/transaction.ts";

const ACTIONS = ["apply", "audit", "finalize", "plan", "recover", "rollback"] as const;
const USAGE = "Usage: /artifacts <audit|plan|apply <plan-path>|recover <journal-path>|rollback <ledger-path>|finalize <ledger-path>>";
const MAX_DETAILS = 8;

export function registerArtifactsCommand(pi: ExtensionAPI): void {
  pi.registerCommand("artifacts", {
    description: "Audit, plan, apply, recover, roll back, or finalize deterministic model-artifact migration",
    getArgumentCompletions(prefix: string) {
      if (/\s/.test(prefix.trim())) return null;
      const normalized = prefix.trim();
      const matches = ACTIONS.filter((action) => action.startsWith(normalized)).map((action) => ({ value: action, label: action }));
      return matches.length ? matches : null;
    },
    handler: async (args, ctx) => {
      const tokens = args.trim().split(/\s+/).filter(Boolean);
      const action = tokens[0];
      if (!isAction(action) || (action === "audit" || action === "plan" ? tokens.length !== 1 : tokens.length !== 2)) {
        ctx.ui.notify(USAGE, "warning");
        return;
      }
      try {
        if (action === "audit") {
          const inventory = auditArtifacts({ cwd: ctx.cwd });
          ctx.ui.notify(formatAudit(inventory), inventory.diagnostics.length ? "warning" : "info");
          return;
        }
        if (action === "plan") {
          const result = planMigration({ cwd: ctx.cwd });
          const noWork = isNoopMigrationPlan(result.plan);
          ctx.ui.notify([
            "model-artifact migration plan",
            `status: ${result.plan.eligible ? "planned" : noWork ? "up-to-date" : "blocked"}`,
            `eligible: ${result.plan.eligible ? "yes" : noWork ? "not-applicable" : "no"}`,
            `authority-units: ${result.plan.authorityUnits.length}`,
            `moves: ${result.plan.moves.length}`,
            `rewrites: ${result.plan.rewrites.length}`,
            `affected-bytes: ${result.plan.bounds.affectedBytes}`,
            `staging-bytes: ${result.plan.bounds.stagingBytes}`,
            `rollback-bytes: ${result.plan.bounds.rollbackBytes}`,
            `duration-ms: ${result.plan.durationMs}`,
            `blockers: ${noWork ? 0 : result.plan.blockers.length}`,
            `claim: none`,
            `plan: ${result.planPath}`,
            `report: ${result.reportPath}`,
            `fingerprint: ${result.plan.fingerprint}`,
            result.plan.eligible
              ? `next: review the exact fingerprint, then /artifacts apply ${result.planPath}`
              : noWork
                ? "next: no migration needed"
                : "next: resolve blockers and run /artifacts plan again",
          ].join("\n"), result.plan.eligible || noWork ? "info" : "warning");
          return;
        }
        if (action === "apply") {
          const result = applyMigration({ cwd: ctx.cwd, planPath: tokens[1]! });
          ctx.ui.notify([
            "model-artifact migration apply",
            `status: ${result.status}`,
            `moved: ${result.moved}`,
            `ledger: ${result.ledgerPath}`,
            `rollback: /artifacts rollback ${result.ledgerPath}`,
            `finalize: /artifacts finalize ${result.ledgerPath}`,
          ].join("\n"), "info");
          return;
        }
        if (action === "recover") {
          const result = recoverMigration({ cwd: ctx.cwd, journalPath: tokens[1]! });
          ctx.ui.notify([
            "model-artifact migration recovery",
            `status: ${result.status}`,
            `restored: ${result.restored}`,
            `journal: ${result.journalPath}`,
          ].join("\n"), "info");
          return;
        }
        if (action === "rollback") {
          const result = rollbackMigration({ cwd: ctx.cwd, ledgerPath: tokens[1]! });
          ctx.ui.notify([
            "model-artifact migration rollback",
            `status: ${result.status}`,
            `restored: ${result.restored}`,
            `ledger: ${result.ledgerPath}`,
          ].join("\n"), "info");
          return;
        }
        const result = finalizeMigration({ cwd: ctx.cwd, ledgerPath: tokens[1]! });
        ctx.ui.notify([
          "model-artifact migration finalize",
          `status: ${result.status}`,
          `removed-payloads: ${result.removedPayloads}`,
          `ledger: ${result.ledgerPath}`,
          `report: ${result.reportPath}`,
          "rollback: permanently unavailable",
        ].join("\n"), "warning");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const status = /already exists|claim|mismatch|changed|conflict|rolled back/i.test(message) ? "conflict" : "blocked";
        ctx.ui.notify(`model-artifact migration blocked\nstatus: ${status}\n${message}`, "error");
      }
    },
  });
}

function isAction(value: string | undefined): value is (typeof ACTIONS)[number] {
  return typeof value === "string" && (ACTIONS as readonly string[]).includes(value);
}

function formatAudit(inventory: ReturnType<typeof auditArtifacts>): string {
  const actionable = inventory.entries.filter((entry) => entry.classification === "legacy-movable" || entry.classification === "ambiguous" || entry.classification === "invalid" || entry.reasons.some((reason) => reason.startsWith("inbound-reference:")));
  const details = actionable.slice(0, MAX_DETAILS).map((entry) => `- ${entry.classification}: ${entry.source} (${entry.reasons.join(", ")})`);
  return [
    "model-artifact migration audit",
    `status: ${inventory.diagnostics.length ? "blocked" : "pass"}`,
    `root: ${inventory.projectRoot}`,
    `files: ${inventory.fileCount}`,
    `bytes: ${inventory.candidateBytes}`,
    `canonical-valid: ${inventory.totals["canonical-valid"]}`,
    `legacy-movable: ${inventory.totals["legacy-movable"]}`,
    `protected: ${inventory.totals.protected}`,
    `ambiguous: ${inventory.totals.ambiguous}`,
    `invalid: ${inventory.totals.invalid}`,
    ...details,
    ...(actionable.length > details.length ? [`- … ${actionable.length - details.length} additional entries omitted`] : []),
    `claim: ${inventory.diagnostics.some((item) => /active migration claim/.test(item)) ? "active-blocker" : "none"}`,
    `next: ${inventory.diagnostics.length ? "resolve blockers, recovery state, or mixed authority before planning" : inventory.totals["legacy-movable"] > 0 ? "/artifacts plan" : "add explicit mappings for ambiguous legacy Markdown files, then audit again"}`,
  ].join("\n");
}
