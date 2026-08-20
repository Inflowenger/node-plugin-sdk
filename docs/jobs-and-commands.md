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

// Failure — reports the reason as this node's only detail.
await job.doneWithError("upstream returned 500");

// Failure that still carries state — `data` is reported (and committed, at the
// optional key) next to the reason, which always lands on details.error.
await job.doneWithErrorData("rate limited", { cursor, conversation }, "state");
```

All are a `progress` command at `100`: `done` sends `{progress:100, details:data,
commit_on:key}`, and `doneWithError` delegates to `doneWithErrorData`, which merges
`data` with `{error}` (the reason always wins the `error` key). A terminal command's
details **are** what gets committed onto the node's scope, so a bare `doneWithError`
drops anything the node had persisted there — hand it back through `doneWithErrorData`
to keep it. Call exactly one before the handler returns.

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

## Command reference

| Method | Command subject suffix | Payload → | Resolves to |
|--------|------------------------|-----------|-------------|
| `progress(pct, frame)`      | `progress`        | `{progress, frame}` | ack bytes |
| `done(data, ...key)`        | `progress`        | `{progress:100, details, commit_on}` | ack bytes |
| `doneWithError(msg)`        | `progress`        | `{progress:100, details:{error}}` | ack bytes |
| `doneWithErrorData(msg, data, ...key)` | `progress` | `{progress:100, details:{...data, error}, commit_on}` | ack bytes |
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
