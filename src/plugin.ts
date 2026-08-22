// The Plugin type, construction, options, and NATS send. Mirrors sdkv1/plugin.go.
import { ErrorCode, type Msg, NatsError } from "nats";
import { NatsBox } from "./nats.js";
import { loadEnv, getEnvVar } from "./env.js";
import {
  actionsHandler,
  introHandler,
  metaFuncHandler,
  settingsHandler,
} from "./inflowV1.js";
import type {
  Action,
  IPlugin,
  Meta,
  PluginIntro,
  Settings,
} from "./models.js";

/** A functional option applied during newPlugin. Mirrors Go's func(*Plugin) error. */
export type PluginOption = (p: Plugin) => void | Promise<void>;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Default NATS request/reply deadline for Send, in ms, when the plugin author
 * doesn't set one. A conservative 5s: fine for the fast RPCs (account list,
 * settings test, a single email send). A plugin whose actions proxy slower
 * upstream calls — a multi-message search, a large fetch — should raise it in
 * code with withTimeout(), since the deadline must sit above whatever the
 * backend needs to answer or the reply is abandoned mid-flight.
 */
export const DEFAULT_SEND_TIMEOUT_MS = 5_000;

/**
 * Env var, in SECONDS, that overrides the send timeout at deploy time — so an
 * operator can widen it for a slow network (REQ_TIMEOUT=50) or tighten it,
 * without touching code. Read once in newPlugin, AFTER the options run, so it
 * wins over the developer's withTimeout(). See resolveReqTimeoutMs.
 */
export const REQ_TIMEOUT_ENV = "REQ_TIMEOUT";

/**
 * The send timeout from REQ_TIMEOUT (seconds → ms), or undefined when unset,
 * blank, non-numeric, or non-positive (leaving the code/default value in place).
 * Read straight from process.env so an unset var is silent — the common case.
 */
export function resolveReqTimeoutMs(): number | undefined {
  const raw = process.env[REQ_TIMEOUT_ENV];
  if (raw === undefined || raw.trim() === "") return undefined;
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    console.log(`Invalid ${REQ_TIMEOUT_ENV}=${raw}, ignoring`);
    return undefined;
  }
  return seconds * 1000;
}

export class Plugin implements IPlugin {
  pluginId = "";
  infraConn!: NatsBox;
  introData: PluginIntro = { name: "", author: "", version: "" };
  settingsData?: Settings;
  actions: Action[] = [];
  metaFn: Meta[] = [];
  /**
   * NATS request/reply deadline for send(), in ms. Defaults to
   * DEFAULT_SEND_TIMEOUT_MS; set it in code with the withSendTimeout() option
   * (or assign directly before start()).
   */
  sendTimeoutMs = DEFAULT_SEND_TIMEOUT_MS;

  getPluginId(): string {
    return this.pluginId;
  }

  /** Set the plugin's identity (shown on the canvas). Call before start(). */
  intro(i: PluginIntro): void {
    this.introData = i;
  }

  /** Register a settings/onboarding form plus its submit handler. */
  requiredParams(requirements: Settings): void {
    this.settingsData = requirements;
  }

  /** Add one or more actions the node can perform. */
  addAction(...act: Action[]): void {
    this.actions.push(...act);
  }

  /**
   * Register one or more meta methods (see the Meta type). Each is served as a
   * synchronous RPC on inflow.v1.<PLUGIN_ID>.<method>; call it before start().
   * Mirrors Go's AddMeta.
   */
  addMeta(...meta: Meta[]): void {
    this.metaFn.push(...meta);
  }

  /** Wire up all subscriptions. Returns immediately — keep the process alive after. */
  start(): void {
    introHandler(this);
    settingsHandler(this);
    actionsHandler(this);
    metaFuncHandler(this);
  }

  /**
   * NATS request/reply with retry: sendTimeoutMs deadline (default 5s, set in
   * code with withSendTimeout()), up to 5 attempts, backing off on "no
   * responders". Set the deadline above the backend's upstream ceiling for slow
   * actions, or a slow reply surfaces as a bare NATS "TIMEOUT".
   */
  async send(subject: string, data: Uint8Array): Promise<Msg> {
    const nc = this.infraConn.connection;
    for (let retry = 0; retry < 5; retry++) {
      try {
        const msg = await nc.request(subject, data, { timeout: this.sendTimeoutMs });
        return msg;
      } catch (err) {
        if (isNoResponders(err)) {
          if (retry > 2) {
            console.log(`No responders - retry :${retry}`);
          }
          await sleep((retry + 1) * 1000);
          continue;
        }
        throw err;
      }
    }
    throw new Error("exception occurred");
  }
}

function isNoResponders(err: unknown): boolean {
  return err instanceof NatsError && err.code === ErrorCode.NoResponders;
}

/** Construct a plugin from functional options. Mirrors Go's NewPlugin. */
export async function newPlugin(...opts: PluginOption[]): Promise<Plugin> {
  const p = new Plugin();
  for (const o of opts) {
    await o(p);
  }
  // Operator override, applied last so REQ_TIMEOUT beats the developer's
  // withTimeout(). withDotEnv (if used) has already loaded the .env file into
  // process.env by now.
  const envTimeout = resolveReqTimeoutMs();
  if (envTimeout !== undefined) p.sendTimeoutMs = envTimeout;
  return p;
}

/** Load PLUGIN_ID / INFRA_CRED / INFRA_URL from a dotenv file and connect. */
export function withDotEnv(envFile: string): PluginOption {
  return async (p) => {
    loadEnv(envFile);
    p.pluginId = getEnvVar("PLUGIN_ID");
    const credential = getEnvVar("INFRA_CRED");
    const infraUrl = getEnvVar("INFRA_URL");
    p.infraConn = await NatsBox.create(credential, infraUrl);
  };
}

/** Set the plugin id explicitly. */
export function withPluginId(pluginId: string): PluginOption {
  return (p) => {
    p.pluginId = pluginId;
  };
}

/** Open the infra connection explicitly (url + base64 credential). */
export function withInfraConnection(
  infraUrl: string,
  credential: string,
): PluginOption {
  return async (p) => {
    p.infraConn = await NatsBox.create(credential, infraUrl);
  };
}

/**
 * Set the NATS request/reply deadline for send(), in SECONDS. Declare it where
 * the plugin is constructed, e.g. newPlugin(withDotEnv(f), withTimeout(65)).
 * Omit it to keep the default (5s). A non-positive value is ignored. The
 * REQ_TIMEOUT env var, when set, overrides this at deploy time.
 */
export function withTimeout(seconds: number): PluginOption {
  return (p) => {
    if (Number.isFinite(seconds) && seconds > 0) p.sendTimeoutMs = seconds * 1000;
  };
}
