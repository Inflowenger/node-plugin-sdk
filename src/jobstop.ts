// Stopping a plugin's job when the runtime stops its flow. Mirrors Go's
// `jobstop` package (github.com/Inflowenger/go-plugin-sdk/jobstop).
//
// It is built from the SDK's public pieces only, and the plugin composes it in
// itself — a middleware function on each action that should stop with its flow,
// and a signal handler on the plugin's signal port:
//
//   const stops = new jobstop.Registry(); // one per plugin
//
//   p.onSignal(stops.onSignal); // before p.start()
//   p.addAction({
//     method: "run",
//     middleware: [stops.middleware],
//     requestHandler: runHandler,
//   });
//
//   async function runHandler(job: Job) {
//     const ctx = job.context();            // ends when the flow is stopped
//     const res = await fetch(url, { signal: ctx.signal }); // aborts with it
//     if (ctx.canceled) return;             // the runtime has stopped listening: do not done()
//     await job.done(result);
//   }
//
// Each piece sits beside others the same way: `use(trace, stops.middleware)` on
// an action (or `p.use` for every action), `chainSignals(stops.onSignal, audit)`
// on the port.
//
// It is opt-in per action, and that is the point: a job the plugin accepted
// keeps running after its flow stops — a later run of the node may build on its
// progress, the runtime handing the previous jobId back in `_registry` — so only
// the actions whose work must not outlive the process take `stops.middleware`: a
// paid call nobody will read, a stream to close, a lock to release.
//
// # Isolation
//
// Stops are matched by jobId, and only by jobId. The runtime publishes process
// signals on ONE subject per plugin, `inflow.plugin.<PLUGIN_ID>.proc`, so every
// process of a plugin receives every one of that plugin's signals: those of jobs
// in other flows running at the same time, and, when the plugin is deployed as
// several replicas, those of jobs this process never accepted. There is no
// flowId on the wire. A signal for a job this registry does not hold is the
// ordinary case, and does nothing.
//
// Because middleware runs before the runtime is told the jobId, a job is always
// filed before any stop for it can arrive.
import type { CancelFunc, JobContext } from "./context.js";
import type { Job } from "./job.js";
import type { MiddlewareFunc } from "./middleware.js";
import type { Signal, SignalHandler } from "./models.js";
import { canceled, PluginSignal } from "./types.js";

/**
 * The cause a stopped job's context carries — read it with `ctx.cause`, or
 * `ctx.cause === jobstop.ErrStopped`.
 *
 * It means the runtime stopped the job's process: a user stop, a stop command,
 * the workflow's timeout, the node's idle window. The runtime has concluded the
 * job and stopped listening: **return without reporting**.
 */
export class StoppedError extends Error {
  constructor(message = "jobstop: the runtime stopped the job's process") {
    super(message);
    this.name = "StoppedError";
  }
}

/** The cause of a stop by the runtime. Mirrors Go's `jobstop.ErrStopped`. */
export const ErrStopped = new StoppedError();

/**
 * The cause a job's context carries when the plugin cancelled every job it holds
 * (`Registry.cancelAll`), typically because it is exiting. Mirrors Go's
 * `jobstop.ErrShutdown`.
 */
export const ErrShutdown = new StoppedError("jobstop: the plugin is shutting down");

/**
 * Holds the jobs filed by its `middleware`, keyed by jobId, from before each is
 * accepted until its context ends. One per plugin.
 */
export class Registry {
  private readonly jobs = new Map<string, CancelFunc>();

  /**
   * A MiddlewareFunc: it files the job under its jobId with a context derived
   * from the one it is given — the one the handler gets — which `onSignal`
   * cancels when the runtime stops the job's process. It runs before the runtime
   * knows the jobId; the job leaves the registry whenever its context ends — a
   * stop, `cancelAll`, or the SDK ending it when the handler returns or the
   * request is rejected — so nothing is left behind however the job ends.
   *
   * It is a bound property, not a prototype method, so it can be passed as a
   * plain function: `middleware: [stops.middleware]`.
   */
  readonly middleware: MiddlewareFunc = (parent: JobContext, job: Job): JobContext => {
    const [ctx, cancel] = parent.withCancel();
    const jobId = job.jobId;
    this.jobs.set(jobId, cancel);
    ctx.onDone(() => {
      // Only unfile our own entry: by the time a context ends, the jobId may
      // have been re-filed by a later run (an adopted external id is reused
      // across runs — see external-job-identity).
      if (this.jobs.get(jobId) === cancel) this.jobs.delete(jobId);
    });
    return ctx;
  };

  /**
   * A SignalHandler. A process signal for a job this registry holds unfiles it,
   * and when its conclusion is `canceled()` — flow_stop_by_user, stop_command,
   * timeout, long_time_without_command — cancels its context with `ErrStopped`
   * and logs the jobId and that conclusion. Any other ending (done, failure, …)
   * leaves the context alone, and logs nothing: the job has finished or is
   * finishing on its own, and must not be cut short.
   *
   * Only a job this registry holds is logged, so the line always means work of
   * this process was cut short — the signals of other flows' and other replicas'
   * jobs, which arrive on the same subject, pass in silence.
   */
  readonly onSignal: SignalHandler = (sig: Signal): void => {
    if (sig.kind !== PluginSignal.Proc || sig.jobId === "") return;
    const cancel = this.jobs.get(sig.jobId);
    if (!cancel) return; // somebody else's job — another flow's, another replica's
    this.jobs.delete(sig.jobId);
    if (!canceled(sig.conclusion)) return;
    // Logged because this is the one moment the plugin's own work is cut short
    // from outside: the handler just sees its context end, so without a line
    // here a stopped job is indistinguishable in the log from one that wound
    // down by itself.
    console.log(
      `jobstop: job ${sig.jobId} cancelled: the runtime concluded its process ${sig.conclusion}`,
    );
    cancel(ErrStopped);
  };

  /**
   * Cancel every job the registry holds, with `ErrShutdown` — for a plugin about
   * to exit, so its handlers see their contexts end and wind down. It sends
   * nothing to the runtime: what a job reports, if anything, is its handler's
   * call.
   */
  cancelAll(): void {
    const held = [...this.jobs.values()];
    this.jobs.clear();
    for (const cancel of held) cancel(ErrShutdown);
  }

  /** How many jobs the registry currently holds. For tests and health output. */
  get size(): number {
    return this.jobs.size;
  }
}
