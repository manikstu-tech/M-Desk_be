import { buildDemoState } from "./finance-demo-data";
import type { FinanceState } from "./finance-types";

// The Finance data-access seam. Screens and the service layer only talk to
// FinanceRepository; today the one implementation is the in-memory sample-data
// repository below. Production swaps in a repository backed by Prisma tables (or the
// accounting system's API) that implements the same two calls — see
// docs/FINANCE-MODULE.md "Production integration points".

export interface FinanceRepository {
  /** "demo" while the data is sample data; screens label themselves from this. */
  readonly mode: "demo" | "live";
  /** A private copy of the current records — callers may not mutate shared state. */
  snapshot(): FinanceState;
  /**
   * Apply a change atomically: `change` runs on a copy, then `commit` (the audit write)
   * must succeed before the copy replaces the current records. Calls are serialised,
   * so two clicks on "Mark as paid" cannot both pass the status check.
   */
  mutate<T>(change: (draft: FinanceState) => T, commit: (result: T) => Promise<void>): Promise<T>;
  /** Demo only: rebuild the sample data. */
  reset(): void;
}

class DemoFinanceRepository implements FinanceRepository {
  readonly mode = "demo" as const;
  private state: FinanceState = buildDemoState();
  private queue: Promise<unknown> = Promise.resolve();

  snapshot(): FinanceState {
    return structuredClone(this.state);
  }

  mutate<T>(change: (draft: FinanceState) => T, commit: (result: T) => Promise<void>): Promise<T> {
    const run = this.queue.then(async () => {
      const draft = structuredClone(this.state);
      const result = change(draft);
      await commit(result);
      this.state = draft;
      return result;
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  reset(): void {
    this.state = buildDemoState();
  }
}

// Kept on globalThis so dev-server reloads don't wipe in-progress demo work (same idea as lib/db.ts).
const g = globalThis as unknown as { financeRepo?: FinanceRepository };

export function financeRepo(): FinanceRepository {
  g.financeRepo ??= new DemoFinanceRepository();
  return g.financeRepo;
}
