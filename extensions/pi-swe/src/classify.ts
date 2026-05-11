export type PiSweClassification = {
  stage?: string;
  confidence: number;
};

export function unclassified(): PiSweClassification {
  return { confidence: 0 };
}
