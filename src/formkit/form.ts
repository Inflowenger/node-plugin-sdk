// Builds the two documents an Inflowenger form is made of — a JSON Schema for
// the data and a JSON Forms UI Schema for the layout — from a single
// declaration of each field. Mirrors formkit/form.go.
//
// Declaring a field once and generating both documents removes the class of bug
// where the two drift apart (a property renamed in one and not the other), and
// keeps the order of the form in the order of the code.

import type { FormBuilder, Request, Response, Settings } from "../models.js";
import type { Field } from "./field.js";

// section is one run of fields. An untitled section renders its controls
// straight into the top-level layout; a titled one renders them inside a Group.
interface Section {
  title: string;
  fields: Field[];
}

/**
 * Form is a form under construction: the fields it holds, in the order they were
 * added, and the sections they are laid out in. Start from `form()`.
 */
export class Form {
  private title_: string;
  private description = "";
  private submitTo_ = "";
  private sections: Section[] = [];

  constructor(title: string) {
    this.title_ = title;
  }

  /** Set the schema's `description` — a line under the heading. */
  describe(text: string): Form {
    this.description = text;
    return this;
  }

  /**
   * Name the meta function the host calls to validate the form when it is
   * submitted (FormBuilder.submit_to). That handler answers with a Response.
   */
  submitTo(method: string): Form {
    this.submitTo_ = method;
    return this;
  }

  /** Append fields to the form, in the order they will be rendered. */
  add(...fields: Field[]): Form {
    const n = this.sections.length;
    if (n > 0 && this.sections[n - 1].title === "") {
      this.sections[n - 1].fields.push(...fields);
      return this;
    }
    this.sections.push({ title: "", fields });
    return this;
  }

  /**
   * Append a labelled section. Its fields are ordinary properties of the same
   * flat schema — the grouping is layout only, so the data the action receives
   * has no extra nesting.
   */
  group(title: string, ...fields: Field[]): Form {
    this.sections.push({ title, fields });
    return this;
  }

  /** Every field in declaration order, groups flattened. */
  fields(): Field[] {
    const out: Field[] = [];
    for (const s of this.sections) out.push(...s.fields);
    return out;
  }

  /**
   * Report what would make the generated documents wrong: a field with no name,
   * a name used twice, or a custom schema fragment that cannot be serialized.
   */
  validate(): Error | null {
    const seen = new Set<string>();
    for (const field of this.fields()) {
      if (field == null) {
        return new Error(`formkit: form "${this.title_}" has a nil field`);
      }
      if (field.name().trim() === "") {
        return new Error(
          `formkit: form "${this.title_}" has a field with no name`,
        );
      }
      if (seen.has(field.name())) {
        return new Error(
          `formkit: form "${this.title_}" declares "${field.name()}" twice`,
        );
      }
      seen.add(field.name());

      try {
        JSON.stringify(field.schema);
      } catch (err) {
        return new Error(
          `formkit: field "${field.name()}" has a schema that will not marshal: ${String(err)}`,
        );
      }
    }
    return null;
  }

  /** The JSON Schema document as text. */
  schema(): string {
    return mustEncode(this.schemaMap());
  }

  /** The JSON Forms UI Schema document as text. */
  ui(): string {
    return mustEncode(this.uiMap());
  }

  /**
   * The JSON Schema as a map, for callers that go on to edit it — picker
   * rebuilding one property as a drop-down, or splicing in a fragment this
   * package has no vocabulary for.
   */
  schemaMap(): Record<string, unknown> {
    const properties: Record<string, unknown> = {};
    const required: string[] = [];

    for (const field of this.fields()) {
      properties[field.name()] = field.schema;
      if (field.isRequired) required.push(field.name());
    }

    const schema: Record<string, unknown> = { type: "object", properties };
    if (this.title_ !== "") schema.title = this.title_;
    if (this.description !== "") schema.description = this.description;
    if (required.length > 0) schema.required = required;
    return schema;
  }

  /** The UI Schema as a map. */
  uiMap(): Record<string, unknown> {
    const elements: unknown[] = [];
    for (const s of this.sections) {
      const controls = s.fields.map((field) => field.control());
      if (s.title === "") {
        elements.push(...controls);
        continue;
      }
      elements.push({ type: "Group", label: s.title, elements: controls });
    }
    return { type: "VerticalLayout", elements };
  }

  /**
   * Render the form into the FormBuilder an action or a settings profile
   * carries.
   *
   * It throws if validate() fails. Forms are declared at start-up from literals,
   * so a failure here is a programming error that would otherwise reach the user
   * as a dialog that will not render.
   */
  build(): FormBuilder {
    const err = this.validate();
    if (err) throw err;
    return {
      submit_to: this.submitTo_,
      jsonschema: this.schema(),
      jsonui: this.ui(),
    };
  }

  /**
   * Render the form as a plugin settings profile: the same two documents, plus
   * the handler the host calls when the profile is submitted.
   *
   * The handler is a validator, not a store. The platform keeps the profile and
   * ships it back with every call as body.settings, so a plugin that saves it
   * anywhere is keeping a second, staler copy of someone's credentials.
   */
  settings(
    submit: (req: Request) => Response | Promise<Response>,
  ): Settings {
    return { ...this.build(), submitHandler: submit };
  }
}

/**
 * form starts a form. The title is the JSON Schema `title`, which renderers show
 * as the heading of the dialog. (Named `form` because `new` is a reserved word.)
 */
export const form = (title: string): Form => new Form(title);

// mustEncode serializes a document built entirely out of objects, arrays and
// scalars. Anything that can fail here has already been caught by validate.
function mustEncode(document: Record<string, unknown>): string {
  return JSON.stringify(document);
}
