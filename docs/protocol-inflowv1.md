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
| `progress` | `job.progress` / `job.done` / `job.doneWithError` | Report progress `0–100` (100 = finished). |
| `context/current` | `job.cmdGetCurrentScope` | Read the current context scope. |
| `context/path` | `job.cmdGetScope` | Read context by JSON path. |
| `commit` | `job.cmdSetOnPath` | Write data into context at a JSON path (`commit_on`). |
| `next_tags` | `job.cmdNextFilter` | Route outbound ports: keep only the named tags (comma-joined). |
| `request/svc.<ACTION>` | `job.cmdSvcCall` | Call a backend service through the runtime. The action rides in the subject (`request/svc.log`, …); the runtime cuts the prefix and re-issues the request to the bare action on the plugin space. Payload is a `{data, op}` envelope, forwarded with an `origin: plugin:<node title>` header so the backend can refuse ungranted plugin-originated calls. |

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
