// @inflowenger/node-plugin-sdk — public API.
// The Node/TypeScript port of go-plugin-sdk (sdkv1).

export {
  Plugin,
  newPlugin,
  withDotEnv,
  withPluginId,
  withInfraConnection,
  withTimeout,
  DEFAULT_SEND_TIMEOUT_MS,
  REQ_TIMEOUT_ENV,
  resolveReqTimeoutMs,
  type PluginOption,
} from "./plugin.js";

export { Job } from "./job.js";

export { ActionRequest, castRequestTo, withJobHandler } from "./req.js";

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

// formkit — optional form builder (JSON Schema + JSON Forms UI Schema).
// Mirrors the Go `formkit` package; use as `formkit.form(...)`, `formkit.text(...)`.
export * as formkit from "./formkit/index.js";
