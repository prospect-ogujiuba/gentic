export type ContextSourceKind =
  | "system"
  | "user"
  | "project"
  | "extension"
  | "session"
  | "tool"
  | "artifact"
  | "discovered"
  | "compaction"
  | "unknown";

export type TokenConfidence = "exact" | "estimated" | "unknown";

export type RedactionMetadata = {
  redacted: boolean;
  reason?: string;
  originalByteCount?: number;
  originalTokenCount?: number;
};

export type ContextSourceMetadata = {
  displayPath?: string;
  packageName?: string;
  resourceType?: string;
  scope?: string;
  source?: string;
  origin?: string;
  hash?: string;
  hashAlgorithm?: "sha256";
  contentStored?: boolean;
  status?: "present" | "absent" | "unknown" | "error";
  warning?: string;
  toolName?: string;
  operation?: string;
  eventType?: string;
  executionStatus?: "started" | "success" | "error" | "unknown";
  pathCount?: number;
  paths?: string[];
  sizeEstimate?: number;
  argumentByteCount?: number;
  resultByteCount?: number;
  detailByteCount?: number;
  warningCount?: number;
  errorCount?: number;
  compactionCount?: number;
  beforeTokens?: number;
  afterTokens?: number;
  deltaTokens?: number;
  savedTokens?: number;
};

export type ContextLedgerEntry = {
  id: string;
  kind: ContextSourceKind;
  label: string;
  origin?: string;
  byteCount: number;
  tokenCount?: number;
  tokenConfidence: TokenConfidence;
  firstSeenAt: string;
  lastSeenAt: string;
  turnIds: string[];
  messageIds: string[];
  toolCallIds: string[];
  redaction?: RedactionMetadata;
  sourceMetadata?: ContextSourceMetadata;
};

export type ContextLedgerEntryInput = {
  id: string;
  kind?: ContextSourceKind;
  label?: string;
  origin?: string;
  content?: string;
  byteCount?: number;
  tokenCount?: number;
  tokenConfidence?: TokenConfidence;
  seenAt?: string;
  firstSeenAt?: string;
  lastSeenAt?: string;
  turnId?: string;
  turnIds?: string[];
  messageId?: string;
  messageIds?: string[];
  toolCallId?: string;
  toolCallIds?: string[];
  redaction?: RedactionMetadata;
  sourceMetadata?: ContextSourceMetadata;
};

export type ContextGroup = {
  kind: ContextSourceKind;
  label: string;
  entries: ContextLedgerEntry[];
  byteCount: number;
  tokenCount?: number;
  tokenConfidence: TokenConfidence;
};

export type ContextTotals = {
  byteCount: number;
  tokenCount?: number;
  exactTokenCount: number;
  estimatedTokenCount: number;
  unknownTokenEntries: number;
  tokenConfidence: TokenConfidence;
};

export type ContextWindow = {
  totalTokens?: number;
  usedTokens?: number;
  remainingTokens?: number;
  tokenConfidence: TokenConfidence;
};

export type CompactionStats = {
  beforeTokens?: number;
  afterTokens?: number;
  deltaTokens?: number;
  savedTokens?: number;
  tokenConfidence: TokenConfidence;
};

export type ContextSnapshot = {
  capturedAt: string;
  totals: ContextTotals;
  remaining: ContextWindow;
  contextWindowTokens?: number;
  compaction?: CompactionStats;
  groups: ContextGroup[];
  warnings: string[];
};
