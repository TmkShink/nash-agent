import { ToolInputError } from "./types.js";

export type ArgumentObject = Readonly<Record<string, unknown>>;

export function parseArgumentObject(
  raw: string,
  allowedKeys: readonly string[],
): ArgumentObject {
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    throw new ToolInputError("tool arguments are not valid JSON");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ToolInputError("tool arguments must be a JSON object");
  }
  const object = value as Record<string, unknown>;
  const allowed = new Set(allowedKeys);
  const unknown = Object.keys(object).find((key) => !allowed.has(key));
  if (unknown !== undefined) {
    throw new ToolInputError(`unknown argument ${JSON.stringify(unknown)}`);
  }
  return object;
}

export function requiredString(
  object: ArgumentObject,
  key: string,
  options: { readonly nonBlank?: boolean } = {},
): string {
  const value = object[key];
  if (typeof value !== "string") {
    throw new ToolInputError(`${key} must be a string`);
  }
  if (options.nonBlank === true && value.trim() === "") {
    throw new ToolInputError(`${key} must not be blank`);
  }
  return value;
}

export function optionalString(
  object: ArgumentObject,
  key: string,
  fallback: string,
): string {
  const value = object[key];
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "string") {
    throw new ToolInputError(`${key} must be a string`);
  }
  return value;
}

export function optionalBoolean(
  object: ArgumentObject,
  key: string,
  fallback: boolean,
): boolean {
  const value = object[key];
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "boolean") {
    throw new ToolInputError(`${key} must be a boolean`);
  }
  return value;
}

export function optionalInteger(
  object: ArgumentObject,
  key: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const value = object[key];
  if (value === undefined) {
    return fallback;
  }
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new ToolInputError(`${key} must be an integer between ${minimum} and ${maximum}`);
  }
  return value as number;
}

export function objectSchema(
  properties: Readonly<Record<string, unknown>>,
  required: readonly string[] = [],
): Readonly<Record<string, unknown>> {
  return required.length === 0
    ? { type: "object", properties, additionalProperties: false }
    : { type: "object", properties, required, additionalProperties: false };
}
