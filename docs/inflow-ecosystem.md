# Inflowenger ecosystem — working notes

These are **platform-level** notes (the computational model, node taxonomy, NATS/
spaces, forms, open questions) that are the same regardless of which language SDK you
use. To avoid two copies drifting apart, they are maintained once, in the Go SDK:

➡️ **[the `go-plugin-sdk` copy](https://github.com/Inflowenger/go-plugin-sdk/blob/main/docs/inflow-ecosystem.md)**
is the canonical source. Read it there.

Node-specific facts worth recording here:

- **Wire-compatible.** This SDK implements the same `inflowv1` subjects and payloads
  as the Go SDK, so Node and Go plugins are interchangeable to the runtime. See
  [protocol-inflowv1.md](protocol-inflowv1.md).
- **Distribution.** Installed from git (not the npm registry yet); npm runs the
  `prepare` script to build on install. See the [README](../README.md#installation).
- **Runtime requirements.** Node 18+ (global `fetch`, Web Crypto `randomUUID`), ESM
  only. NATS via the `nats` package and `credsAuthenticator`.
