// Job command names — the <CMD> segment of inflow.cpu.<PLUGIN_ID>.<JOB_ID>.<CMD>.
// Mirrors sdkv1/types.go.
export enum Command {
  Progress = "progress",
  ContextCurrent = "context/current",
  ContextPath = "context/path",
  Commit = "commit",
  /** next_tags — fire only the outbound branch(es) whose tags are named. */
  NextTags = "next_tags",
  /** request/svc — a plugin-originated call to a downstream service. */
  Request = "request/svc",
}
