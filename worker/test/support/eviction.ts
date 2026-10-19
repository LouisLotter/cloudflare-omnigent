/**
 * Eviction helpers for Workers-runtime tests (workerd only: imports "cloudflare:test").
 *
 * The definition of done asks for eviction after each persisted transition: a Durable Object must
 * behave the same when its in-memory state is lost between any two calls. Write a test as a list
 * of steps and let `stepsWithEviction` evict the object between them:
 *
 *   const [first, second] = await stepsWithEviction(stub, [
 *     (s) => s.applyChange(change),     // persists, then the instance is evicted
 *     (s) => s.status(),                // runs on a fresh instance built from storage
 *   ]);
 *
 * Steps run in order, one at a time. Each step must call the object (directly or through
 * `runInDurableObject`), because eviction rejects when the object is not running. A later step can
 * use an earlier step's result through a variable in the enclosing test.
 *
 * For an after-each style, so that every test starts on fresh instances, evict everything after
 * each test with the plugin's own helper, which skips objects that are not running:
 *
 *   afterEach(() => evictAllDurableObjects());   // from "cloudflare:test"
 *
 * That complements per-step eviction but does not replace it: it checks recovery only at test
 * boundaries. With @cloudflare/vitest-plugin 1.4.0, Durable Object storage is not reset between
 * the tests in a file (test/workers/eviction.test.ts checks this), so give each test its own
 * object names.
 */
import { type DurableObjectEvictionOptions, evictDurableObject } from "cloudflare:test";

/** One step of a scenario. It receives the stub and its own index in the list of steps. */
export type EvictionStep<Stub> = (stub: Stub, index: number) => unknown;

export interface StepsWithEvictionOptions extends DurableObjectEvictionOptions {
  /** Evict after the last step as well, so the next call starts on a fresh instance. */
  readonly evictAfterLast?: boolean;
}

/** The awaited result of each step, in step order. */
export type StepResults<Steps extends readonly unknown[]> = {
  -readonly [Index in keyof Steps]: Steps[Index] extends (...args: never) => infer Result
    ? Awaited<Result>
    : never;
};

/**
 * Runs each step against `stub` and evicts the Durable Object between consecutive steps (and after
 * the last one with `evictAfterLast`). Returns the steps' results. A failing step rejects at once,
 * and later steps do not run.
 */
export async function stepsWithEviction<
  Stub extends DurableObjectStub,
  const Steps extends readonly EvictionStep<Stub>[],
>(stub: Stub, steps: Steps, options: StepsWithEvictionOptions = {}): Promise<StepResults<Steps>> {
  const { evictAfterLast = false, ...evictionOptions } = options;
  const results: unknown[] = [];
  for (const [index, step] of steps.entries()) {
    results.push(await step(stub, index));
    if (index < steps.length - 1 || evictAfterLast) {
      await evictDurableObject(stub, evictionOptions);
    }
  }
  return results as StepResults<Steps>;
}
