export type ScaffoldKind =
  | "extension"
  | "tool"
  | "command"
  | "event"
  | "shortcut"
  | "flag"
  | "provider"
  | "widget"
  | "footer"
  | "overlay"
  | "skill"
  | "prompt"
  | "theme"
  | "primitive";
export type ScaffoldVariant = "minimal" | "simple" | "layered" | "directory";
export type ScaffoldMode = "dry-run" | "apply";

export type TemplateSpec = { template: string; target: string; description: string };

export type ScaffoldPreviewFile = TemplateSpec & { renderedContent: string; summary: string };
export type ScaffoldPreview = {
  kind: ScaffoldKind;
  name: string;
  mode: ScaffoldMode;
  variant?: ScaffoldVariant;
  projectRoot: string;
  files: ScaffoldPreviewFile[];
};
export type ScaffoldApplyResult = ScaffoldPreview & { createdPaths: string[]; updatedPaths: string[] };
export type ScaffoldOptions = { projectRoot?: string; failAtStep?: number };

export type ScaffoldPlan = Omit<ScaffoldPreview, "files"> & { files: TemplateSpec[] };
