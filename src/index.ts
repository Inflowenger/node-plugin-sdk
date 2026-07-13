// @inflowenger/node-plugin-sdk — public API.
// The Node/TypeScript port of go-plugin-sdk (sdkv1).

export {
  Plugin,
  newPlugin,
  withDotEnv,
  withPluginId,
  withInfraConnection,
  type PluginOption,
} from "./plugin.js";

export { Job } from "./job.js";

export { ActionRequest, castRequestTo, withJobHandler } from "./req.js";

export { Command } from "./types.js";

export { NatsBox } from "./nats.js";

export type {
  IPlugin,
  JobHandler,
  PluginIntro,
  Icon,
  FormBuilder,
  Action,
  Settings,
  Meta,
  Frame,
  CommandPayload,
  JobBodyContent,
  Response,
  Request,
  RequestBody,
} from "./models.js";
