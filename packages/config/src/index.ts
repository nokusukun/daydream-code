import { z } from "zod";

/**
 * The declaration a plugin makes about its own configuration.
 *
 * One declaration produces two things that used to be separate and drift: the
 * zod schema the kernel validates against, and the descriptors a settings UI
 * renders. Deriving both from the same call is the point — a field cannot be
 * validated but unrenderable, or shown but unvalidated, and adding a setting is
 * one edit rather than three.
 *
 * It also carries what a validator structurally cannot: what to call the field
 * in a UI, what changing it does, what unit it is in, whether it is a secret,
 * and whether it needs a relaunch. That information exists in every plugin
 * already, as prose in a doc comment. This puts it somewhere a program can read
 * it.
 */

export type FieldKind = "string" | "number" | "boolean" | "enum" | "list" | "json";

export interface EnumOption {
  value: string;
  label: string;
  help?: string;
}

/** One configurable field, as the settings UI receives it. */
export interface SettingDescriptor {
  name: string;
  kind: FieldKind;
  /** Human label. Lowercase-leaning, like the rest of the app's chrome. */
  label: string;
  /** One line on what changing it does. Shown under the control. */
  help?: string;
  /** Heading this field sits under, when a plugin has enough fields to group. */
  group?: string;
  /** Hidden until the user asks for advanced settings. */
  advanced?: boolean;
  /** Never render in plain text, never log, never include in a diff. */
  secret?: boolean;
  /** Needs a relaunch even when the plugin itself could be hot-reloaded. */
  restart?: boolean;
  /** Omitting it is legal: it has a default, or it is explicitly optional. */
  optional: boolean;
  nullable: boolean;
  default?: unknown;
  /** Numbers: whole only. */
  integer?: boolean;
  min?: number;
  max?: number;
  /** Suffix shown inside the control: "tokens", "ms", "MB". */
  unit?: string;
  /** Shown in an empty text field. */
  placeholder?: string;
  /** Text that wants more than one line. */
  multiline?: boolean;
  options?: EnumOption[];
  /** For `list`: the shape of one item. */
  item?: SettingDescriptor[];
}

/** A field: the schema to validate it and the descriptor to render it. */
export interface FieldDef<T = unknown> {
  readonly schema: z.ZodType<T>;
  readonly descriptor: Omit<SettingDescriptor, "name">;
}

type Common = Pick<
  SettingDescriptor,
  "label" | "help" | "group" | "advanced" | "secret" | "restart"
>;

/**
 * `optional` and `nullable` are typed as the literal `true` rather than as
 * `boolean` so TypeScript keeps the literal when inferring a builder's option
 * object. Declared as `boolean` they would widen, and every field would come
 * back as possibly-undefined.
 */
interface Optionality {
  optional?: true;
  nullable?: true;
}

type Wrapped<T, O extends Optionality> =
  | T
  | (O["optional"] extends true ? undefined : never)
  | (O["nullable"] extends true ? null : never);

function common(options: Common): Common {
  return {
    label: options.label,
    ...(options.help !== undefined ? { help: options.help } : {}),
    ...(options.group !== undefined ? { group: options.group } : {}),
    ...(options.advanced !== undefined ? { advanced: options.advanced } : {}),
    ...(options.secret !== undefined ? { secret: options.secret } : {}),
    ...(options.restart !== undefined ? { restart: options.restart } : {}),
  };
}

/**
 * Apply the optional/default/nullable wrappers in one place, so every builder
 * treats "has a default" and "may be omitted" identically.
 */
function wrap<T>(
  base: z.ZodType<T>,
  options: { default?: unknown; optional?: true; nullable?: true },
): { schema: z.ZodType<unknown>; meta: Pick<SettingDescriptor, "optional" | "nullable" | "default"> } {
  let schema: z.ZodType<unknown> = base as z.ZodType<unknown>;
  const meta: { optional: boolean; nullable: boolean; default?: unknown } = {
    optional: options.optional === true || options.default !== undefined,
    nullable: options.nullable === true,
  };
  if (options.nullable === true) schema = schema.nullable() as z.ZodType<unknown>;
  if (options.default !== undefined) {
    meta.default = options.default;
    schema = (schema as z.ZodType<unknown>).default(
      options.default as never,
    ) as z.ZodType<unknown>;
  } else if (options.optional === true) {
    schema = schema.optional() as z.ZodType<unknown>;
  }
  return { schema, meta };
}

interface StringOptions extends Common, Optionality {
  default?: string;
  minLength?: number;
  maxLength?: number;
  placeholder?: string;
  multiline?: boolean;
}

interface NumberOptions extends Common, Optionality {
  default?: number;
  integer?: boolean;
  min?: number;
  max?: number;
  unit?: string;
}

interface BooleanOptions extends Common, Optionality {
  default?: boolean;
}

interface EnumOptions<T extends string> extends Common, Optionality {
  options: ReadonlyArray<EnumOption & { value: T }>;
  default?: T;
}

interface ListOptions<S extends Record<string, FieldDef>> extends Common, Optionality {
  /** The shape of one item. */
  item: S;
  default?: ReadonlyArray<InferShape<S>>;
}

interface JsonOptions<T> extends Common, Optionality {
  /** Validated with the plugin's own schema; edited as JSON in the UI. */
  schema: z.ZodType<T>;
  default?: T;
}

export const field = {
  string<O extends StringOptions>(options: O): FieldDef<Wrapped<string, O>> {
    let base = z.string();
    if (options.minLength !== undefined) base = base.min(options.minLength);
    if (options.maxLength !== undefined) base = base.max(options.maxLength);
    const { schema, meta } = wrap(base, options);
    return {
      schema: schema as z.ZodType<Wrapped<string, O>>,
      descriptor: {
        kind: "string",
        ...common(options),
        ...meta,
        ...(options.minLength !== undefined ? { min: options.minLength } : {}),
        ...(options.maxLength !== undefined ? { max: options.maxLength } : {}),
        ...(options.placeholder !== undefined ? { placeholder: options.placeholder } : {}),
        ...(options.multiline !== undefined ? { multiline: options.multiline } : {}),
      },
    };
  },

  number<O extends NumberOptions>(options: O): FieldDef<Wrapped<number, O>> {
    let base = z.number();
    if (options.integer === true) base = base.int();
    if (options.min !== undefined) base = base.min(options.min);
    if (options.max !== undefined) base = base.max(options.max);
    const { schema, meta } = wrap(base, options);
    return {
      schema: schema as z.ZodType<Wrapped<number, O>>,
      descriptor: {
        kind: "number",
        ...common(options),
        ...meta,
        ...(options.integer !== undefined ? { integer: options.integer } : {}),
        ...(options.min !== undefined ? { min: options.min } : {}),
        ...(options.max !== undefined ? { max: options.max } : {}),
        ...(options.unit !== undefined ? { unit: options.unit } : {}),
      },
    };
  },

  boolean<O extends BooleanOptions>(options: O): FieldDef<Wrapped<boolean, O>> {
    const { schema, meta } = wrap(z.boolean(), options);
    return {
      schema: schema as z.ZodType<Wrapped<boolean, O>>,
      descriptor: { kind: "boolean", ...common(options), ...meta },
    };
  },

  enum<T extends string, O extends EnumOptions<T>>(options: O & EnumOptions<T>): FieldDef<Wrapped<T, O>> {
    const values = options.options.map((option) => option.value) as [T, ...T[]];
    const { schema, meta } = wrap(z.enum(values) as unknown as z.ZodType<T>, options);
    return {
      schema: schema as z.ZodType<Wrapped<T, O>>,
      descriptor: {
        kind: "enum",
        ...common(options),
        ...meta,
        options: options.options.map((option) => ({ ...option })),
      },
    };
  },

  /** A repeatable row of fields: driver model catalogs, and little else. */
  list<S extends Record<string, FieldDef>, O extends ListOptions<S>>(
    options: O & ListOptions<S>,
  ): FieldDef<Wrapped<Array<InferShape<S>>, O>> {
    const { Config: itemSchema, settings } = defineConfig(options.item);
    const { schema, meta } = wrap(
      z.array(itemSchema) as unknown as z.ZodType<Array<InferShape<S>>>,
      options,
    );
    return {
      schema: schema as z.ZodType<Wrapped<Array<InferShape<S>>, O>>,
      descriptor: { kind: "list", ...common(options), ...meta, item: settings },
    };
  },

  /**
   * An escape hatch for shapes no control can render sensibly. Still validated
   * by the plugin's own schema; the UI edits it as JSON and reports the errors.
   */
  json<T, O extends JsonOptions<T>>(options: O & JsonOptions<T>): FieldDef<Wrapped<T, O>> {
    const { schema, meta } = wrap(options.schema, options);
    return {
      schema: schema as z.ZodType<Wrapped<T, O>>,
      descriptor: { kind: "json", ...common(options), ...meta },
    };
  },
};

type InferField<F> = F extends FieldDef<infer T> ? T : never;

type OptionalKeys<S extends Record<string, FieldDef>> = {
  [K in keyof S]: undefined extends InferField<S[K]> ? K : never;
}[keyof S];

/**
 * A field that may be omitted becomes an optional *key*, not a required key
 * holding `undefined`. Under `exactOptionalPropertyTypes` those are different
 * types, and only the first one accepts an object that simply leaves the field
 * out — which is how every caller actually writes it.
 */
export type InferShape<S extends Record<string, FieldDef>> = {
  [K in Exclude<keyof S, OptionalKeys<S>>]: InferField<S[K]>;
} & {
  [K in OptionalKeys<S>]?: InferField<S[K]>;
};

export interface DefinedConfig<S extends Record<string, FieldDef>> {
  /** The Standard Schema the kernel validates a config row against. */
  Config: z.ZodType<InferShape<S>>;
  /** The same fields, as descriptors for the settings UI. */
  settings: SettingDescriptor[];
}

/**
 * Build a plugin's `Config` and its settings descriptors from one declaration.
 *
 * `.prefault({})` so a row with no `config:` key still loads on defaults, which
 * is what makes most of the base bundle a bare `{ id, name }` pair.
 */
export function defineConfig<S extends Record<string, FieldDef>>(
  shape: S,
): DefinedConfig<S> {
  const zodShape: Record<string, z.ZodType<unknown>> = {};
  const settings: SettingDescriptor[] = [];
  for (const [name, def] of Object.entries(shape)) {
    zodShape[name] = def.schema as z.ZodType<unknown>;
    settings.push({ name, ...def.descriptor });
  }
  const Config = z.object(zodShape).prefault({}) as unknown as z.ZodType<InferShape<S>>;
  return { Config, settings };
}

/** A plugin that declares its settings. Read structurally, never required. */
export interface ConfigurablePlugin {
  Config?: unknown;
  settings?: SettingDescriptor[];
}

/** The descriptors a plugin module declares, if it declares any. */
export function settingsOf(plugin: unknown): SettingDescriptor[] | undefined {
  if (typeof plugin !== "object" && typeof plugin !== "function") return undefined;
  const declared = (plugin as ConfigurablePlugin).settings;
  return Array.isArray(declared) ? declared : undefined;
}

/**
 * The value type a `Config` validates to. Saves every plugin an import of zod
 * purely to write `z.infer<typeof Config>`.
 */
export type ConfigOf<C> = C extends z.ZodType<infer T> ? T : never;
