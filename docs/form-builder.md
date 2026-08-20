# Form builder — action & settings UIs

Every action can carry a **form**: the dialog a user fills in on the canvas to
configure that node. Settings (onboarding) forms work the same way. Forms are
declarative — the plugin ships JSON, the front end renders it.

## The `FormBuilder`

```ts
interface FormBuilder {
  submit_to?: string;  // optional meta function for live validation
  jsonui?: string;     // the UI Schema (layout / widgets) — a JSON string
  jsonschema?: string; // the JSON Schema (data model / validation) — a JSON string
}
```

- **`jsonschema`** — a standard [JSON Schema](https://json-schema.org) describing the
  data your action expects. Defines fields, types, required-ness, validation. It is
  exactly the shape that arrives back as the `body` of the request.
- **`jsonui`** — a **UI Schema** describing layout (groups, ordering, widgets).
- **`submit_to`** — optionally, the name of a **meta function** to call for live
  validation as the user edits.

> Both `jsonschema` and `jsonui` are **strings** containing JSON (matching the Go
> SDK's wire format). Build them with `JSON.stringify({...})`.

## Rendering: JSON Forms + `x-inflow-ui`

Forms are rendered by [**JSON Forms**](https://jsonforms.io). Inflowenger ships a Vue
3 renderer set, `@inflowenger/inflow-ui`, that extends JSON Forms with custom
`x-inflow-ui` renderers tailored to the canvas. Because it is plain JSON Schema + UI
Schema, any JSON Forms tooling can author or preview a form.

A minimal action form:

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

p.addAction({
  method: "http.call",
  title: "HTTP Call",
  description: "Perform an outbound HTTP request",
  icon: { icon: "mdi-web" },
  form: { jsonschema: schema, jsonui: ui },
  requestHandler: myHandler,
});
```

The runtime fetches this form on demand from
`inflow.v1.<PLUGIN_ID>.http.call.@form`. What the user enters becomes the `body` of
the execution request — keep the schema and your input type in sync.

## Building the two documents: `formkit`

Written by hand, the schema and the UI schema drift: a property is renamed in one
and not the other, a control keeps pointing at a scope that no longer exists, and
the field silently stops rendering. The optional `formkit` namespace removes that
class of bug by generating both from one declaration per field, in the order the
fields are written:

```ts
import { formkit } from "@inflowenger/node-plugin-sdk";

const form = formkit.form("Get issue").add(
  formkit.text("issueKey", "Issue key").required()
    .describe("Issue key or id, e.g. OPS-42")
    .inline(),                                     // messages about the key appear here
  formkit.list("fields", "Fields"),
  formkit.integer("maxResults", "Max results").default(50).between(1, 100),
  formkit.text("issueSearch", "Search issues")
    .lookup("jira.meta.issue.resolve", "Search")   // the ↻ button
    .into("issueKey")                              // …writes into the key field
    .picks("jira.issue.get"),                      // …or rebuilds this form as a drop-down
).build();                                         // → FormBuilder
```

Nothing in the core SDK depends on it and its output is ordinary JSON Schema + UI
Schema text, so it is adopt-per-form: build one form with it and hand-write the
next, or skip the builder entirely and use only the answer helpers below against
forms you already wrote. (`form` rather than `new` because `new` is a reserved
word; `enumOf` rather than `enum` for the same reason.)

| | |
|---|---|
| Fields | `text` `textArea` `secret` `integer` `number` `bool` `date` `dateTime` `enumOf` `choice` `list` `listOf` `custom` |
| Schema | `.required()` `.describe()` `.default()` `.format()` `.min()` `.max()` `.between()` `.set(key, value)` |
| Layout | `Form.add` `Form.group` `.option(key, value)` `.showWhen` `.hideWhen` `.enableWhen` |
| Buttons | `.lookup(fn, label)` `.into(field)` `.picks(method)` `.send(k, v)` `.button(pos, icon)` |
| Messages | `.help()` `.inline()` `.says()` |
| Output | `Form.build()` `Form.settings(handler)` `Form.schema()` `Form.ui()` `Form.schemaMap()` `Form.validate()` |

`.set` and `.option` take any JSON Schema keyword or renderer hint verbatim, and
`custom` takes a whole property fragment — an unusual field never forces the rest
of the form back to hand-written JSON.

`build` throws on what would not render (a duplicate or empty property name, a
fragment that will not serialize). Forms are declared at start-up from literals, so
that is a programming error, not a runtime condition; `Form.validate()` returns it
as an `Error` (or `null`) for forms assembled from data.

### Answering a form button

The same namespace carries the two shapes a lookup handler replies with, and both
work against raw schema strings — including forms written before it existed:

```ts
// One match: patch the field and say what was found.
return formkit.success("Issue: %s — %s", key, summary)
  .patch({ issueKey: key });

// Several: re-render the dialog with that field as a drop-down.
return formkit.choose(action.form, target, options, formkit.formData(call),
  formkit.info("%d issues match — pick one.", options.length));
```

`choose` falls back to listing the candidates as text when the form cannot be
rebuilt, because the alternative is a button that appears to do nothing.
`formData` strips the keys the host adds to the call (`settings`, `value`,
`targetField`, `form`) before the form is echoed back — `settings` above all,
which carries credentials and must never be promoted into data saved onto the
node. `picker` is `choose` with the error thrown instead of handled;
`Notification` / `info` / `success` / `warning` / `failure` / `help` and the
`NotifKey` constant are the message vocabulary, shared by form-time hints and
button answers.

## Settings (onboarding) forms

`requiredParams` registers a plugin-level settings form plus a submit handler —
useful for credentials or config the plugin needs before any action runs:

```ts
p.requiredParams({
  jsonschema: settingsSchema,
  jsonui: settingsUi,
  submit_to: "_settings.config.submit", // default if omitted
  submitHandler: (r) => {
    // validate / persist the submitted settings (r.data)
    return { data: { ok: true } };
  },
});
```

The form is served on `inflow.v1.<PLUGIN_ID>.@settings`; submissions are handled on
`inflow.v1.<PLUGIN_ID>.<submit_to>` and answered with a `Response`.

`formkit` builds this shape too — `formkit.form(...).settings(handler)` returns the
`Settings` object, the same two documents plus the submit handler:

```ts
p.requiredParams(
  formkit.form("Connection").add(
    formkit.text("baseUrl", "Site URL").required(),
    formkit.secret("apiToken", "API token").required()
      .lookup("demo.ping", "Test connection"),
  ).settings((r) => ({ data: { ok: true } })),
);
```

`PluginIntro.settings` is a related, lighter option: a `FormBuilder` attached
directly to the intro, usable as an onboarding stage.

## Meta functions

A **meta function** is a lightweight request/reply handler (not a job) that the
front end can call while a form is open — to check that a URL is reachable, to turn
a typed name into the id an API needs, or to fill dependent fields. Register them
with `addMeta` before `start()`; each is served on
`inflow.v1.<PLUGIN_ID>.<method>`:

```ts
p.addMeta({
  method: "my.meta.ping",
  requestHandler: (r) => ({ data: { ok: true } }),
});
```

The handler returns any JSON-able value and the SDK marshals it **verbatim** — an
object, a map, or a bare array. It is not forced into the `{data, error}` envelope,
and what it should return depends on who is calling:

| Caller | Return |
|---|---|
| `FormBuilder.submit_to` — live validation of a form on submit | a `Response` (`{ data, error }`) |
| An `x-inflow-ui` button on a control — filling fields in | the **patch object**, e.g. `{ projectKey: "OPS" }` (or a `formkit` picker envelope) |

Unlike an action, a meta function is synchronous request/reply with no job,
progress, or context access.

> **Request shape.** A meta call made from a form arrives **flat** — the form's
> fields, plus `settings` and `value`, at the top level — *not* wrapped in the
> action's `{ _registry, body }` envelope. `castRequestTo` therefore returns an
> object whose `body` is undefined here. Decode tolerantly (use `formData` to read
> the form's own fields).
