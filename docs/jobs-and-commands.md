# Jobs & commands

Everything a plugin *does* happens inside a `Job`. When the runtime executes one of
your actions, the SDK acknowledges the request with a fresh `jobId` and hands your
`requestHandler` a `Job` bound to that id and to the NATS connection. Through it you
report progress, read/write the flow's context, route outbound branches, call
downstream services, and finish the job.

```ts
class Job {
  readonly action: string;  // the action method invoked
  readonly jobId: string;   // uuid correlating all commands for this execution
  readonly req: Request;    // the raw request (data, header, plugin)
}
```

Each method publishes to `inflow.cpu.<PLUGIN_ID>.<JOB_ID>.<command>` and returns the
runtime's reply as a `Uint8Array`. **All Job methods are async — `await` them.**

## Reading the request

`job.req.data` is the raw JSON body (a `Uint8Array`). Decode it with `castRequestTo`,
which unwraps the `{ _registry, body }` envelope:

```ts
let req;
try {
  req = castRequestTo<MyInput>(job.req.data);
} catch (e) {
  await job.doneWithError(String(e));
  return;
}
// req.body      -> MyInput
// req._registry -> Record<string, unknown>

if (req._registry?.jobId) {
  const doneAt = new Date(Number(req._registry.doneAt) * 1000);
  console.log(`previous run ${req._registry.jobId} finished at ${doneAt}`);
}
```

`job.req.header` exposes the NATS message headers (`MsgHdrs`) if you need transport
metadata.

## Progress

```ts
await job.progress(10, { title: "init step", content: "task is starting" });
await job.progress(50, { title: "working", content: "halfway there" });
```

Progress is advisory feedback; only reaching 100 (via `done`/`doneWithError`)
completes the job.

## Finishing a job

```ts
// Success — commits `data` as this node's output. Progress becomes 100.
await job.done({ status: "ok", body: result });

// Success, committing on an explicit key path (segments joined by ".")
await job.done(payload, "result", "http");

// Failure — reports the reason on the command's own `error` field, no details.
await job.doneWithError("upstream returned 500");

// Failure that still carries state — `data` is reported (and committed, at the
// optional key) alongside the reason.
await job.doneWithErrorData("rate limited", { cursor, conversation }, "state");

// Failure carrying the plugin's own error number too.
await job.doneWithErrorCode(429, "upstream rate limited", null);
```

All are a `progress` command at `100`: `done` sends `{progress:100, details:data,
commit_on:key}`, and the error variants add `error:{code,message}` with `details`
and `commit_on` filled exactly as `done` fills them.

The reason travels on that `error` field, **not** as a detail. So nothing in `data`
is reserved (a key named `error` is the plugin's to use), and the presence of the
field — not its contents — is what makes the finished job a failed one: an empty
message still fails the job. `code` is the plugin's own number in the plugin's own
numbering; the core carries it next to the message without interpreting it, so pass
`0` when the plugin has none.

A terminal command's details **are** what gets committed onto the node's scope, and
a bare `doneWithError` sends none, so it drops anything the node had persisted there
— hand it back through `doneWithErrorData` to keep it. Call exactly one before the
handler returns.

## Reading the flow context

```ts
// whole current scope (raw bytes — usually JSON)
const cur = await job.cmdGetCurrentScope();
console.log("current scope:", new TextDecoder().decode(cur));

// a slice addressed by JSON path
const scope = await job.cmdGetScope("$.OPA");
console.log("$.OPA =", new TextDecoder().decode(scope));
```

Both resolve to a `Uint8Array` of the runtime's reply — decode with a `TextDecoder`.

## Writing to the flow context (context injection)

```ts
await job.cmdSetOnPath(`$["doc appendix"]`, { itemXterm: [1, 3, 42, 2300] });
```

The path is a JSON path into the context tree; the object is the value written there.
This is a `commit` command carrying `{commit_on: path, details: data}`. This is how a
plugin **injects** results that downstream nodes read — distinct from `job.done`,
which emits the node's own output.

## Routing outbound branches

An action can declare `outbound` ports (see [form-builder.md](form-builder.md) /
`Action.outbound`); at runtime the handler chooses which branch(es) fire by naming
their tags. Edges carrying other tags are skipped.

```ts
await job.cmdNextFilter(["approved"]);      // fire only the "approved" branch
```

## Plugin-originated service calls

A handler can call a downstream service itself, mid-job, rather than only emitting
its result at the end:

```ts
const reply = await job.cmdSvcCall("some.service", { q: "term" }, { op: "search" });
console.log(new TextDecoder().decode(reply));
```

`action` names the service, the second argument is the payload, the third is
optional operation metadata (sent as `op`). It publishes to
`inflow.cpu.<PLUGIN_ID>.<JOB_ID>.request/svc.<action>`.

## Signals — when the runtime ends a process

Everything above is the job talking *to* the runtime. The signal port is the one
channel that runs the other way: the runtime publishes on
`inflow.plugin.<PLUGIN_ID>.proc` the moment it stops attending a plugin node process,
saying which job ended and how.

```ts
p.onSignal((sig) => {
  if (sig.kind !== PluginSignal.Proc) return;
  console.log(`job ${sig.jobId} ended: ${sig.conclusion}`);
});
```

Register it **before `start()`** — `start()` does the subscribing. `p.onSignal()`
with no argument installs a handler that just logs the port, handy while developing.

```ts
interface Signal {
  kind: PluginSignal | string; // "proc" — the subject past inflow.plugin.<PLUGIN_ID>.
  subject: string;
  jobId: string;               // the job this is about: the same id as job.jobId
  conclusion: Conclusion | string;
  data: Uint8Array;            // raw payload, for kinds this SDK does not model
  msg: Msg;                    // escape hatch; a signal is a publish — never respond
}
```

`Conclusion` lists every verdict (see
[protocol-inflowv1.md](protocol-inflowv1.md#inflowplugin--signal-port-one-way-optional)),
and two helpers read it:

| Helper | True for |
|--------|----------|
| `succeeded(sig.conclusion)` | `done`, `next` — the job ended the way it intended. |
| `canceled(sig.conclusion)`  | `flow_stop_by_user`, `stop_command`, `timeout`, `long_time_without_command` — something outside the job cut it short. |

### Why this is optional, and why stopping is not the default

**A stopped process does not mean a stopped job.** When a user cancels a flow or a
workflow times out, the work the plugin took on deliberately keeps running. A later
process on the same node may rely on the progress this one made: the runtime hands
the previous `jobId` back in `_registry`, so a half-built export, an open import
cursor or a warmed cache is an asset, not garbage.

So the SDK does nothing about `proc` signals unless you ask. A plugin that never
calls `onSignal` behaves exactly as it always has — **nothing breaks by ignoring
this**. Register a handler only for work that genuinely must not outlive the process:
a stream to close, an upstream request to abort, a lock or reservation to release.

File cancellable work under its `jobId` and let the signal find it:

```ts
import { canceled } from "@inflowenger/node-plugin-sdk";

const inflight = new Map<string, AbortController>();

p.onSignal((sig) => {
  if (!canceled(sig.conclusion)) return; // done / next / failed — nothing to abort
  inflight.get(sig.jobId)?.abort();
  inflight.delete(sig.jobId);
});

p.addAction({
  method: "long.export",
  requestHandler: async (job) => {
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

Two things to keep in mind:

- **Signals arrive for every ending, including `done`.** Filter on `conclusion`.
- **The runtime is already gone.** By the time the signal lands, that job's command
  subjects have no responder: a `progress` or `done` from the abandoned handler will
  retry and fail. Wind the work down; do not try to report it.

Handlers are invoked without being awaited (so a slow one does not stall the port)
and a rejection inside one is caught and logged. Only the last registered handler is
kept.

## Command reference

| Method | Command subject suffix | Payload → | Resolves to |
|--------|------------------------|-----------|-------------|
| `progress(pct, frame)`      | `progress`        | `{progress, frame}` | ack bytes |
| `done(data, ...key)`        | `progress`        | `{progress:100, details, commit_on}` | ack bytes |
| `doneWithError(msg)`        | `progress`        | `{progress:100, error:{message}}` | ack bytes |
| `doneWithErrorData(msg, data, ...key)` | `progress` | `{progress:100, details, commit_on, error:{message}}` | ack bytes |
| `doneWithErrorCode(code, msg, data, ...key)` | `progress` | `{progress:100, details, commit_on, error:{code,message}}` | ack bytes |
| `cmdGetCurrentScope()`      | `context/current` | — | context bytes |
| `cmdGetScope(jsonPath)`     | `context/path`    | `jsonPath` | context bytes |
| `cmdSetOnPath(jsonPath, o)` | `commit`          | `{commit_on, details}` | ack bytes |
| `cmdNextFilter(tags)`       | `next_tags`       | `tags.join(",")` | ack bytes |
| `cmdSvcCall(action, data, op)` | `request/svc.<action>` | `{data, op}` | reply bytes |

## A complete handler

```ts
p.addAction({
  method: "fn",
  requestHandler: async (job: Job) => {
    // read context
    console.log("current:", new TextDecoder().decode(await job.cmdGetCurrentScope()));
    console.log("$.OPA:", new TextDecoder().decode(await job.cmdGetScope("$.OPA")));

    // write context
    await job.cmdSetOnPath(`$["doc appendix"]`, { itemXterm: [1, 3, 42, 2300] });

    // finish
    await job.done({ action: "done finally...." });
  },
});
```
