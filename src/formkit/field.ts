// One property of a form: its JSON Schema entry and the UI Schema control that
// renders it. Mirrors formkit/field.go + the button methods of formkit/lookup.go.

import {
  Notification,
  NotifKey,
  uiKey,
  help as helpNotif,
  oneOf,
  type Option,
} from "./notification.js";

/**
 * Field is one property of a form: its JSON Schema entry, and the UI Schema
 * control that renders it. Both are generated from this one declaration, so a
 * control can never point at a property that is not there.
 *
 * Fields are built by the constructors below and configured by chaining, each
 * method returning the same field:
 *
 *   formkit.integer("maxResults", "Max results").default(50).between(1, 100)
 *
 * Anything this package has no word for goes in verbatim with set() (JSON
 * Schema) or option() (renderer hints).
 */
export class Field {
  /** @internal */ name_: string;
  /** @internal */ schema: Record<string, unknown>;
  /** @internal */ options?: Record<string, unknown>;
  /** @internal */ inflowUI?: Record<string, unknown>;
  /** @internal */ notifs: Notification[] = [];
  /** @internal */ rule?: Record<string, unknown>;
  /** @internal */ isRequired = false;

  constructor(name: string, schema: Record<string, unknown>) {
    this.name_ = name;
    this.schema = schema;
  }

  /** The property name this field writes into. */
  name(): string {
    return this.name_;
  }

  // -------------------------------------------------------------- the schema --

  /** Set the property's `description`: a statement of what the field is. */
  describe(text: string): Field {
    return this.set("description", text);
  }

  /**
   * Add the field to the schema's `required` list. Required means the form
   * cannot be submitted without it, so it is for what the plugin genuinely
   * cannot run without.
   */
  required(): Field {
    this.isRequired = true;
    return this;
  }

  /**
   * The value the form starts with — also what the action receives when the user
   * never touches the field, so it should be the choice that is right most of
   * the time rather than a placeholder.
   */
  default(value: unknown): Field {
    return this.set("default", value);
  }

  /** Set the JSON Schema `format` — date, date-time, uri, email … */
  format(format: string): Field {
    return this.set("format", format);
  }

  /** Set the smallest accepted number. */
  min(value: unknown): Field {
    return this.set("minimum", value);
  }

  /** Set the largest accepted number. */
  max(value: unknown): Field {
    return this.set("maximum", value);
  }

  /** Bound a number on both sides. */
  between(min: unknown, max: unknown): Field {
    return this.min(min).max(max);
  }

  /**
   * Write a JSON Schema keyword verbatim — pattern, minLength, items, and
   * anything else this package has no method for.
   */
  set(key: string, value: unknown): Field {
    this.schema[key] = value;
    return this;
  }

  // ------------------------------------------------------------------ the UI --

  /**
   * Set a JSON Forms renderer hint under the control's `options`, e.g. "multi"
   * for a text area or "slider" for a bounded number.
   */
  option(key: string, value: unknown): Field {
    if (!this.options) this.options = {};
    this.options[key] = value;
    return this;
  }

  /**
   * Render this field only while another field holds the given value — the
   * visibility rule JSON Forms evaluates in the browser, with no round trip.
   *
   * It hides; it does not exclude. A hidden field keeps whatever value it
   * already had, and that value is still submitted.
   */
  showWhen(other: string, is: unknown): Field {
    return this.when("SHOW", other, is);
  }

  /** Inverted showWhen: the field disappears while the other holds that value. */
  hideWhen(other: string, is: unknown): Field {
    return this.when("HIDE", other, is);
  }

  /**
   * Leave the field on screen but grey it out until the other field holds the
   * given value. Prefer it to showWhen when the field's absence would confuse.
   */
  enableWhen(other: string, is: unknown): Field {
    return this.when("ENABLE", other, is);
  }

  private when(effect: string, other: string, is: unknown): Field {
    this.rule = {
      effect,
      condition: {
        scope: scopeOf(other),
        schema: { const: is },
      },
    };
    return this;
  }

  // ----------------------------------------------------------- lookup buttons --

  /**
   * Hang a button off the field that calls one of the plugin's meta functions
   * and patches the answer back into the open form.
   *
   * `fn` is the meta method to call. The host posts the form as it currently
   * stands, plus the settings profile the node is bound to, plus the contents of
   * this control as `value`.
   *
   * The handler answers with a patch (Notification.patch) when it resolved one
   * value, or with a rebuilt form (picker) when the user has to choose.
   */
  lookup(fn: string, label: string): Field {
    this.inflowUI = {
      action: {
        name: "pluginFn",
        fn,
        body: { targetField: this.name_ },
      },
      button: { position: "append", label, icon: "↻" },
    };
    return this;
  }

  /**
   * Point the answer at another property, for a button that fills in a field
   * other than the one it sits on — a search box whose result belongs in the key
   * field beside it.
   */
  into(target: string): Field {
    this.body().targetField = target;
    return this;
  }

  /**
   * Name the action whose form is rebuilt when the lookup finds more than one
   * candidate (see picker). Without it an ambiguous lookup can only list what it
   * found as text; with it, the target field becomes a drop-down.
   */
  picks(method: string): Field {
    this.body().form = method;
    return this;
  }

  /**
   * Add a static value to the body every press of this button posts, for the
   * handlers that serve several fields and need to be told which they answer.
   */
  send(key: string, value: unknown): Field {
    this.body()[key] = value;
    return this;
  }

  /**
   * Override the look of the lookup button: where it sits relative to the control
   * ("append", "prepend") and the icon on it.
   */
  button(position: string, icon: string): Field {
    const button = this.inflowUI?.button as Record<string, unknown> | undefined;
    if (!button) return this;
    if (position !== "") button.position = position;
    if (icon !== "") button.icon = icon;
    return this;
  }

  // body reaches the static body this field's button posts, creating the button
  // scaffolding if lookup() has not been called yet so the chain order does not
  // matter.
  private body(): Record<string, unknown> {
    if (!this.inflowUI) this.lookup("", "");
    const action = this.inflowUI!.action as Record<string, unknown>;
    return action.body as Record<string, unknown>;
  }

  // ---------------------------------------------------------------- messages --

  /**
   * Attach a standing hint to the field — shown from the moment the form
   * renders, unlike anything a lookup reports later.
   */
  help(fmt: string, ...args: unknown[]): Field {
    this.notifs.push(helpNotif(fmt, ...args));
    return this;
  }

  /**
   * Mark the field as the place messages about it are shown.
   *
   * Every lookup needs one somewhere. This is for the fields a *different*
   * control fills in — the key that the search box writes into — whose messages
   * would otherwise collect at the bottom of the form.
   */
  inline(): Field {
    this.notifs.push(new Notification({ display: "inline" }));
    return this;
  }

  /**
   * Attach a message built by hand, for a severity or a target this package's
   * helpers do not cover.
   */
  says(n: Notification): Field {
    this.notifs.push(n);
    return this;
  }

  // ---------------------------------------------------------------------------

  /** control renders the field's UI Schema element. */
  control(): Record<string, unknown> {
    const element: Record<string, unknown> = {
      type: "Control",
      scope: scopeOf(this.name_),
    };
    if (this.options && Object.keys(this.options).length > 0) {
      element.options = this.options;
    }
    if (this.inflowUI && Object.keys(this.inflowUI).length > 0) {
      element[uiKey] = this.inflowUI;
    }
    if (this.rule) {
      element.rule = this.rule;
    }

    // One message is written as an object rather than a one-element array: both
    // are accepted, and the common case should read as the single thing it is.
    if (this.notifs.length === 1) {
      element[NotifKey] = this.notifs[0];
    } else if (this.notifs.length > 1) {
      element[NotifKey] = this.notifs;
    }
    return element;
  }
}

// ------------------------------------------------------------ constructors --

function field(name: string, title: string, jsonType: string): Field {
  const schema: Record<string, unknown> = { type: jsonType };
  if (title !== "") schema.title = title;
  return new Field(name, schema);
}

/** Text is a single-line string. */
export const text = (name: string, title: string): Field =>
  field(name, title, "string");

/**
 * TextArea is a string rendered as a multi-line box. Use it wherever a value can
 * reasonably contain a newline — a comment body, a JSON fragment.
 */
export const textArea = (name: string, title: string): Field =>
  text(name, title).option("multi", true);

/**
 * Secret is a string rendered with its characters masked. Masking is
 * presentation only: the value travels and is stored like any other field. It
 * belongs on a settings profile, not on an action form.
 */
export const secret = (name: string, title: string): Field =>
  text(name, title).option("format", "password");

/** Integer is a whole number. */
export const integer = (name: string, title: string): Field =>
  field(name, title, "integer");

/** Number is a decimal number. */
export const number = (name: string, title: string): Field =>
  field(name, title, "number");

/** Bool is a checkbox. */
export const bool = (name: string, title: string): Field =>
  field(name, title, "boolean");

/** Date is a string holding a calendar date, YYYY-MM-DD. */
export const date = (name: string, title: string): Field =>
  text(name, title).format("date");

/** DateTime is a string holding an RFC 3339 instant. */
export const dateTime = (name: string, title: string): Field =>
  text(name, title).format("date-time");

/**
 * Enum is a fixed set of values, rendered as a drop-down. Use it when the value
 * the API wants is the one a human should read; when they differ, use choice.
 * (Named enumOf because `enum` is a reserved word.)
 */
export const enumOf = (
  name: string,
  title: string,
  ...values: string[]
): Field => text(name, title).set("enum", values.slice());

/**
 * Choice is a drop-down whose entries have two halves: the value the API needs,
 * and the label a human recognises. `oneOf` rather than `enum` because an enum
 * can only carry one of the two.
 */
export const choice = (
  name: string,
  title: string,
  ...options: Option[]
): Field => text(name, title).set("oneOf", oneOf(options));

/** List is an array of strings — the renderer draws add/remove rows. */
export const list = (name: string, title: string): Field =>
  listOf(name, title, "string");

/** ListOf is an array whose items are of the given JSON type. */
export const listOf = (name: string, title: string, itemType: string): Field =>
  field(name, title, "array").set("items", { type: itemType });

/**
 * Custom is a field whose schema this package does not model: pass the JSON
 * Schema fragment for the property and it is used as-is, while the control, the
 * layout position, the lookup button and the messages are still generated.
 *
 * The fragment is taken over, not copied — do not keep editing the map after
 * handing it in.
 */
export const custom = (
  name: string,
  title: string,
  schema: Record<string, unknown> | null,
): Field => {
  const s = schema ?? {};
  if (title !== "") s.title = title;
  return new Field(name, s);
};

/**
 * scopeOf is the JSON-pointer-ish reference a UI Schema uses to name a property.
 * A caller that already wrote one out in full keeps it.
 */
export function scopeOf(name: string): string {
  if (name.length > 0 && name[0] === "#") return name;
  return "#/properties/" + name;
}
