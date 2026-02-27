interface UpstreamRateLimitOptions {
  includeFreeTierRateLimitToken?: boolean;
  extraNeedles?: string[];
}

interface UpstreamTransientOptions {
  includeStatusCode524?: boolean;
  extraStatusNeedles?: string[];
}

export const extractRetryAfterSeconds = (message: string): number | null => {
  const match = message.match(/retry in\s+([\d.]+)s/i);
  if (!match) return null;
  const parsed = Number(match[1]);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.max(1, Math.ceil(parsed));
};

export const isUpstreamRateLimit = (message: string, options: UpstreamRateLimitOptions = {}): boolean => {
  const normalized = message.toLowerCase();
  const needles = [
    "429",
    "quota",
    "rate limit",
    "too many requests",
    "resource exhausted",
  ];

  if (options.includeFreeTierRateLimitToken) {
    needles.push("generate_content_free_tier_requests");
  }
  if (Array.isArray(options.extraNeedles)) {
    for (const needle of options.extraNeedles) {
      if (needle) {
        needles.push(needle.toLowerCase());
      }
    }
  }

  return needles.some((needle) => normalized.includes(needle));
};

export const isSchemaConstraintError = (message: string): boolean => {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("too many states") ||
    normalized.includes("specified schema produces a constraint")
  );
};

export const isOverloadError = (message: string): boolean => {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("503") ||
    normalized.includes("overload") ||
    normalized.includes("high demand") ||
    normalized.includes("temporarily unavailable")
  );
};

export const isTimeoutError = (message: string): boolean => {
  const normalized = message.toLowerCase();
  return normalized.includes("timed out") || normalized.includes("timeout");
};

export const isLocationUnsupportedError = (message: string): boolean => {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("user location is not supported for the api use") ||
    normalized.includes("location is not supported for the api use")
  );
};

export const isStructuredOutputError = (message: string): boolean => {
  const normalized = message.toLowerCase();
  return normalized.includes("invalid json") || normalized.includes("empty response");
};

export const isImageProcessingError = (message: string): boolean =>
  message.toLowerCase().includes("unable to process input image");

export const isUpstreamTransientError = (message: string, options: UpstreamTransientOptions = {}): boolean => {
  if (isOverloadError(message) || isTimeoutError(message)) {
    return true;
  }

  const statusNeedles = ["500", "502", "504"];
  if (options.includeStatusCode524) {
    statusNeedles.push("524");
  }
  if (Array.isArray(options.extraStatusNeedles)) {
    for (const statusNeedle of options.extraStatusNeedles) {
      if (statusNeedle) {
        statusNeedles.push(statusNeedle);
      }
    }
  }

  return statusNeedles.some((statusNeedle) => message.includes(statusNeedle));
};

export const getPrimarySecondaryTertiaryAttemptOrder = (
  requestedModel: string,
  primaryModel: string,
  secondaryModel: string,
  tertiaryModel: string,
): string[] => {
  if (requestedModel === primaryModel) {
    return [primaryModel, secondaryModel, tertiaryModel];
  }
  if (requestedModel === secondaryModel) {
    return [secondaryModel, primaryModel, tertiaryModel];
  }
  return [tertiaryModel, secondaryModel, primaryModel];
};

export const getPrimaryBackupAttemptOrder = (
  requestedModel: string,
  primaryModel: string,
  backupModel: string,
): string[] => {
  if (requestedModel === primaryModel) {
    return [primaryModel, backupModel];
  }
  return [backupModel, primaryModel];
};
