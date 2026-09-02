import type { MarathonConfig } from "./types.js";
export interface CreateRunRequest { goal:string; config?:Partial<MarathonConfig> }
export interface SteeringRequest { message:string }
export interface BudgetPatchRequest { maxTasks?:number; maxAgentCalls?:number; maxRunMinutes?:number; maxCostUsd?:number|null; maxFinalAuditCycles?:number }
