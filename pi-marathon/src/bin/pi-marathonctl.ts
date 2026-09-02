#!/usr/bin/env node
import process from "node:process";
import { executeControl, parseControl } from "../core/control.js";
import { resolveRuntimeModuleUrls } from "../core/agent-runner.js";
import { errorMessage } from "../core/util.js";
try{const parsed=parseControl(process.argv.slice(2).join(" "));const result=await executeControl({projectCwd:process.cwd(),runtimeModules:resolveRuntimeModuleUrls()},parsed);console.log(result.text);}catch(error){console.error(errorMessage(error));process.exitCode=1;}
