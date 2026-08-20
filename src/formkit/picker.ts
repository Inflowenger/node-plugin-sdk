// Answering an ambiguous lookup with a form the user can choose from, and the
// text fallback for when the form cannot be rebuilt. Mirrors formkit/picker.go.

import type { FormBuilder } from "../models.js";
import {
  Notification,
  NotifKey,
  oneOf,
  orDefault,
  type Option,
} from "./notification.js";

// hostKeys are the keys the host and the button add to a meta call on top of the
// form's own fields. They are not form data and must not be echoed back into it
// — `settings` above all, which carries the credentials of the target system.
const hostKeys = new Set(["settings", "value", "targetField", "form"]);

/**
 * FormData echoes a meta call's form back unchanged, minus what the host and the
 * button added.
 *
 * A form envelope replaces the form's data wholesale, so the echo has to be
 * exact.
 */
export function formData(
  call: Record<string, unknown>,
): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(call)) {
    if (!hostKeys.has(key)) data[key] = value;
  }
  return data;
}

/**
 * Choices rewrites one property of a JSON Schema into a drop-down of the given
 * candidates, returning the whole schema with that one change.
 *
 * It takes the schema as text, so it works on any form — one built by this
 * package, or one a plugin hand-wrote years ago.
 *
 * `oneOf` rather than `enum` because each candidate needs two halves: the value
 * the API wants, and the label a human recognises. Any `enum` already on the
 * property is dropped, since the two would otherwise be intersected to nothing.
 */
export function choices(
  schemaJSON: string,
  target: string,
  options: Option[],
): Record<string, unknown> {
  let schema: Record<string, unknown>;
  try {
    schema = JSON.parse(schemaJSON) as Record<string, unknown>;
  } catch (err) {
    throw new Error(`formkit: form schema does not parse: ${String(err)}`);
  }

  const properties = schema.properties as
    | Record<string, unknown>
    | undefined;
  const property = properties?.[target] as
    | Record<string, unknown>
    | undefined;
  if (!property) {
    throw new Error(
      `formkit: the form has no property "${target}" to turn into a drop-down`,
    );
  }

  property.oneOf = oneOf(options);
  delete property.enum;
  return schema;
}

/**
 * Picker answers an ambiguous lookup with a form the user can choose from.
 *
 * A field's options live in its JSON Schema, not in the form's data, so the only
 * way to offer a list that did not exist when the plugin was compiled is to
 * answer with a whole new schema. That is what a *form envelope* is: the host
 * re-renders the open dialog as the documents returned here.
 *
 * The returned map carries envelope keys only (schema, uischema, data, and the
 * heading under NotifKey). The host tells a re-render from a field patch by
 * requiring every key to be one of them, so a stray field name here demotes the
 * whole answer back to a patch and nothing re-renders.
 */
export function picker(
  form: FormBuilder,
  target: string,
  options: Option[],
  data: Record<string, unknown>,
  heading: Notification,
): Record<string, unknown> {
  if (!form.jsonschema || form.jsonschema === "") {
    throw new Error("formkit: cannot rebuild a form that has no schema");
  }

  const schema = choices(form.jsonschema, target, options);

  const envelope: Record<string, unknown> = {
    schema,
    uischema: form.jsonui,
    data,
  };
  if (heading.message && heading.message !== "") {
    envelope[NotifKey] = heading;
  }
  return envelope;
}

/**
 * Choose is picker with the fallback every caller wants: when the form cannot be
 * rebuilt — the action was named wrong, the target is not one of its properties
 * — the candidates are reported as text instead.
 *
 * The return type is `unknown` because the two outcomes are different shapes on
 * the wire, which is also why a meta handler returns `unknown`.
 */
export function choose(
  form: FormBuilder,
  target: string,
  options: Option[],
  data: Record<string, unknown>,
  heading: Notification,
): unknown {
  try {
    return picker(form, target, options, data, heading);
  } catch {
    const message = (heading.message ?? "").replace(/\n+$/, "");
    return new Notification({
      severity: orDefault(heading.severity, "info"),
      field: heading.field,
      message: (message + "\n" + lines(options)).trim(),
    }).patch(null);
  }
}

// listed caps how many candidates a text fallback prints.
const listed = 15;

/**
 * Lines renders candidates one per line — the text form of a picker, for the
 * fallback above and for any handler that would rather say what it found than
 * rebuild the dialog.
 */
export function lines(options: Option[]): string {
  const out: string[] = [];
  for (const option of options.slice(0, Math.min(options.length, listed))) {
    const label = option.label && option.label !== "" ? option.label : option.value;
    out.push("  " + label);
  }
  if (options.length > listed) {
    out.push(`  … and ${options.length - listed} more — narrow the search`);
  }
  return out.join("\n");
}
