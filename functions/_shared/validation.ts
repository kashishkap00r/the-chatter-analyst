export const hasNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

export const isInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value);
