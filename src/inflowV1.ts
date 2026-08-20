// Subject wiring: intro / settings / actions / forms / meta. Mirrors sdkv1/inflowV1.go.
import { randomUUID } from "node:crypto";
import type { Msg } from "nats";
import type { Plugin } from "./plugin.js";
import { ActionRequest, withJobHandler } from "./req.js";
import type { Request } from "./models.js";

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
