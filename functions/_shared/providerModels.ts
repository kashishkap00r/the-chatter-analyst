export const GEMINI_PROVIDER = "gemini" as const;
export const OPENROUTER_PROVIDER = "openrouter" as const;

export type Provider = typeof GEMINI_PROVIDER | typeof OPENROUTER_PROVIDER;

export interface ProviderModelDefaults {
  gemini: string;
  openrouter: string;
}

export interface ProviderModelAllowList {
  gemini: ReadonlySet<string>;
  openrouter: ReadonlySet<string>;
}

export const parseProvider = (
  value: unknown,
  defaultProvider: Provider = GEMINI_PROVIDER,
): Provider | "" => {
  if (typeof value !== "string") return defaultProvider;

  const normalized = value.trim().toLowerCase();
  if (normalized === GEMINI_PROVIDER) return GEMINI_PROVIDER;
  if (normalized === OPENROUTER_PROVIDER) return OPENROUTER_PROVIDER;
  return "";
};

export const resolveRequestedModel = (
  requestedModel: unknown,
  provider: Provider,
  defaults: ProviderModelDefaults,
): string => {
  if (typeof requestedModel === "string" && requestedModel.trim()) {
    return requestedModel.trim();
  }

  return provider === OPENROUTER_PROVIDER ? defaults.openrouter : defaults.gemini;
};

export const isAllowedProviderModel = (
  provider: Provider,
  model: string,
  allowList: ProviderModelAllowList,
): boolean =>
  provider === OPENROUTER_PROVIDER ? allowList.openrouter.has(model) : allowList.gemini.has(model);
