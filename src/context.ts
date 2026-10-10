// JobContext — the job's cancellation + value scope. Mirrors Go's context.Context
// as the SDK uses it (sdkv1/middleware.go, sdkv1/job.go).
//
// Go hands a context.Context down the pipeline; Node has no such type, so this is
// the equivalent built on the platform's own cancellation primitive, AbortSignal:
//
//   Go                                    here
//   ──────────────────────────────────    ────────────────────────────────────
//   ctx.Err() != nil                      ctx.canceled
//   context.Cause(ctx)                    ctx.cause
//   ctx.Value(k) / context.WithValue      ctx.value(k) / ctx.withValue(k, v)
//   context.WithCancelCause               ctx.withCancel()
//   context.WithTimeout                   ctx.withTimeout(ms)
//   context.WithoutCancel                 ctx.withoutCancel()
//   context.AfterFunc(ctx, fn)            ctx.onDone(fn)
//   select { <-ctx.Done(); <-time.After } await ctx.sleep(ms)
//   passing ctx to a library              passing ctx.signal to fetch(), etc.
//
// The last line is the one that matters in practice: `ctx.signal` is a real
// AbortSignal, so `fetch(url, { signal: ctx.signal })` aborts the request the
// moment the job is stopped, with no polling at all.

/**
 * The error a context carries as its `cause` when it was cancelled without one
 * — the counterpart of Go's `context.Canceled`. A deliberate cause (such as
 * `jobstop.ErrStopped`) replaces it, so a handler can tell *why* its job ended.
 */
export class CanceledError extends Error {
  constructor(message = "job context canceled") {
    super(message);
    this.name = "CanceledError";
  }
}

/** The default cause of a cancellation. Mirrors Go's `context.Canceled`. */
export const ErrCanceled = new CanceledError();

/** The cause a context carries when its deadline passed. Mirrors Go's `context.DeadlineExceeded`. */
export const ErrDeadlineExceeded = new CanceledError("job context deadline exceeded");

/** Cancels a derived context, optionally recording why. Mirrors Go's `context.CancelCauseFunc`. */
export type CancelFunc = (cause?: unknown) => void;

const EMPTY_VALUES: ReadonlyMap<unknown, unknown> = new Map();

/**
 * A job's context: what its middleware passed down, and what ends when the job
 * ends. Handlers get one from `job.context()`; middleware functions get one as
 * their first argument and return it — derived or as-is — for the next function.
 *
 * Instances are immutable: `withValue` / `withCancel` / `withoutCancel` return a
 * new context and leave the one they were called on alone, exactly as Go's do.
 */
export class JobContext {
  /**
   * The cancellation this context is attached to, or undefined for a context
   * that is never cancelled (the background context). Kept optional rather than
   * always allocating a controller: deriving from the background context must
   * not register a listener on a process-wide signal, or every job of a
   * long-running plugin would leak one.
   */
  private readonly sig?: AbortSignal;
  private readonly values: ReadonlyMap<unknown, unknown>;
  /** Lazily made for `signal` on a context that has no cancellation of its own. */
  private neverAborts?: AbortSignal;

  private constructor(sig: AbortSignal | undefined, values: ReadonlyMap<unknown, unknown>) {
    this.sig = sig;
    this.values = values;
  }

  /**
   * The root context: never cancelled, carrying nothing. Mirrors Go's
   * `context.Background()`. A `Job` built by hand answers with this.
   */
  static background(): JobContext {
    return new JobContext(undefined, EMPTY_VALUES);
  }

  /** Whether this context has ended. Mirrors `ctx.Err() != nil`. */
  get canceled(): boolean {
    return this.sig?.aborted ?? false;
  }

  /**
   * Why this context ended, or undefined while it is live — the value a
   * canceller passed, e.g. `jobstop.ErrStopped`. Mirrors `context.Cause(ctx)`.
   */
  get cause(): unknown {
    return this.sig?.aborted ? this.sig.reason : undefined;
  }

  /**
   * An AbortSignal that aborts when this context ends — what you hand to
   * `fetch`, a stream, or anything else that takes one. On a context with no
   * cancellation it is a signal that never aborts.
   */
  get signal(): AbortSignal {
    if (this.sig) return this.sig;
    if (!this.neverAborts) this.neverAborts = new AbortController().signal;
    return this.neverAborts;
  }

  /** The value bound to `key`, or undefined. Mirrors `ctx.Value(key)`. */
  value(key: unknown): unknown {
    return this.values.get(key);
  }

  /**
   * A context carrying `value` under `key`, sharing this one's cancellation.
   * Mirrors `context.WithValue`. Use a module-private symbol as the key, so two
   * packages cannot collide (that is what `jobIDKey` in middleware.ts does).
   */
  withValue(key: unknown, value: unknown): JobContext {
    const next = new Map(this.values);
    next.set(key, value);
    return new JobContext(this.sig, next);
  }

  /**
   * A cancellable child of this context, and the function that cancels it with
   * a cause. Mirrors `context.WithCancelCause`. The child also ends when this
   * context does, carrying this context's cause.
   */
  withCancel(): [JobContext, CancelFunc] {
    const ac = new AbortController();
    const cancel: CancelFunc = (cause?: unknown) => {
      if (!ac.signal.aborted) ac.abort(cause ?? ErrCanceled);
    };
    const parent = this.sig;
    if (parent) {
      if (parent.aborted) {
        ac.abort(parent.reason);
      } else {
        const onParentAbort = () => ac.abort(parent.reason);
        parent.addEventListener("abort", onParentAbort, { once: true });
        // Drop the parent's listener as soon as the child ends: a plugin-wide
        // parent outlives thousands of jobs, and a listener per finished job is
        // a leak (and, past ten, a MaxListenersExceededWarning).
        ac.signal.addEventListener(
          "abort",
          () => parent.removeEventListener("abort", onParentAbort),
          { once: true },
        );
      }
    }
    return [new JobContext(ac.signal, this.values), cancel];
  }

  /**
   * A child of this context that cancels itself after `ms` with
   * ErrDeadlineExceeded. Mirrors `context.WithTimeout`. Call the returned cancel
   * when done so the timer is cleared.
   */
  withTimeout(ms: number): [JobContext, CancelFunc] {
    const [ctx, cancel] = this.withCancel();
    const timer = setTimeout(() => cancel(ErrDeadlineExceeded), ms);
    // Do not hold the event loop open for a job that has already finished.
    timer.unref?.();
    ctx.onDone(() => clearTimeout(timer));
    return [ctx, cancel];
  }

  /**
   * A context with this one's values but no cancellation — for work that must
   * outlive the job that started it (a compensating call, a last log write).
   * Mirrors `context.WithoutCancel`.
   */
  withoutCancel(): JobContext {
    return new JobContext(undefined, this.values);
  }

  /**
   * Run `fn` once when this context ends, with the cause, and return a function
   * that unregisters it. Mirrors `context.AfterFunc`. On a context already ended
   * `fn` runs on the next tick (never synchronously, like Go's); on one that can
   * never be cancelled it never runs.
   */
  onDone(fn: (cause: unknown) => void): () => void {
    if (!this.sig) return () => {};
    if (this.sig.aborted) {
      const reason = this.sig.reason;
      queueMicrotask(() => fn(reason));
      return () => {};
    }
    const sig = this.sig;
    const onAbort = () => fn(sig.reason);
    sig.addEventListener("abort", onAbort, { once: true });
    return () => sig.removeEventListener("abort", onAbort);
  }

  /**
   * Wait `ms`, or until this context ends — whichever comes first. Resolves true
   * if the wait completed, false if the context ended, so a polling loop reads
   * `if (!(await ctx.sleep(2000))) return;`. The counterpart of Go's
   * `select { case <-ctx.Done(): case <-time.After(d): }`.
   */
  sleep(ms: number): Promise<boolean> {
    if (this.canceled) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        off();
        resolve(true);
      }, ms);
      const off = this.onDone(() => {
        clearTimeout(timer);
        resolve(false);
      });
    });
  }

  /**
   * Throw this context's cause if it has ended; otherwise do nothing. For a
   * handler that would rather unwind than check a boolean — but note that
   * throwing out of a handler reports the job as failed
   * (`withJobHandler` → `doneWithError`), which a *stopped* job must not do: the
   * runtime has stopped listening. Prefer `if (ctx.canceled) return;` there.
   */
  throwIfCanceled(): void {
    if (this.canceled) throw this.cause ?? ErrCanceled;
  }
}

/** The root context: never cancelled, carrying nothing. Mirrors `context.Background()`. */
export function background(): JobContext {
  return JobContext.background();
}
