// Messages, options, and the reserved UI keys. Mirrors formkit/lookup.go.

/**
 * uiKey is the UI Schema extension that hangs a button off a control. It is read
 * by the Inflowenger JSON Forms renderer set; a renderer that does not know it
 * ignores it and draws a plain field, which is the correct fallback — every
 * field a button fills stays typable.
 */
export const uiKey = "x-inflow-ui";

/**
 * NotifKey is the reserved key a message travels under, both in a form (on a
 * control, as the messages that field shows from the moment it renders) and in a
 * meta function's answer (as what the lookup has to say about what it just did).
 *
 * The host lifts it out of an answer, so it is not form data: no schema declares
 * it and no action receives it.
 */
export const NotifKey = "x-inflow-notif";

/**
 * Notification is one thing to say about a field. The host decides where it
 * appears — inline under the control, a toast, a dialog — so this side says only
 * what happened and how much it matters.
 *
 * `field` is optional: a message answering a button defaults to the field that
 * button targets, which is what almost every message is about.
 *
 * Only the properties that are set are serialized (mirroring Go's omitempty), so
 * unset fields are left undefined rather than empty strings.
 */
export class Notification {
  severity?: string;
  message?: string;
  field?: string;
  display?: string;

  constructor(init: {
    severity?: string;
    message?: string;
    field?: string;
    display?: string;
  } = {}) {
    if (init.severity !== undefined) this.severity = init.severity;
    if (init.message !== undefined) this.message = init.message;
    if (init.field !== undefined) this.field = init.field;
    if (init.display !== undefined) this.display = init.display;
  }

  /** Point the message at a named field instead of the one the button targets. */
  about(field: string): Notification {
    return new Notification({ ...this, field });
  }

  /**
   * Patch is the answer a button handler returns when it resolved a value: the
   * fields to write into the open form, plus this message.
   *
   * Keys are absolute leaf paths — patching a nested object replaces it
   * wholesale rather than merging into it.
   *
   *   return formkit.success("Issue: %s", key).patch({ issueKey: key });
   *
   * A message on its own is a valid answer: a connection test writes nothing,
   * and saying so is the entire point of the button.
   *
   *   return formkit.failure("cannot reach %s: %s", site, err).patch(null);
   */
  patch(values: Record<string, unknown> | null): Record<string, unknown> {
    const out: Record<string, unknown> = { ...(values ?? {}) };
    out[NotifKey] = this;
    return out;
  }
}

// say formats a message like Go's fmt.Sprintf, supporting the common %s / %d /
// %v verbs a plugin uses. Extra args past the verbs are ignored, matching how
// callers pass a single formatted string most of the time.
function format(fmt: string, args: unknown[]): string {
  let i = 0;
  return fmt.replace(/%[sdvf%]/g, (verb) => {
    if (verb === "%%") return "%";
    const arg = args[i++];
    return String(arg);
  });
}

function say(severity: string, fmt: string, args: unknown[]): Notification {
  return new Notification({ severity, message: format(fmt, args) });
}

/** Info is guidance: what to fill in first, what the button will do next. */
export const info = (fmt: string, ...args: unknown[]): Notification =>
  say("info", fmt, args);

/** Success confirms what a lookup found, next to the value it just wrote. */
export const success = (fmt: string, ...args: unknown[]): Notification =>
  say("success", fmt, args);

/** Warning is a search that ran and found nothing. */
export const warning = (fmt: string, ...args: unknown[]): Notification =>
  say("warning", fmt, args);

/** Failure is the remote service or the connection saying no. */
export const failure = (fmt: string, ...args: unknown[]): Notification =>
  say("error", fmt, args);

/** Help is a standing hint the field carries from the moment it renders. */
export const help = (fmt: string, ...args: unknown[]): Notification =>
  say("help", fmt, args);

/**
 * Option is one candidate a lookup matched, or one entry of a Choice: the value
 * the API needs, and the label a human recognises.
 */
export interface Option {
  value: string;
  label?: string;
}

/** oneOf renders options as JSON Schema `oneOf` entries ({const,title}). */
export function oneOf(options: Option[]): unknown[] {
  return options.map((option) => ({
    const: option.value,
    title: option.label && option.label !== "" ? option.label : option.value,
  }));
}

export function orDefault(value: string | undefined, fallback: string): string {
  return value && value !== "" ? value : fallback;
}
