// Job command names — the <CMD> segment of inflow.cpu.<PLUGIN_ID>.<JOB_ID>.<CMD>.
// Mirrors sdkv1/types.go.
export enum Command {
  Progress = "progress",
  Stop = "stop",
  ContextCurrent = "context/current",
  ContextPath = "context/path",
  Commit = "commit",
}
