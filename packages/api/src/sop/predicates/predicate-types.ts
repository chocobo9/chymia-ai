// Shared predicate evaluation outcome for M12 trace evaluation.

export type PredicateEvalOutcome =
  | { status: 'pass' }
  | { status: 'violation'; message: string }
  | { status: 'skipped'; reason: string };

/** Trace context fed into predicate evaluators. Source: architecture §5.6 SopTraceInput (extended with commands/git/env). */
export interface SopTraceContext {
  commands: readonly string[];
  authorId?: string;
  reviewerId?: string;
  gitAhead?: number;
  gitBehind?: number;
  env?: Readonly<Record<string, string | undefined>>;
}
