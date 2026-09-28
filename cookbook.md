# Plugin developer cookbook (Node/TypeScript)

A hands-on cookbook for writing an Inflowenger **Plugin node** with
`@inflowenger/node-plugin-sdk`. Each section is a self-contained *skill* with the
minimal code that does it. This is the Node port of the Go SDK's cookbook; the wire
protocol is identical.

Concepts live in the docs: [architecture](docs/architecture.md) ·
[inflowv1 protocol](docs/protocol-inflowv1.md) · [jobs & commands](docs/jobs-and-commands.md)
· [form builder](docs/form-builder.md) · [examples](docs/examples.md).

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

## Skill 13 — React when a process ends (signals, optional)

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
Only reach for `onSignal` when the work itself must die with the process: an open
stream, a paid upstream call, a held lock.

File the aborter under the `jobId` and let the signal find it:

```ts
import { canceled } from "@inflowenger/node-plugin-sdk";

const inflight = new Map<string, AbortController>();

p.onSignal((sig) => {
  if (!canceled(sig.conclusion)) return; // done / next / failed: nothing to abort
  inflight.get(sig.jobId)?.abort();
  inflight.delete(sig.jobId);
});

p.addAction({
  method: "long.export",
  requestHandler: async (job: Job) => {
    const ac = new AbortController();
    inflight.set(job.jobId, ac);
    try {
      const res = await fetch(url, { signal: ac.signal });
      await job.done({ ok: res.ok });
    } catch (err) {
      await job.doneWithError(String(err));
    } finally {
      inflight.delete(job.jobId);
    }
  },
});
```

Gotchas:

- Signals arrive on **success too** — always filter on `sig.conclusion`
  (`canceled()` / `succeeded()`).
- When the signal lands the runtime has already stopped listening to that job, so an
  abandoned handler's `progress`/`done` will find no responder. Wind down quietly.
- Handlers are not awaited; only the last one registered is kept.

Full treatment: [docs/jobs-and-commands.md § Signals](docs/jobs-and-commands.md#signals--when-the-runtime-ends-a-process).

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
most likely to want [Skill 13](#skill-13--react-when-a-process-ends-signals-optional):
background work that should be torn down when the process that started it is stopped.

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
