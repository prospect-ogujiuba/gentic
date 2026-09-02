import { access, readFile } from "node:fs/promises";
import path from "node:path";
import type { CommandResult, MarathonConfig, TaskRecord, WorkspaceRecord } from "./types.js";
import { CommandPolicy } from "./policy.js";
import { runCommand } from "./process.js";
import { uniqueStrings } from "./util.js";

async function exists(file:string):Promise<boolean>{try{await access(file);return true;}catch{return false;}}
async function detectedCommands(cwd:string):Promise<string[]>{
  const commands:string[]=[];
  const packageFile=path.join(cwd,"package.json");
  if(await exists(packageFile)){
    try{
      const pkg=JSON.parse(await readFile(packageFile,"utf8")); const scripts=pkg.scripts??{};
      const runner=await exists(path.join(cwd,"pnpm-lock.yaml"))?"pnpm":await exists(path.join(cwd,"yarn.lock"))?"yarn":"npm run";
      for(const name of ["check","typecheck","lint","test","build"]){
        if(!scripts[name])continue;
        commands.push(runner==="yarn"?`yarn ${name}`:runner==="pnpm"?`pnpm ${name}`:`npm run ${name}`);
      }
    }catch{}
  }
  if(await exists(path.join(cwd,"go.mod")))commands.push("go test ./...");
  if(await exists(path.join(cwd,"Cargo.toml")))commands.push("cargo test --all-targets");
  if(await exists(path.join(cwd,"pyproject.toml"))||await exists(path.join(cwd,"pytest.ini")))commands.push("python -m pytest");
  if(await exists(path.join(cwd,"pom.xml")))commands.push("mvn test");
  if(await exists(path.join(cwd,"gradlew")))commands.push(process.platform==="win32"?"gradlew.bat test":"./gradlew test");
  if(await exists(path.join(cwd,"Makefile")))commands.push("make test");
  return uniqueStrings(commands,12);
}

export async function runVerificationCommands(input:{workspace:WorkspaceRecord;config:MarathonConfig;task?:TaskRecord;finalAudit?:boolean;signal?:AbortSignal}):Promise<CommandResult[]>{
  let commands=uniqueStrings([...(input.config.verification.commands??[]),...(input.task?.verification.commands??[])],50);
  if(input.finalAudit&&commands.length===0)commands=await detectedCommands(input.workspace.cwd);
  const policy=new CommandPolicy(input.workspace.root,input.config.safety); const results:CommandResult[]=[];
  for(const command of commands){
    const result=await runCommand(command,{cwd:input.workspace.cwd,timeoutMs:input.config.verification.commandTimeoutMs,signal:input.signal,policy});
    results.push(result); if(result.code!==0||result.blocked||result.timedOut)break;
  }
  return results;
}
export const deterministicVerificationPassed=(results:CommandResult[]):boolean=>results.every((result)=>!result.blocked&&!result.timedOut&&result.code===0);
export function deterministicFailureSummary(results:CommandResult[]):string{
  const failed=results.find((result)=>result.blocked||result.timedOut||result.code!==0);
  if(!failed)return "No deterministic verification failure.";
  return [`Command: ${failed.command}`,`Exit: ${failed.code??"none"}`,failed.blocked?`Blocked: ${failed.blockReason??"policy"}`:"",failed.timedOut?"Timed out":"",failed.stdout?`STDOUT:\n${failed.stdout}`:"",failed.stderr?`STDERR:\n${failed.stderr}`:""].filter(Boolean).join("\n");
}
