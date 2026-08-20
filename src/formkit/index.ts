// formkit — builds an Inflowenger form's JSON Schema + JSON Forms UI Schema from
// a single declaration of each field. The Node port of the Go `formkit` package.
//
// The package is additive and optional: nothing in the core SDK imports it, and
// what it produces is ordinary schema text, so a plugin may build every form
// with it, build one and hand-write the next, or use only picker/formData/the
// Notification helpers against raw schema strings it wrote by hand.
//
//   import { formkit } from "@inflowenger/node-plugin-sdk";
//
//   const form = formkit.form("Create issue").add(
//     formkit.text("projectKey", "Project key").required()
//       .lookup("jira.meta.project.resolve", "Find").picks("jira.issue.create"),
//     formkit.text("summary", "Summary").required(),
//     formkit.textArea("description", "Description"),
//   ).build();

export { Form, form } from "./form.js";
export {
  Field,
  scopeOf,
  text,
  textArea,
  secret,
  integer,
  number,
  bool,
  date,
  dateTime,
  enumOf,
  choice,
  list,
  listOf,
  custom,
} from "./field.js";
export {
  Notification,
  NotifKey,
  uiKey,
  info,
  success,
  warning,
  failure,
  help,
  oneOf,
  orDefault,
  type Option,
} from "./notification.js";
export { formData, choices, picker, choose, lines } from "./picker.js";
