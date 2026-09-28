// Subject wiring: intro / settings / actions / forms / meta. Mirrors sdkv1/inflowV1.go.
import { randomUUID } from "node:crypto";
import type { Msg } from "nats";
import type { Plugin } from "./plugin.js";
import { ActionRequest, withJobHandler } from "./req.js";
import type { Request, Signal } from "./models.js";
import type { Conclusion, PluginSignal } from "./types.js";

const encoder = new TextEncoder();

// ---- subject makers -------------------------------------------------------

/** inflow.v1.<PLUGIN_ID>.<action> — meta functions & settings submit. */
export const makeActionSubject = (pluginId: string, action: string): string =>
  `inflow.v1.${pluginId}.${action}`;

/** inflow.v1.<PLUGIN_ID>.@settings */
export const makeSettingsSubject = (pluginId: string): string =>
  `inflow.v1.${pluginId}.@settings`;

/** inflow.v1.<PLUGIN_ID>.@actions */
export const makeActionsListSubject = (pluginId: string): string =>
  `inflow.v1.${pluginId}.@actions`;

/** inflow.v1.<PLUGIN_ID>.@intro */
export const makeIntroSubject = (pluginId: string): string =>
  `inflow.v1.${pluginId}.@intro`;

/** inflow.cpu.<PLUGIN_ID>.<ACTION> — the runtime's execution call. */
export const makeActionCpu = (pluginId: string, action: string): string =>
  `inflow.cpu.${pluginId}.${action}`;

/** inflow.plugin.<PLUGIN_ID>.> — the wildcard signal port (every signal kind). */
export const makeSignalSubject = (pluginId: string): string =>
  `inflow.plugin.${pluginId}.>`;

/** inflow.v1.<PLUGIN_ID>.<ACTION>.@form */
export const makeFormSubject = (pluginId: string, action: string): string =>
  `inflow.v1.${pluginId}.${action}.@form`;

// ---- handlers -------------------------------------------------------------

const json = (v: unknown): Uint8Array => encoder.encode(JSON.stringify(v));

function reqFrom(p: Plugin, msg: Msg): Request {
  return { data: msg.data, header: msg.headers, plugin: p };
}

export function introHandler(p: Plugin): void {
  const nc = p.infraConn.connection;
  nc.subscribe(makeIntroSubject(p.pluginId), {
    callback: (_err, msg) => {
      msg.respond(json(p.introData));
    },
  });
}

export function settingsHandler(p: Plugin): void {
  const nc = p.infraConn.connection;

  // show the settings form. A plugin that requires nothing still answers, with
  // an empty object: an empty body is not JSON, so a caller could not tell
  // "asks for nothing" from "not running".
  nc.subscribe(makeSettingsSubject(p.pluginId), {
    callback: (_err, msg) => {
      if (!p.settingsData) {
        msg.respond(encoder.encode("{}"));
        return;
      }
      msg.respond(json(p.settingsData));
    },
  });

  // settings submit handler
  if (p.settingsData) {
    if (!p.settingsData.submit_to || p.settingsData.submit_to.trim() === "") {
      p.settingsData.submit_to = "_settings.config.submit";
    }
    nc.subscribe(makeActionSubject(p.pluginId, p.settingsData.submit_to), {
      callback: async (_err, msg) => {
        const settings = p.settingsData!;
        if (!settings.submitHandler) {
          msg.respond(encoder.encode(`{"status":"not implemented"}`));
          return;
        }
        try {
          const res = await settings.submitHandler(reqFrom(p, msg));
          msg.respond(json(res));
        } catch {
          msg.respond(
            encoder.encode(`{"error":"error occurred in submit handler"}`),
          );
        }
      },
    });
  }
}

export function actionsHandler(p: Plugin): void {
  const nc = p.infraConn.connection;

  // list of all actions
  nc.subscribe(makeActionsListSubject(p.pluginId), {
    callback: (_err, msg) => {
      msg.respond(json(p.actions));
    },
  });

  for (const action of p.actions) {
    // this action's form
    nc.subscribe(makeFormSubject(p.pluginId, action.method), {
      callback: (_err, msg) => {
        msg.respond(json(action.form ?? {}));
      },
    });
    console.log(`Form Builder Service : ${makeFormSubject(p.pluginId, action.method)}`);

    // execution: mint a jobId, ack with it, then run the handler
    nc.subscribe(makeActionCpu(p.pluginId, action.method), {
      callback: (_err, msg) => {
        if (!action.requestHandler) {
          console.log(`recv new request message on action ${action.method}`);
          return;
        }
        const jobId = randomUUID();
        const ar = new ActionRequest(jobId, action.method, reqFrom(p, msg));
        void withJobHandler(action.requestHandler)(ar, msg);
      },
    });
    console.log(`Subscribed Action : ${makeActionCpu(p.pluginId, action.method)}`);
  }
}

export function metaFuncHandler(p: Plugin): void {
  const nc = p.infraConn.connection;
  for (const meta of p.metaFn) {
    nc.subscribe(makeActionSubject(p.pluginId, meta.method), {
      callback: async (_err, msg) => {
        try {
          const res = await meta.requestHandler(reqFrom(p, msg));
          msg.respond(json(res));
        } catch {
          msg.respond(
            encoder.encode(`{"error":"error occurred in marshal response"}`),
          );
        }
      },
    });
    console.log(`Meta Function Service : ${makeActionSubject(p.pluginId, meta.method)}`);
  }
}

/**
 * Subscribe the registered signal handler (Plugin.onSignal) to the whole signal
 * port, `inflow.plugin.<PLUGIN_ID>.>`. A plugin that never called onSignal
 * subscribes to nothing — the port is opt-in. Mirrors Go's signalsHandler.
 */
export function signalsHandler(p: Plugin): void {
  const handler = p.signalFn;
  if (!handler) return;
  const nc = p.infraConn.connection;
  nc.subscribe(makeSignalSubject(p.pluginId), {
    callback: (_err, msg) => {
      const sig = parseSignal(p.pluginId, msg);
      // A signal handler that blocks (closing a stream, aborting an upstream
      // call) must not stall the signals behind it, and a rejected promise here
      // would surface as an unhandled rejection that crashes the plugin.
      void (async () => {
        try {
          await handler(sig);
        } catch (err) {
          console.log(`signal handler failed on ${sig.subject}:`, err);
        }
      })();
    },
  });
  console.log(`Signals Subscribed on : ${makeSignalSubject(p.pluginId)}`);
}

/**
 * Turn a raw signal message into a Signal: `kind` is whatever the subject
 * carries past the plugin's prefix, and a payload that parses as the runtime's
 * `{conclusion, jobId}` body fills the typed fields. A payload that does not
 * parse is not an error — an unmodelled future kind still reaches the handler
 * with its bytes intact.
 */
export function parseSignal(pluginId: string, msg: Msg): Signal {
  const sig: Signal = {
    kind: msg.subject.startsWith(`inflow.plugin.${pluginId}.`)
      ? (msg.subject.slice(`inflow.plugin.${pluginId}.`.length) as PluginSignal)
      : msg.subject,
    subject: msg.subject,
    jobId: "",
    conclusion: "",
    data: msg.data,
    msg,
  };
  try {
    const body = JSON.parse(new TextDecoder().decode(msg.data)) as {
      conclusion?: string;
      jobId?: string;
    };
    if (body && typeof body === "object") {
      sig.jobId = body.jobId ?? "";
      sig.conclusion = (body.conclusion ?? "") as Conclusion;
    }
  } catch {
    /* an unmodelled kind: leave the typed fields empty, keep data */
  }
  return sig;
}
