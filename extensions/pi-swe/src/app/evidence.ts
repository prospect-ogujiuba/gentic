import { createVerificationEvidence, type VerificationEvidence, type VerificationScope } from "../domain/evidence.ts";

export * from "../domain/evidence.ts";

export type SweEvidenceClock = () => string;

export type SweEvidenceServiceDependencies = {
  now?: SweEvidenceClock;
};

export type CommandVerificationEvidenceInput = {
  command: string;
  exitCode: number;
  scope: VerificationScope;
  timestamp?: string;
};

export type NoteVerificationEvidenceInput = {
  note: string;
  scope: VerificationScope;
  timestamp?: string;
};

export type SweEvidenceService = {
  createCommandEvidence(input: CommandVerificationEvidenceInput): VerificationEvidence;
  createNoteEvidence(input: NoteVerificationEvidenceInput): VerificationEvidence;
};

export function createSweEvidenceService(dependencies: SweEvidenceServiceDependencies = {}): SweEvidenceService {
  const now = dependencies.now ?? (() => new Date(0).toISOString());

  return {
    createCommandEvidence(input) {
      return createVerificationEvidence({ kind: "command", command: input.command, exitCode: input.exitCode, scope: input.scope, timestamp: input.timestamp ?? now() });
    },
    createNoteEvidence(input) {
      return createVerificationEvidence({ kind: "note", note: input.note, scope: input.scope, timestamp: input.timestamp ?? now() });
    },
  };
}
