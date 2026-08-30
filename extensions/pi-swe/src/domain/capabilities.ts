export type SweCanonicalInitiativeLink = {
  topic: string;
  contractId?: string;
  contractPath?: string;
  planRevision?: number;
  dependencies?: string[];
};

export type SweExternalTodo = {
  id?: string;
  title?: string;
  status?: string;
  acceptanceCriteria?: string[];
  definitionOfDone?: string[];
  canonicalInitiative?: SweCanonicalInitiativeLink;
};

export type SweTodoScope = Record<string, unknown>;
export type SweTodoEvidence = Record<string, unknown>;

export type SweCapabilityWarning = {
  source: string;
  message: string;
};

export type SweExternalCapabilities = {
  getActiveTodo?: () => SweExternalTodo | undefined;
  getTodoScope?: () => SweTodoScope | undefined;
  getTodoEvidence?: () => SweTodoEvidence[];
  listDetectedExtensions?: () => string[];
};

export type SweCapabilityAdapter = SweExternalCapabilities & {
  getWarnings: () => SweCapabilityWarning[];
};
