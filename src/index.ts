// @inflowenger/node-plugin-sdk — public API.
// The Node/TypeScript port of go-plugin-sdk (sdkv1).

export {
  Plugin,
  newPlugin,
  withDotEnv,
  withPluginId,
  withInfraConnection,
  withTimeout,
  withJobID,
  DEFAULT_SEND_TIMEOUT_MS,
  REQ_TIMEOUT_ENV,
  resolveReqTimeoutMs,
  type PluginOption,
} from "./plugin.js";

export { Job } from "./job.js";

export { ActionRequest, castRequestTo, withJobHandler } from "./req.js";

// The job's context — cancellation + values, the Node counterpart of Go's
// context.Context as the SDK uses it.
export {
  JobContext,
  background,
  CanceledError,
  ErrCanceled,
  ErrDeadlineExceeded,
  type CancelFunc,
} from "./context.js";

// Middleware — functions run before a job is accepted.
export {
  use,
  jobID,
  withJobIDContext,
  jobIDFromContext,
  type MiddlewareFunc,
  type Middlewares,
} from "./middleware.js";

// Signal-port composition.
export { chainSignals, logSignals } from "./compose.js";

// Subject makers and the request path, for tests and for a plugin that drives
// the handshake itself.
export {
  actionsPayload,
  dispatchAction,
  runPipeline,
  parseSignal,
  signalPortNote,
  makeActionSubject,
  makeActionsListSubject,
  makeActionCpu,
  makeFormSubject,
  makeIntroSubject,
  makeSettingsSubject,
  makeSignalSubject,
} from "./inflowV1.js";

export { Command, PluginSignal, Conclusion, succeeded, canceled } from "./types.js";

export { NatsBox } from "./nats.js";

export type {
  IPlugin,
  JobHandler,
  PluginIntro,
  Icon,
  FormBuilder,
  Action,
  OutboundPort,
  Settings,
  Meta,
  Frame,
  CommandPayload,
  ErrorPayload,
  JobBodyContent,
  Response,
  Request,
  RequestBody,
  ActionRequestContent,
  CallSvcBody,
  Signal,
  SignalHandler,
} from "./models.js";

// jobstop — stop a job when the runtime stops its flow. Opt-in per action:
// `const stops = new jobstop.Registry()`, `p.onSignal(stops.onSignal)`,
// `middleware: [stops.middleware]`. Mirrors the Go SDK's `jobstop` package.
export * as jobstop from "./jobstop.js";

// formkit — optional form builder (JSON Schema + JSON Forms UI Schema).
// Mirrors the Go `formkit` package; use as `formkit.form(...)`, `formkit.text(...)`.
export * as formkit from "./formkit/index.js";
