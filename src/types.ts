// Job command names — the <CMD> segment of inflow.cpu.<PLUGIN_ID>.<JOB_ID>.<CMD>.
// Mirrors sdkv1/types.go.
export enum Command {
  Progress = "progress",
  ContextCurrent = "context/current",
  ContextPath = "context/path",
  Commit = "commit",
  /** next_tags — fire only the outbound branch(es) whose tags are named. */
  NextTags = "next_tags",
  /** request/svc — a plugin-originated call to a downstream service. */
  Request = "request/svc",
}

/**
 * The kind of a runtime signal: the subject remainder after
 * `inflow.plugin.<PLUGIN_ID>.` — see Signal and Plugin.onSignal. The signal port
 * is a one-way, fire-and-forget channel OUT of the runtime, parallel to the
 * `inflow.v1` (describe me) and `inflow.cpu` (run me) planes; nothing on it is a
 * request, so a handler never replies. Mirrors Go's PluginSignal.
 */
export enum PluginSignal {
  /**
   * "proc" — published once per plugin node process, the moment the runtime
   * stops attending it, on every outcome and not only cancellation. Payload:
   * `{"conclusion":"<Conclusion>","jobId":"<uuid>"}`, where jobId is the same id
   * the SDK minted for that job.
   */
  Proc = "proc",
}

/**
 * How the runtime ended a plugin node process, as carried by a PluginSignal.Proc
 * signal. Mirrors models.PluginConclusion in fractal-core (and Go's Conclusion).
 *
 * Whatever the value, the runtime is no longer listening on that job's command
 * subjects once the signal is out: further progress/done/context calls from a
 * still-running handler will find no responder.
 */
export enum Conclusion {
  /** The job reported progress 100 and its details were committed. */
  Done = "done",
  /** The process ended on a routing command (`next_tags`). */
  Next = "next",
  /** A user halted the running flow — the cancellation case. */
  FlowStopByUser = "flow_stop_by_user",
  /** The flow was stopped by an explicit stop command. */
  CommandStop = "stop_command",
  /** The workflow's own deadline expired while the job ran. */
  Timeout = "timeout",
  /** The node's idle window (`idle_min`) passed with no command from the plugin. */
  LongTimeWithoutCommand = "long_time_without_command",
  /** A command carried a payload or path the runtime could not accept. */
  BadRequest = "bad_request",
  /** The job issued an abnormal number of commands (>1500) and was cut off. */
  ExceededRequestAnomaly = "anomaly_request",
  /** The flow was failed with an error. */
  Failure = "failure",
  /** The runtime failed on its own side (e.g. the commit could not be written). */
  InternalError = "internal_error",
  /** The plugin never acknowledged the execution request with a jobId. */
  PluginNotResponded = "plugin_not_responded",
  /** Cancelled with no recognizable cause (the runtime's spelling is deliberate). */
  UnknownCause = "unknow_cause",
}

/**
 * Whether the process ended the way the job intended — the handler finished
 * (`done`) or routed onward (`next`). Mirrors Go's Conclusion.Succeeded.
 */
export function succeeded(c: Conclusion | string): boolean {
  return c === Conclusion.Done || c === Conclusion.Next;
}

/**
 * Whether the process was cut short by a decision outside the job — a user
 * stopping the flow, a workflow timeout, or the idle window expiring — rather
 * than by the handler finishing or erroring. This is the condition to test when
 * a handler holds work that should be abandoned; see Plugin.onSignal for why
 * abandoning is opt-in and not the default. Mirrors Go's Conclusion.Canceled.
 */
export function canceled(c: Conclusion | string): boolean {
  return (
    c === Conclusion.FlowStopByUser ||
    c === Conclusion.CommandStop ||
    c === Conclusion.Timeout ||
    c === Conclusion.LongTimeWithoutCommand
  );
}
