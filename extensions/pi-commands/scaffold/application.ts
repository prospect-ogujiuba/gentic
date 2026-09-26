import { existsSync, lstatSync, mkdirSync, realpathSync, renameSync, rmSync, rmdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { assertSafeTarget } from "./planning.ts";
import type { ScaffoldPreview, ScaffoldApplyResult, ScaffoldOptions } from "./types.ts";

function absoluteTarget(preview: ScaffoldPreview, target: string): string {
  assertSafeTarget(target);
  const result = resolve(preview.projectRoot, target);
  const lexical = relative(preview.projectRoot, result);
  if (lexical.startsWith("..") || isAbsolute(lexical)) throw new Error(`Scaffold target escapes project root: ${target}`);
  return result;
}

function assertSafeTargetAncestors(preview: ScaffoldPreview, target: string): string {
  const result = absoluteTarget(preview, target);
  const root = realpathSync(preview.projectRoot);
  let current = preview.projectRoot;
  for (const segment of relative(preview.projectRoot, dirname(result)).split(sep).filter(Boolean)) {
    current = join(current, segment);
    if (!existsSync(current)) break;
    const stat = lstatSync(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`Scaffold target has an unsafe symlink or non-directory ancestor: ${target}`);
    const resolved = realpathSync(current);
    const containment = relative(root, resolved);
    if (containment.startsWith("..") || isAbsolute(containment)) throw new Error(`Scaffold target escapes project root: ${target}`);
  }
  return result;
}
function removeEmptyParents(path: string, root: string): void {
  let current = dirname(path);
  while (current !== root && relative(root, current) && !relative(root, current).startsWith("..")) {
    try { rmdirSync(current); } catch { break; }
    current = dirname(current);
  }
}

export function applyScaffoldPreview(preview: ScaffoldPreview, options?: ScaffoldOptions): ScaffoldApplyResult {
  const targets = new Set<string>();
  for (const file of preview.files) {
    const target = assertSafeTargetAncestors(preview, file.target);
    if (targets.has(target)) throw new Error(`Duplicate scaffold target: ${file.target}`);
    targets.add(target);
    if (existsSync(target)) throw new Error(`Refusing to overwrite existing scaffold target: ${file.target}`);
  }

  const staged = new Map<string, string>();
  const committed: string[] = [];
  let step = 0;
  const checkpoint = (label: string) => {
    step += 1;
    if (options?.failAtStep === step) throw new Error(`Injected scaffold failure at step ${step}: ${label}`);
  };

  try {
    for (const file of preview.files) {
      const target = assertSafeTargetAncestors(preview, file.target);
      const temporary = `${target}.gentic-scaffold-${process.pid}-${step + 1}.tmp`;
      checkpoint(`stage ${file.target}`);
      mkdirSync(dirname(target), { recursive: true });
      assertSafeTargetAncestors(preview, file.target);
      writeFileSync(temporary, file.renderedContent, { flag: "wx" });
      staged.set(target, temporary);
    }
    for (const file of preview.files) {
      const target = assertSafeTargetAncestors(preview, file.target);
      checkpoint(`commit ${file.target}`);
      if (existsSync(target)) throw new Error(`Refusing to overwrite existing scaffold target: ${file.target}`);
      renameSync(staged.get(target)!, target);
      staged.delete(target);
      committed.push(target);
    }
  } catch (error) {
    for (const [target, temporary] of staged) {
      try { assertSafeTargetAncestors(preview, relative(preview.projectRoot, target)); rmSync(temporary, { force: true }); } catch { /* Never follow a replaced ancestor during rollback. */ }
    }
    for (const target of committed.reverse()) {
      try { assertSafeTargetAncestors(preview, relative(preview.projectRoot, target)); rmSync(target, { force: true }); } catch { /* Never follow a replaced ancestor during rollback. */ }
    }
    for (const file of [...preview.files].reverse()) {
      try { removeEmptyParents(assertSafeTargetAncestors(preview, file.target), preview.projectRoot); } catch { /* Unsafe ancestors are left untouched. */ }
    }
    throw new Error(`Scaffold transaction rolled back: ${error instanceof Error ? error.message : String(error)}`);
  }

  return { ...preview, createdPaths: preview.files.map((file) => file.target), updatedPaths: [] };
}

