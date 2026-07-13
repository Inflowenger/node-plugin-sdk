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

`PluginIntro.settings` is a related, lighter option: a `FormBuilder` attached
directly to the intro, usable as an onboarding stage.

## Live validation with meta functions

Setting `submit_to` on an action form names a **meta function** — a lightweight
request/reply handler the front end can call as the user types.

> **Status.** As in the Go SDK, the `Meta` type and its subscription wiring
> (`metaFuncHandler`) exist, but **no public method to register a meta function is
> exported yet**. Use the settings `submitHandler` above, which is fully wired today.
