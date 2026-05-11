export type PiSwePolicyResult = {
  allowed: true;
  warnings: [];
};

export function noPolicyChecks(): PiSwePolicyResult {
  return { allowed: true, warnings: [] };
}
