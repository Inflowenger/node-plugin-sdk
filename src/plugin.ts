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

export class Plugin implements IPlugin {
  pluginId = "";
  infraConn!: NatsBox;
  introData: PluginIntro = { name: "", author: "", version: "" };
  settingsData?: Settings;
  actions: Action[] = [];
  metaFn: Meta[] = [];

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

  // NOTE: like the Go SDK, meta functions have wiring (metaFuncHandler) but no
  // exported registration method yet, so `metaFn` stays empty for now. Use the
  // settings submitHandler for live validation today.

  /** Wire up all subscriptions. Returns immediately — keep the process alive after. */
  start(): void {
    introHandler(this);
    settingsHandler(this);
    actionsHandler(this);
    metaFuncHandler(this);
  }

  /**
   * NATS request/reply with retry, mirroring Go's Plugin.Send: 3s timeout, up to
   * 5 attempts, backing off on "no responders".
   */
  async send(subject: string, data: Uint8Array): Promise<Msg> {
    const nc = this.infraConn.connection;
    for (let retry = 0; retry < 5; retry++) {
      try {
        const msg = await nc.request(subject, data, { timeout: 3000 });
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
