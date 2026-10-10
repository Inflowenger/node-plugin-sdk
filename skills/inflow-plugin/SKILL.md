---
name: inflow-plugin-node
description: Build an Inflowenger Plugin node with the Node.js/TypeScript SDK (@inflowenger/node-plugin-sdk). Use when the user asks to create, scaffold, or extend an inflow/Inflowenger plugin in Node/TypeScript — adding an action, parsing request input, reporting progress, reading/writing flow context, building the action's UI form, wiring settings, adding middleware, stopping a job when its flow stops (jobstop), running a job under an external service's id, or observing work that outlives the flow run. Not for extrinsic nodes (those belong to inflow-fusion), and not for the Go SDK (use inflow-plugin for that).
---

# Building an Inflowenger Plugin node (Node/TypeScript)

Instructions for writing a plugin with `@inflowenger/node-plugin-sdk`, the Node port
of the Go SDK. A plugin is a long-running Node process that appears as a node on the
Inflowenger workflow canvas and is called by the Fractal runtime over NATS.

Fuller reference lives in the SDK's GitHub repo (this skill is meant to be copied into
a consuming plugin project, so links point there rather than at local paths): the
human cookbook at
[`cookbook.md`](https://github.com/Inflowenger/node-plugin-sdk/blob/main/cookbook.md)
and concept docs under
[`docs/`](https://github.com/Inflowenger/node-plugin-sdk/tree/main/docs).
Verify the current API against the installed `@inflowenger/node-plugin-sdk` package
before relying on any signature; do not invent methods.

The **[plugin catalog](https://github.com/Inflowenger/plugin-catalog)** is the other live resource worth reading: it
carries the current developer knowledge base —
[`concepts.md`](https://github.com/Inflowenger/plugin-catalog/blob/main/docs/concepts.md) (the mental model),
[`build-a-plugin.md`](https://github.com/Inflowenger/plugin-catalog/blob/main/docs/build-a-plugin.md) (build from zero),
[`run-a-plugin.md`](https://github.com/Inflowenger/plugin-catalog/blob/main/docs/run-a-plugin.md),
[`dependent-fields.md`](https://github.com/Inflowenger/plugin-catalog/blob/main/docs/dependent-fields.md),
[`sdks.md`](https://github.com/Inflowenger/plugin-catalog/blob/main/docs/sdks.md) (the SDK matrix) and
[`publishing.md`](https://github.com/Inflowenger/plugin-catalog/blob/main/docs/publishing.md) — plus
[`plugins/`](https://github.com/Inflowenger/plugin-catalog/tree/main/plugins), an entry per shipped plugin pointing at its
real source. Those are the best worked examples available: in Node, [clickhouse-plugin](https://github.com/Inflowenger/clickhouse-plugin),
[mysql-plugin](https://github.com/Inflowenger/mysql-plugin),
[qdrant-plugin](https://github.com/Inflowenger/qdrant-plugin) and
[gmail-oc-plugin](https://github.com/FloMorphic/gmail-oc-plugin). Prefer their
patterns over inventing your own, and check
[`plugins/index.json`](https://github.com/Inflowenger/plugin-catalog/blob/main/plugins/index.json) for the machine-readable
list.

## When to use

Use this when building or modifying an inflow **plugin** node in **Node/TypeScript**:
scaffolding a plugin, adding/editing an action, decoding request bodies, progress
reporting, flow-context read/write, routing outbound branches, calling downstream
services, meta functions, or action/settings forms.

Do **not** use this for **extrinsic** nodes (internal service calls via inflow-fusion,
a different repo), nor for the Go SDK.

## The non-negotiable rules (get these right)

1. **The entry point must stay alive after `start()`.** `p.start()` only wires NATS
   subscriptions and returns. End `main` with `await new Promise(() => {})` or the
   process exits and the plugin dies.
2. **Every handler ends in exactly one `await job.done(...)` or
   `await job.doneWithError(...)` on every path.** On each error branch call
   `await job.doneWithError(String(e))` **and `return`**. Never finish twice or zero
   times.
3. **`await` every Job call.** `progress`, `done`, `doneWithError`, and all `cmd*`
   methods are async and return a `Promise`. Forgetting `await` drops the command.
4. **Decode input with `castRequestTo<T>(job.req.data)`.** It unwraps the
   `{ _registry, body }` envelope → `req.body` (type `T`) + `req._registry`. Unlike
   Go, it **throws** on invalid JSON — wrap it in `try/catch` and call
   `doneWithError` on failure. JSON numbers are `number` already; timestamps are
   seconds (`new Date(Number(v) * 1000)`).
5. **Keep each action's `jsonschema` in sync with its input type.** The form defines
   the shape delivered as `body`. `jsonschema`/`jsonui` are **JSON strings**
   (`JSON.stringify({...})`).
6. **Provisioning is a prerequisite, not code.** The plugin must be defined in a
   space (a NATS account in Infra) to get `PLUGIN_ID`, `INFRA_CRED` (base64), and
   `INFRA_URL`. If missing, tell the user to provision; don't fabricate credentials.

## Procedure

1. **Confirm prerequisites**: `PLUGIN_ID`, `INFRA_CRED`, `INFRA_URL` (usually a
   `.env.inflow`), Node 18+, and Infra + a Fractal running. Install the SDK from git
   (it isn't on npm): see the README's Installation section.
2. **Scaffold `main`** (ESM):
   ```ts
   import { newPlugin, withDotEnv, castRequestTo, type Job } from "@inflowenger/node-plugin-sdk";

   async function main() {
     const p = await newPlugin(withDotEnv(".env.inflow")); // or withInfraConnection + withPluginId
     p.intro({ name: "MY.PLUGIN", author: "…", version: "v0.0.1" });
     p.addAction({ method: "do.thing", title: "…", form, requestHandler });
     p.start();
     await new Promise(() => {});
   }
   main().catch((e) => { console.error(e); process.exit(1); });
   ```
3. **Write each `requestHandler(job: Job)`** using only these verified `Job` ops
   (all async):
   - `castRequestTo<T>(job.req.data)` — typed input (rule 4).
   - `job.progress(pct, { title, content })` — advisory, 0–100; does not finish.
   - `job.done(obj, ...key)` — success + output (finishes).
   - `job.doneWithError(str)` — failure (finishes); the reason goes on the command's
     own `error` field, never into `details`.
   - `job.doneWithErrorCode(num, str, obj, ...key)` — same, plus the plugin's own
     error number (pass `0` when it has none).
   - `job.doneWithErrorData(str, obj, ...key)` — failure that keeps a payload/state
     alongside the reason (finishes).
   - `job.cmdGetCurrentScope()` / `job.cmdGetScope("$.path")` — read context; both
     resolve to a `Uint8Array` (decode with `TextDecoder`).
   - `job.cmdSetOnPath("$.path", obj)` — write into flow context.
   - `job.cmdNextFilter(tags)` — fire only the outbound branch(es) with these tags.
   - `job.cmdSvcCall(action, data, op?)` — call a downstream service mid-job.
   - `job.context()` — the job's `JobContext` (cancellation + values) when the action
     has middleware; a background context otherwise. See step 5.
   - Any path above may start at `$this`, inflow's non-standard root for the
     location this run was handed (the slice the node's `scope` selected), e.g.
     `job.cmdGetScope("$this.customer.id")`. Prefer it over a hardcoded index when
     the node's scope can select more than one location.
4. **Add forms** when the node needs configuration. Either hand-write JSON Forms —
   `form: { jsonschema: JSON.stringify(schema), jsonui: JSON.stringify(ui) }` — or
   build both documents from one declaration with the `formkit` namespace:
   `import { formkit } from "@inflowenger/node-plugin-sdk"`, then
   `form: formkit.form("Title").add(formkit.text("k","K").required()).build()`.
   Plugin-level onboarding/config: `p.requiredParams({ ..., submitHandler })` (or
   `formkit.form(...).settings(handler)`). Register live meta functions with
   `p.addMeta({ method, requestHandler })` before `start()`. An optional Markdown
   manual for the plugin's page goes on `p.intro({ ..., manual })`; a fenced
   ` ```inflow-meta ` block naming a meta method becomes a Run button.
5. **Only if in-flight work must stop with the process**, compose the `jobstop`
   capability onto that action and the signal port, before `start()`:
   ```ts
   import { jobstop, type Job } from "@inflowenger/node-plugin-sdk";

   const stops = new jobstop.Registry();   // one per plugin
   p.onSignal(stops.onSignal);             // cancels the job a canceled() signal names
   p.addAction({
     method: "run",
     middleware: [stops.middleware],       // this action only
     requestHandler: async (job: Job) => {
       const ctx = job.context();           // ends when the flow is stopped
       const res = await fetch(url, { signal: ctx.signal }); // aborts with it
       if (ctx.canceled) return;            // the runtime is gone — do NOT done()
       await job.done({ ok: res.ok });
     },
   });
   ```
   Use it; do not hand-write a `Map` of `AbortController`s. Without
   `p.onSignal(stops.onSignal)` no stop arrives (`start()` logs "Signals not
   subscribed"). Middleware runs before the runtime knows the jobId, so no stop is
   ever lost. This is **optional and not the default**: a job without it deliberately
   keeps running after a stop, because a later run of the node may build on its
   progress (the previous `jobId` comes back in `_registry`). Add it only for a stream
   to close, an upstream call to abort, a lock to release.

   `job.context()` is a `JobContext` — the Node stand-in for Go's `context.Context`,
   built on `AbortSignal`: `ctx.signal` for `fetch`, `ctx.canceled` / `ctx.cause`
   (e.g. `jobstop.ErrStopped`), `await ctx.sleep(ms)` (false ⇒ stopped) for polling
   loops, `ctx.onDone(cb)` for cleanup however the job ends, `ctx.withoutCancel()` for
   work that must outlive the handler, `ctx.withTimeout(ms)` for one bounded step.
   An action with no middleware gets a background context, never cancelled, so
   `ctx.canceled` is always safe to read.

   Other per-job capabilities — a long-running job kept in your own map, a trace
   around the handler — are middleware functions of your own
   (`(ctx: JobContext, job: Job) => JobContext | void`, run in order before the job is
   accepted; register there, clean up with `ctx.onDone(...)`; a **throw rejects** the
   request), listed as `middleware: [...]` on an action or `p.use(...)` on every
   action. Several signal handlers compose with `chainSignals(...)` — chain
   `logSignals("<plugin>")` to keep a log line per arriving signal, which registering
   a handler of your own otherwise replaces (`jobstop` logs the cancel itself). Once a
   stop cancels `ctx`, the runtime no longer answers that job's commands — do not try
   to `done` it. An aborted `fetch` **throws**; the SDK will not report a handler that
   throws while its context is already cancelled, but catch it yourself where you have
   cleanup to do.
6. **If the plugin fronts a service that names work itself** (a Joern HTTP server
   answering `POST /query` with a `queryId`, a render farm, a scan), **do not keep a
   `Map<jobId, upstreamId>`.** Register upstream in a middleware function and bind the
   id it returns as the job's own — middleware runs before the job is accepted, so
   that id is what the runtime is told:
   ```ts
   async function registerQuery(ctx: JobContext, job: Job): Promise<JobContext> {
     const input = castRequestTo<QueryInput>(job.req.data); // throws ⇒ request rejected
     const prev = input._registry?.jobId as string | undefined;
     if (prev && (await joern.alive(prev))) {
       return withJobIDContext(ctx, prev); // reattach, don't duplicate
     }
     const queryId = await joern.register(input.body.project, input.body.query);
     return withJobIDContext(ctx, queryId);
   }
   // namer FIRST — stops.middleware files the job under job.jobId as of when it runs
   middleware: [registerQuery, stops.middleware],
   ```
   One name then serves both systems: `job.jobId`, every command subject, the stop
   signal's `jobId`, and the next run's `_registry.jobId`. The abort needs no local
   state — `joern.cancel(sig.jobId)` in the signal handler, so any replica that hears
   the stop can forward it. Rules: the namer comes **before** anything keyed on the
   jobId; validate the adopted id — at least **10 characters** (fractal-core rejects a
   shorter one: `init failed. invalid job ID`), a usable NATS subject token (no `.`,
   space, `*`, `>`), unique plugin-wide; keep the registration call fast and
   timeout-bounded (the runtime is waiting for the jobId); reject from middleware when
   there is nothing to report, accept and `job.doneWithError` when the flow should see
   a failed node; undo what you enlisted with `ctx.onDone(...)`, which also runs when a
   later function rejects. If the service accepts a client-supplied id instead, do the
   mirror image — keep the SDK's uuid and send `job.jobId` upstream. Full treatment:
   [`docs/external-job-identity.md`](https://github.com/Inflowenger/node-plugin-sdk/blob/main/docs/external-job-identity.md).
7. **If the external work takes longer than a flow run** (hours: a CPG build, a
   render, a nightly scan), **do not block the job.** The runtime waits 15s for the
   `jobId`, abandons a job that sends no command for the node's `idle_min`, and ends
   the run at `ExecuteTimeOut`. Report state and end instead — the plugin is an async
   function, the flow an observer:
   ```ts
   // accept stage: the only inputs are body and _registry (the node's memory of its
   // own previous run; job commands need a jobId, which this decides)
   if (prev && (await joern.has(prev))) return withJobIDContext(ctx, prev); // observe
   // handler:
   if (!status.done) {
     await job.cmdNextFilter(["pending"]);  // a SUCCESSFUL "not yet" — never doneWithError
     await job.done({ state: "running", percent: status.percent }, "joern");
   } else {
     await job.cmdNextFilter(["ready"]);
     await job.done({ result: status.result }, "joern"); // commit, with a key
   }
   ```
   Declare the ports (`outbound: [{ title: "Still running", tags: ["pending"] }, …]`)
   so the canvas shows them, and route `_exception` + `doneWithErrorData` when the work
   failed upstream. Rules: the state snapshot must be **committed**
   (`done(data, key)` — a bare `done` commits nothing); `_registry` is per **call
   site** and lives in the context document, so re-entry must be over the **same
   context** (a Continue After/delay node on the pending branch, a schedule, or a loop
   edge) and the loop needs a floor (attempt counter, or a `reqAt` age limit);
   `doneAt` / `conclusion` describe the *run*, not the work — a pending run ends
   `done`; handle the **stale handle** (service forgot the id → start fresh); and add
   **no** `stops.middleware` to an observer action, because outliving the flow is the
   point. Full treatment:
   [`docs/detached-work.md`](https://github.com/Inflowenger/node-plugin-sdk/blob/main/docs/detached-work.md).
8. **Build & run**: `npm run build` then run the entry, or `npx tsx your-plugin.ts`.
   The SDK logs each subscribed subject on startup. Verify by adding the node to a
   flow and running it.

## Meta functions & form buttons

- **Meta functions** are live request/reply handlers the form can call while open —
  register with `p.addMeta({ method, requestHandler })` before `start()`; each is
  served on `inflow.v1.<PLUGIN_ID>.<method>`. The handler returns any JSON-able value,
  marshalled **verbatim** (a `Response`, a bare array, or a `formkit` patch/envelope).
- A form button (`formkit` `.lookup(fn, label)`, or a hand-written `x-inflow-ui`
  control) calls a meta function and patches the answer back into the open form — one
  match via `formkit.success(...).patch({...})`, several via `formkit.choose(...)`.
- **There is no error channel in the transport.** Say what happened under the
  reserved `x-inflow-notif` key, which the host lifts out of the answer and shows —
  or the button appears to do nothing:
  ```ts
  return formkit.success("Issue: %s", key).patch({ issueKey: key });
  return formkit.failure("cannot reach %s: %s", site, err).patch(null); // message only
  ```
  `formkit.info` / `success` / `warning` / `failure` / `help` are the five severities;
  `.about(field)` re-aims a message, `.patch(null)` is a valid answer on its own (a
  connection test writes nothing). The message defaults to the field the button
  targets; a field some *other* control fills needs `.inline()` on it so the host has
  somewhere to put it. Do **not** add a readonly `lookupStatus`-style property for
  this — a message is not form data, and one declared as a field is sent to the
  service and stored with the rest. The catalog's `dependent-fields.md` still
  describes the pre-`x-inflow-notif` status-field workaround; this supersedes it.

## Known limitations to respect

- A form action **cannot mutate the schema** — answers are patched into form *data*
  only, so you cannot populate a `<select>`'s `enum` at runtime. Model a picker as
  free text + a resolve button (scalar fields) or as an array field filled with a
  returned list (multi-value). Do not invent an options-loading API.
- Nothing fires automatically: no on-change, no debounce, no type-ahead. The user
  clicks. Label the button with what it does.
- If asked for anything about **extrinsic** nodes, redirect to `inflow-fusion`; it
  is not part of this SDK.

## Verify before finishing

- `npm run build` (tsc) passes with no type errors, and `npm test` is green.
- The entry point blocks after `start()`.
- Each action: unique `method`, a `requestHandler`, exactly one finish per path, all
  Job calls `await`ed.
- Each `jsonschema` matches its input type.
- No fabricated SDK methods — every `Job`/`Plugin` call exists in the installed
  `@inflowenger/node-plugin-sdk`.
- If any action uses `jobstop`: `p.onSignal(stops.onSignal)` is registered **before**
  `start()`, the namer (if any) is first in `middleware`, and the handler returns on
  `ctx.canceled` instead of reporting.
