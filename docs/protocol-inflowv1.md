# The `inflowv1` protocol

`inflowv1` is the contract between the Inflowenger runtime (Fractal) and a plugin,
carried over NATS request/reply. This Node SDK implements the **same v1 protocol** as
`go-plugin-sdk` — identical subjects and payloads — so a Node plugin and a Go plugin
are interchangeable from the runtime's view. Everything below is namespaced by the
plugin's `PLUGIN_ID`.

## Subject map

Two conventions classify every subject, and they carry the meaning:

- **`@`-prefixed segments are the UI / arguments plane.** `@intro`, `@settings`,
  `@actions`, `@form` describe how the node presents and configures itself. Metadata
  lookups; nothing executes.
- **`inflow.cpu.*` is the execution plane.** The `cpu` family is the **main call**:
  the actual function the Fractal requests at **runtime**, plus the job commands that
  call back while it runs.
- **`inflow.plugin.*` is the signal port.** One-way, fire-and-forget broadcasts *out
  of* the runtime about processes it ran. Nothing there is a request, and a plugin
  need not listen at all.

### `inflow.v1.*` — metadata / UI & arguments plane (the `@` subjects)

| Subject | Direction | Purpose | Response |
|---------|-----------|---------|----------|
| `inflow.v1.<PLUGIN_ID>.@intro` | runtime → plugin | Ask who the plugin is. | `PluginIntro` JSON |
| `inflow.v1.<PLUGIN_ID>.@settings` | runtime → plugin | Fetch the settings form. | `Settings` form JSON (or empty) |
| `inflow.v1.<PLUGIN_ID>.@actions` | runtime → plugin | List all actions. | `Action[]` JSON |
| `inflow.v1.<PLUGIN_ID>.<ACTION>.@form` | runtime → plugin | Fetch one action's form. | `FormBuilder` JSON |
| `inflow.v1.<PLUGIN_ID>.<META>` | runtime → plugin | Call a meta function / submit settings. | `Response` JSON |

### `inflow.cpu.*` — execution plane (invoked by Fractal)

| Subject | Direction | Purpose | Response |
|---------|-----------|---------|----------|
| `inflow.cpu.<PLUGIN_ID>.<ACTION>` | runtime → plugin | **Execute** an action. Starts a job. | `{"jobId":"<uuid>"}` (immediate ack) |
| `inflow.cpu.<PLUGIN_ID>.<JOB_ID>.<CMD>` | plugin → runtime | A running job's command. | command-specific |

Job command `<CMD>` values:

| `<CMD>` | Sent by | Meaning |
|---------|---------|---------|
| `progress` | `job.progress` / `job.done` / `job.doneWithError` | Report progress `0–100` (100 = finished). A terminal payload carrying `error:{code,message}` finishes the job as failed. |
| `context/current` | `job.cmdGetCurrentScope` | Read the current context scope. |
| `context/path` | `job.cmdGetScope` | Read context by JSON path. |
| `commit` | `job.cmdSetOnPath` | Write data into context at a JSON path (`commit_on`). |
| `next_tags` | `job.cmdNextFilter` | Route outbound ports: keep only the named tags (comma-joined). |
| `request/svc.<ACTION>` | `job.cmdSvcCall` | Call a backend service through the runtime. The action rides in the subject (`request/svc.log`, …); the runtime cuts the prefix and re-issues the request to the bare action on the plugin space. Payload is a `{data, op}` envelope, forwarded with an `origin: plugin:<node title>` header so the backend can refuse ungranted plugin-originated calls. |

### `inflow.plugin.*` — signal port (one-way, optional)

| Subject | Direction | Purpose | Response |
|---------|-----------|---------|----------|
| `inflow.plugin.<PLUGIN_ID>.proc` | runtime → plugin | Announce that a plugin node **process has ended**, and how. | none — it is a `publish`, not a request |

Payload:

```json
{ "conclusion": "flow_stop_by_user", "jobId": "9f0c1f8e-…" }
```

`jobId` is the same uuid the plugin minted in the handshake below, so a signal can be
matched to work the plugin still has in flight. `conclusion` is the runtime's verdict:

| `conclusion` | Meaning |
|--------------|---------|
| `done` | The job reported progress 100 and its details were committed. |
| `next` | The process ended on a routing command (`next_tags`). |
| `flow_stop_by_user` / `stop_command` | A user (or a stop command) halted the flow. |
| `timeout` | The workflow's deadline expired while the job ran. |
| `long_time_without_command` | The node's idle window passed with no command from the plugin. |
| `bad_request` | A command carried a payload or path the runtime refused. |
| `anomaly_request` | The job issued an abnormal number of commands (>1500) and was cut off. |
| `failure` / `internal_error` | The flow failed, or the runtime failed on its own side. |
| `plugin_not_responded` | The plugin never acknowledged the execution request with a `jobId`. |
| `unknow_cause` | Cancelled with no recognizable cause (spelling is the runtime's). |

Because this is a **broadcast about every ending**, not a cancellation callback:

- A `proc` signal arrives for successful processes too — switch on `conclusion`.
- Once it is out, the runtime has stopped listening on that job's command subjects:
  a handler still running will find no responder for `progress`, `commit` or a
  context read.

The SDK subscribes to the whole port with a wildcard (`inflow.plugin.<PLUGIN_ID>.>`)
so a future signal kind reaches the same handler. SDK side: `p.onSignal(...)`, see
[jobs-and-commands.md § Signals](jobs-and-commands.md#signals--when-the-runtime-ends-a-process).

## The request → job handshake

Execution is two-phase so the runtime gets a fast acknowledgement while the work runs
asynchronously:

```
runtime                         plugin
  │  REQUEST inflow.cpu.<id>.<act> │  subscribe handler fires
  │───────────────────────────────►│  • mint jobId (randomUUID)
  │  REPLY {"jobId":"<uuid>"}      │  • accept(msg): reply immediately
  │◄───────────────────────────────│
  │                                │  requestHandler(job) runs now
  │  REQUEST inflow.cpu.<id>.<job>.progress  {progress:20,...}
  │◄───────────────────────────────│
  │  REQUEST inflow.cpu.<id>.<job>.context/path  "$.OPA"  ─► REPLY <ctx bytes>
  │  REQUEST inflow.cpu.<id>.<job>.progress  {progress:100, details:{...}}  (job.done)
```

## Request payload shape

```json
{
  "_registry": { "jobId": "…", "doneAt": 1782773013, "…": "…" },
  "body":      { "…": "action-specific input from the node's form" }
}
```

- **`body`** — user-supplied input, shaped by the action's form (JSON Schema).
- **`_registry`** — runtime metadata, notably this node's **previous** run.

Parse it with the generic helper:

```ts
type Input = { url: string; method: string };
const req = castRequestTo<Input>(job.req.data);
// req.body      -> Input
// req._registry -> Record<string, unknown>
```

Unlike Go's `CastRequestTo` (which returns `[value, error]`), the Node
`castRequestTo` **throws** on invalid JSON — wrap it in `try/catch` and call
`job.doneWithError(...)` on failure.

## Response shapes

- **Metadata lookups** reply with the marshalled declaration (`PluginIntro`,
  `Action[]`, `FormBuilder`, …).
- **Meta functions & settings submit** reply with a `Response`:
  ```ts
  interface Response { data?: Record<string, unknown>; error?: unknown; }
  ```
- **Job commands** reply with raw command output — context bytes for reads, an ack
  otherwise. Job methods return the reply as a `Uint8Array`.

## Transport details

- **Request/reply with retry.** `Plugin.send` uses NATS request/reply with a 3s
  timeout and retries up to 5 times on "no responders" (backing off), mirroring the
  Go SDK.
- **Credentials.** The connection authenticates with a decorated NATS `.creds` blob
  (JWT + NKey seed), supplied **base64-encoded** in `INFRA_CRED`. The SDK decodes it,
  reads the account from the JWT, and connects with auto-reconnect via
  `credsAuthenticator`. See [`../src/nats.ts`](../src/nats.ts).

## Protocol versioning

The `v1` in the subject prefix (`inflow.v1.*`) is the protocol version. A future
revision would introduce `inflow.v2.*` subjects, so plugins and runtimes can migrate
independently.
