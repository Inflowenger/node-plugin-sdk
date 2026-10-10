# Plugin developer cookbook (Node/TypeScript)

A hands-on cookbook for writing an Inflowenger **Plugin node** with
`@inflowenger/node-plugin-sdk`. Each section is a self-contained *skill* with the
minimal code that does it. This is the Node port of the Go SDK's cookbook; the wire
protocol is identical.

Concepts live in the docs: [architecture](docs/architecture.md) ·
[inflowv1 protocol](docs/protocol-inflowv1.md) · [jobs & commands](docs/jobs-and-commands.md)
· [form builder](docs/form-builder.md) ·
[external job identity](docs/external-job-identity.md) ·
[detached work](docs/detached-work.md) · [examples](docs/examples.md).

Also worth keeping open: the **[plugin catalog](https://github.com/Inflowenger/plugin-catalog)** — the developer
knowledge base ([concepts](https://github.com/Inflowenger/plugin-catalog/blob/main/docs/concepts.md) ·
[build a plugin](https://github.com/Inflowenger/plugin-catalog/blob/main/docs/build-a-plugin.md) ·
[run a plugin](https://github.com/Inflowenger/plugin-catalog/blob/main/docs/run-a-plugin.md) ·
[dependent fields](https://github.com/Inflowenger/plugin-catalog/blob/main/docs/dependent-fields.md) ·
[SDK matrix](https://github.com/Inflowenger/plugin-catalog/blob/main/docs/sdks.md) ·
[publishing](https://github.com/Inflowenger/plugin-catalog/blob/main/docs/publishing.md)) and
[`plugins/`](https://github.com/Inflowenger/plugin-catalog/tree/main/plugins), an entry per shipped plugin pointing at its
real source — the best worked examples there are.

> **Using an AI coding agent?** Copy [`skills/inflow-plugin/SKILL.md`](skills/inflow-plugin/SKILL.md)
> into *your* plugin project's `.claude/skills/inflow-plugin/` so the agent auto-loads it.

---

## Skill 0 — Set up & provision

The plugin must first be **defined in a space** (a NATS account in Infra) to get an
identity and credentials — see the [README](README.md#where-these-values-come-from--provisioning-a-plugin).
Put the three values Infra gives you in a dotenv file:

```env
# .env.inflow
PLUGIN_ID=aa-bbb-ccc-dddd
INFRA_CRED=LS0tLS1CRUdJTiBOQVRTIFVTRVIgSldULS0t...   # base64 of the .creds blob
INFRA_URL=localhost:4222
```

```bash
npm install @inflowenger/node-plugin-sdk
```

> **Checklist:** plugin registered in a space · `PLUGIN_ID` · `INFRA_CRED` (base64) ·
> `INFRA_URL` · Infra + at least one Fractal running.

---

## Skill 1 — Scaffold a runnable plugin

A plugin is an ordinary long-running Node program. Construct → declare → `start()` →
**block**:

```ts
import { newPlugin, withDotEnv, type Job } from "@inflowenger/node-plugin-sdk";

async function main() {
  const p = await newPlugin(withDotEnv(".env.inflow"));

  p.intro({ name: "HTTP.CALL", author: "you", version: "v0.0.1" });

  p.addAction({
    method: "http.call",
    title: "HTTP Call",
    requestHandler: async (job: Job) => {
      await job.done({ ok: true });
    },
  });

  p.start();                       // subscribes to all subjects, returns immediately
  await new Promise(() => {});     // keep the process alive to serve requests
}

main().catch((e) => { console.error(e); process.exit(1); });
```

> **Gotcha:** `start()` returns right away — it only wires up subscriptions. Without
> the trailing `await new Promise(() => {})` the process exits and the plugin dies.

Three ways to construct, pick one:

```ts
// From dotenv (reads PLUGIN_ID / INFRA_CRED / INFRA_URL)
const p = await newPlugin(withDotEnv(".env.inflow"));

// Explicit — you need BOTH the connection and the id
const p = await newPlugin(
  withInfraConnection("localhost:4222", base64Cred),
  withPluginId("aa-bbb-ccc-dddd"),
);
```

---

## Skill 2 — Declare who you are (`intro`)

```ts
p.intro({ name: "HTTP.CALL", author: "inflow Dev. Team", version: "v0.0.1" });
```

---

## Skill 3 — Add an action

An **action** is one method your node can perform. Add as many as you like:

```ts
p.addAction({
  method: "http.call",                        // method id used on the wire
  title: "HTTP Call",
  description: "Perform an outbound HTTP request",
  icon: { icon: "mdi-web" },
  form: { jsonschema: schema, jsonui: ui },   // Skill 8
  requestHandler: myHandler,                  // the work (Skill 4+)
});
```

Every action needs a unique `method` and a `requestHandler`.

---

## Skill 4 — Read the request (typed input)

Decode `job.req.data` with the generic `castRequestTo`, which unwraps the
`{ _registry, body }` envelope (it **throws** on invalid JSON, so wrap it):

```ts
type Input = {
  url: string;
  method: string;
  headers?: Record<string, string>;
  body?: Record<string, unknown>;
};

async function myHandler(job: Job) {
  let req;
  try {
    req = castRequestTo<Input>(job.req.data);
  } catch (e) {
    await job.doneWithError(String(e));
    return;
  }
  // req.body      -> Input          (the user's form input)
  // req._registry -> Record<...>    (runtime metadata; see Skill 5)
}
```

Keep your `Input` type in sync with the action's `jsonschema` — the form defines the
shape delivered in `body`.

---

## Skill 5 — Use previous-run metadata (`_registry`)

```ts
if (req._registry?.jobId) {
  const doneAt = new Date(Number(req._registry.doneAt) * 1000);
  console.log(`previous run ${req._registry.jobId} finished at ${doneAt}`);
}
```

Useful for idempotency, dedup, or resume.

---

## Skill 6 — Report progress

Progress `0–100` with a titled `frame`. Advisory feedback; it does **not** finish the
job. Each command is async — `await` it:

```ts
await job.progress(10, { title: "init step", content: "starting" });
await job.progress(50, { title: "working", content: "calling upstream" });
await job.progress(80, { title: "almost done" });
```

---

## Skill 7 — Finish (success or error)

Exactly one of these must run before the handler returns:

```ts
// Success — `data` becomes this node's output
await job.done({ status: "ok", result });

// Success, committing on an explicit key path (segments joined by ".")
await job.done(payload, "result", "http");

// Failure — completes as failed, reporting the reason
await job.doneWithError("upstream returned 500");

// Failure carrying the plugin's own error number too
await job.doneWithErrorCode(429, "upstream rate limited", null);
```

The reason travels on the command's own `error` field (`{code, message}`), not as a
detail — so `details` are yours alone, and a bare `doneWithError` commits nothing.
`code` is the plugin's own numbering; the core carries it without interpreting it,
so pass `0` when the plugin has none.

> **Pattern:** on every error branch, `await job.doneWithError(...)` **and `return`**.

---

## Skill 8 — Give the action a UI form

**JSON Schema** (data model) + **UI Schema** (layout), rendered by JSON Forms. What
the user fills in becomes the `body` of the request (Skill 4):

```ts
const schema = JSON.stringify({
  type: "object",
  properties: {
    url: { type: "string", title: "URL", format: "uri" },
    method: { type: "string", enum: ["GET", "POST", "PUT", "DELETE"] },
  },
  required: ["url", "method"],
});

const ui = JSON.stringify({
  type: "VerticalLayout",
  elements: [
    { type: "Control", scope: "#/properties/url" },
    { type: "Control", scope: "#/properties/method" },
  ],
});

p.addAction({ method: "http.call", form: { jsonschema: schema, jsonui: ui }, requestHandler: myHandler });
```

`jsonschema` and `jsonui` are **JSON strings**. More in [docs/form-builder.md](docs/form-builder.md).

---

## Skill 9 — Read the flow's context

Context commands return a `Uint8Array` (usually JSON) — decode it:

```ts
const cur = await job.cmdGetCurrentScope();          // whole current scope
console.log("current:", new TextDecoder().decode(cur));

const opa = await job.cmdGetScope("$.OPA");          // slice by JSON path
console.log("$.OPA:", new TextDecoder().decode(opa));
```

---

## Skill 10 — Write into the flow's context (inject results)

```ts
await job.cmdSetOnPath(`$["doc appendix"]`, { itemXterm: [1, 3, 42, 2300] });
```

Separate from `job.done(...)`: `cmdSetOnPath` writes into shared context mid-run;
`done` emits the node's own result.

---

## Skill 11 — Route branches, call services, fail with state

```ts
// Fire only the outbound branch(es) whose tags are named (see Action.outbound).
await job.cmdNextFilter(["approved"]);

// Call a downstream service mid-job; resolves to its reply bytes.
const reply = await job.cmdSvcCall("some.service", { q: "term" }, { op: "search" });

// Fail, but keep state the flow needs — reported (and committed) next to the reason.
await job.doneWithErrorData("rate limited", { cursor }, "state");
return;
```

Failing does **not** stop the flow — downstream nodes still run. A terminal command's
details are what commit onto the node's scope, and a bare `doneWithError` sends none,
so use `doneWithErrorData` whenever the node had persisted state it must not drop.

---

## Skill 12 — Require settings (onboarding form)

```ts
p.requiredParams({
  jsonschema: settingsSchema,
  jsonui: settingsUi,
  // submit_to defaults to "_settings.config.submit" if omitted
  submitHandler: (r) => {
    // validate / persist r.data; return feedback
    return { data: { ok: true } };
  },
});
```

> **Note:** register live **meta functions** with `p.addMeta({ method, requestHandler })`
> before `start()`; each is served on `inflow.v1.<PLUGIN_ID>.<method>` and its return
> value is marshalled verbatim. Set `submit_to` on a form to name one for on-submit
> validation, or hang a `formkit` `.lookup(fn, label)` button off a field. See
> [docs/form-builder.md](docs/form-builder.md).

---

## Skill 13 — Stop a job when its flow is stopped (signals + `jobstop`)

The runtime broadcasts on `inflow.plugin.<PLUGIN_ID>.proc` every time a plugin node
process ends — with the `jobId` and a conclusion (`done`, `flow_stop_by_user`,
`timeout`, …). `p.onSignal` subscribes to that port; call it **before `start()`**.

```ts
p.onSignal((sig) => {
  console.log(`job ${sig.jobId} ended: ${sig.conclusion}`);
});
```

**Skip this skill unless you need it.** A stopped or timed-out process does *not*
stop the job you accepted, by design: the next run of that node may build on the
progress this one made — the runtime hands the previous `jobId` back in `_registry`.
Only reach for it when the work itself must die with the process: an open stream, a
paid upstream call, a held lock.

The working pattern is to file the cancel under the `jobId` and let the signal find
it. `jobstop` is that, as a capability you add to the actions that need it — a
middleware on the action, a signal handler on the port:

```ts
import { jobstop, type Job } from "@inflowenger/node-plugin-sdk";

const stops = new jobstop.Registry(); // one per plugin
p.onSignal(stops.onSignal);           // before start()

p.addAction({
  method: "long.export",
  middleware: [stops.middleware],     // only on actions that should stop with the flow
  requestHandler: async (job: Job) => {
    const ctx = job.context();        // ends when the flow is stopped
    try {
      const res = await fetch(url, { signal: ctx.signal }); // aborts with it
      await job.done({ ok: res.ok });
    } catch (err) {
      if (ctx.canceled) return;       // stopped: the runtime is gone, do not done()
      await job.doneWithError(String(err));
    }
  },
});
```

Middleware runs before the runtime is told the jobId, so a stop can never arrive for
a job not yet filed. A middleware is a plain function —
`(ctx: JobContext, job: Job) => JobContext | void` — so your own capabilities (a
long-running job kept in your map, a trace) are middleware too, listed in order:
`middleware: [trace, stops.middleware]` on an action, `p.use(trace)` on every action,
`chainSignals(stops.onSignal, yours)` on the port. A throw from one rejects the
request.

`job.context()` is the Node stand-in for Go's `context.Context`, built on
`AbortSignal`:

| What you want | Call |
|---|---|
| Hand cancellation to `fetch` / any abortable API | `ctx.signal` |
| Ask whether the job was cut short, and why | `ctx.canceled` · `ctx.cause` |
| Poll without pinning a stopped job | `await ctx.sleep(2000)` → `false` if it ended |
| Clean up however the job ends | `ctx.onDone((cause) => …)` |
| Keep work alive past the handler | `ctx.withoutCancel()` |

Gotchas:

- Cancellation is **per `jobId`**. One subject carries every signal of the plugin, so
  a process hears the endings of other flows' jobs (and other replicas'); those find
  nothing filed and do nothing.
- Signals arrive on **success too** — `stops.onSignal` filters on
  `canceled(sig.conclusion)`; a handler of your own should too.
- When a stop lands the runtime has already stopped listening to that job, so a
  stopped handler's `progress`/`done` will find no responder. Wind down quietly.
- **An abort is a throw.** `fetch` on an aborted signal rejects. The SDK will not
  report a handler that throws while its context is already cancelled (it logs
  instead), but catch it yourself where you have cleanup to do.
- Handlers are not awaited; only the last one registered is kept — compose several
  with `chainSignals`.
- Registering your own handler replaces the logging `p.onSignal()` gives you. Chain
  `logSignals("<plugin>")` to keep a line per signal that arrives:
  `p.onSignal(chainSignals(logSignals("my-plugin"), stops.onSignal))`. `jobstop` logs
  the other half — the job it actually cancelled — so a signal with no cancel line
  beside it was not about work this process is running.

Full treatment: [docs/jobs-and-commands.md § Signals](docs/jobs-and-commands.md#signals--when-the-runtime-ends-a-process).

---

## Skill 14 — Run the job under an external service's id (advanced)

When your plugin is a **middleman** for a service that names work itself — Joern's
HTTP server answering `POST /query` with `{"queryId":"q-8f21"}`, a render farm, a
scan — do not keep a `Map<pluginJobId, upstreamId>`. Register the work in a middleware
function and bind what came back as the job's id: middleware runs **before** the job
is accepted, so the id you bind is the id the runtime is told.

```ts
import { castRequestTo, withJobIDContext, type Job, type JobContext } from "@inflowenger/node-plugin-sdk";

async function registerQuery(ctx: JobContext, job: Job): Promise<JobContext> {
  const input = castRequestTo<QueryInput>(job.req.data); // a throw rejects the request
  // Re-running? The previous jobId IS the upstream id — reattach, don't duplicate.
  const prev = input._registry?.jobId as string | undefined;
  if (prev && (await joern.alive(prev))) return withJobIDContext(ctx, prev);

  const queryId = await joern.register(input.body.project, input.body.query);
  return withJobIDContext(ctx, queryId); // a throw above enlisted nothing: nothing to undo
}

p.onSignal(chainSignals(stops.onSignal, abortUpstream));
p.addAction({
  method: "cpg.query",
  middleware: [registerQuery, stops.middleware], // namer FIRST
  requestHandler: queryHandler,
});
```

From then on one name serves both systems: `job.jobId`, every command subject
(`inflow.cpu.<id>.q-8f21.progress`), the stop signal's `jobId`, and the next run's
`_registry.jobId`. Cancellation needs no local lookup at all —

```ts
function abortUpstream(sig: Signal) {
  if (sig.kind !== PluginSignal.Proc || !canceled(sig.conclusion)) return;
  void joern.cancel(sig.jobId); // sig.jobId IS the queryId
}
```

— so any replica that hears the stop can abort the query, which a process-local map
could never do.

Gotchas:

- **Name the job first.** `stops.middleware` (and anything else keyed on the jobId)
  files under `job.jobId` *as of when it runs*; placed before the namer it files a
  uuid nothing will look up, and the stop is lost.
- **Validate the id you adopt.** It must be **at least 10 characters** —
  fractal-core refuses a shorter `jobId` with `init failed. invalid job ID` — a usable
  NATS subject token (no `.`, space, `*`, `>`, since the command subjects are built
  from it), and unique plugin-wide (prefix per-project counters).
- **Register fast.** The runtime is waiting for the jobId while middleware runs — one
  timeout-bounded call (`ctx.withTimeout(5_000)` → `fetch(url, { signal })`), never
  the work itself.
- **Reject vs fail**: a middleware throw means the node never ran (the runtime gets
  the error, not a failed job). When the flow should *see* a failed node, accept and
  use `job.doneWithError`.
- **Undo what you enlisted.** If a later function rejects, the job's context ends —
  register the compensation with `ctx.onDone(() => joern.cancel(queryId))` and it runs
  without any special casing.
- If the service accepts a **client-supplied** id instead, do the mirror image: keep
  the SDK's uuid and send `job.jobId` upstream.

Full treatment, with the distributed-transaction model and the failure modes:
[docs/external-job-identity.md](docs/external-job-identity.md).

---

## Skill 15 — Report and observe instead of waiting (advanced)

Work that takes hours does not fit in a job. Three budgets say so: the runtime waits
**15s** for your `jobId`, gives up on a job that sends no command for the node's
`idle_min`, and ends the run at `ExecuteTimeOut`. So do not wait — **report where the
work has got to, route a "not yet" port, and end the job in seconds.** The flow's
process finishes; the external work doesn't; a later run of the same node picks it up
through `_registry`.

```ts
// Accept stage. Only two inputs exist here: body, and _registry — the node's memory
// of its own previous run (job commands need a jobId, which this decides).
async function attachOrStart(ctx: JobContext, job: Job): Promise<JobContext> {
  const input = castRequestTo<QueryInput>(job.req.data);
  const prev = input._registry?.jobId as string | undefined;
  if (prev && (await joern.has(prev))) {
    return withJobIDContext(ctx, prev); // observe what the last run started
  }
  const queryId = await joern.register(input.body.project, input.body.query); // start new work
  return withJobIDContext(ctx, queryId);
}

async function observe(job: Job) {
  const status = await joern.poll(job.jobId); // job.jobId IS the upstream id
  if (status.failed) {
    await job.cmdNextFilter(["_exception"]); // fail AND route
    await job.doneWithErrorData(status.error, { queryId: job.jobId }, "joern");
  } else if (!status.done) {
    await job.cmdNextFilter(["pending"]);    // a SUCCESSFUL "not yet"
    await job.done({ state: "running", percent: status.percent }, "joern");
  } else {
    await joern.release(job.jobId);
    await job.cmdNextFilter(["ready"]);
    await job.done({ state: "done", result: status.result }, "joern");
  }
}
```

Declare the ports so the canvas shows them before anything runs:

```ts
outbound: [
  { title: "Still running", tags: ["pending"] },
  { title: "Result ready",  tags: ["ready"] },
  { title: "Query failed",  tags: ["_exception"] },
],
```

Then the flow closes the loop: the `pending` branch ends in a delay/Continue After
node, a schedule re-runs it, or a loop edge returns to the node — all of which must
re-enter **over the same context document**, because `_registry` is the node's entry
in that document.

Gotchas:

- **"Still running" is `done`, not an error.** The job did look; the answer is "not
  yet". `doneWithError` there would route the flow's error branch for a perfectly
  healthy query.
- **Commit, don't just report.** `job.done(data, "joern")` commits at that key — a
  bare `done` with no key commits nothing, so the next run (and the next node) sees an
  empty scope.
- **`_registry` is per call site and lives in the context document.** Two `GoTo`s onto
  the same sub-flow keep separate memories; a run over a *new* context starts fresh
  and will correctly start new upstream work.
- **`doneAt` / `conclusion` describe the run, not the work.** A "pending" run ends
  `done`. Only the service knows the work's state. `reqAt` is the useful one — it
  dates the handle, so you can give up on a stale one.
- **No `stops.middleware` on an observer action.** Outliving the flow is the point; a
  stop should not abort the upstream work unless an abandoned job genuinely costs you
  (then abort it from the signal handler by `sig.jobId`).
- **Handle the stale handle.** If the service has forgotten the id, start fresh rather
  than reporting `pending` forever.
- **Give the loop a floor** — an attempt counter in a contract, or a `reqAt` age limit
  in the plugin.

Full treatment, with the three budgets, the registry fields and the limits:
[docs/detached-work.md](docs/detached-work.md).

---

## Recipe A — An adapter action (external I/O)

```ts
p.addAction({
  method: "http.call",
  requestHandler: async (job: Job) => {
    let req;
    try {
      req = castRequestTo<Input>(job.req.data);
    } catch (e) {
      await job.doneWithError(String(e));
      return;
    }

    await job.progress(20, { title: "working", content: req.body.url });

    try {
      const resp = await fetch(req.body.url, {
        method: req.body.method,
        headers: { "Content-Type": "application/json", ...(req.body.headers ?? {}) },
        body: req.body.body ? JSON.stringify(req.body.body) : undefined,
      });
      const raw = await resp.text();
      let out: Record<string, unknown>;
      try { out = JSON.parse(raw); } catch { out = { rawBody: raw }; }
      await job.done(out);
    } catch (e) {
      await job.doneWithError(String(e));
    }
  },
});
```

## Recipe B — A pure context/transform action (no I/O)

```ts
p.addAction({
  method: "fn",
  requestHandler: async (job: Job) => {
    const opa = await job.cmdGetScope("$.OPA");
    console.log("$.OPA:", new TextDecoder().decode(opa));
    await job.cmdSetOnPath(`$["result"]`, { computed: 42 });
    await job.done({ action: "done" });
  },
});
```

## Recipe C — A long-running / event plugin

The plugin is a persistent process, so it can hold connections and run loops between
requests. Open shared resources once, reuse across handlers. This is also the shape
most likely to want [Skill 13](#skill-13--stop-a-job-when-its-flow-is-stopped-signals--jobstop):
background work that should be torn down when the process that started it is stopped.
If the work is measured in hours rather than minutes, it wants
[Skill 15](#skill-15--report-and-observe-instead-of-waiting-advanced) instead — report
and end, rather than hold a job open.

```ts
async function main() {
  const p = await newPlugin(withDotEnv(".env.inflow"));
  p.intro({ name: "QUEUE.WATCH", author: "you", version: "v0.0.1" });

  // const conn = await connectToQueue(); // opened once, reused

  p.addAction({
    method: "enqueue",
    requestHandler: async (job: Job) => {
      // use conn ...
      await job.done({ queued: true });
    },
  });

  p.start();
  await new Promise(() => {});
}
```

---

## Run & iterate locally

1. Point `.env.inflow` at your running Infra.
2. `npm run build` then run your entry (or `npm run example:http`). During dev,
   `npx tsx your-plugin.ts` runs TypeScript directly.
3. On startup the SDK logs each subscribed subject — that confirms registration.
4. Add your node to a flow in the inspector panel, run it, watch progress + output.

---

## Ship checklist

- [ ] Plugin is defined in a space; `PLUGIN_ID` / `INFRA_CRED` / `INFRA_URL` set.
- [ ] Entry point stays alive after `start()` (`await new Promise(() => {})`).
- [ ] Every action has a unique `method` and a `requestHandler`.
- [ ] Every handler ends in exactly one `done` / `doneWithError` on all paths.
- [ ] Each action's `jsonschema` matches its input type.
- [ ] Every context/finish call is `await`ed.
- [ ] Errors are surfaced via `doneWithError`, not just logged.
- [ ] If any action must stop with its flow: `middleware: [stops.middleware]` on it,
      `p.onSignal(stops.onSignal)` before `start()`, and the handler returns on
      `ctx.canceled` without reporting.
- [ ] If a middleware function names the job from an upstream service, it comes
      **first** in the list and validates the id (≥ 10 chars, subject-safe).
