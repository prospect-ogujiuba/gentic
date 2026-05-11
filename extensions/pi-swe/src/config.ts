export type PiSweMode = "off" | "advisory" | "enforced";

export type PiSweConfig = {
  $schema?: string;
  version?: number;
  enabled?: boolean;
  mode?: PiSweMode;
  stages?: Record<string, Record<string, unknown>>;
};

export const DEFAULT_PI_SWE_CONFIG: Readonly<Required<Omit<PiSweConfig, "$schema">>> = {
  version: 1,
  enabled: true,
  mode: "advisory",
  stages: {},
};
