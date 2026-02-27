export const CHATTER_MAX_RETRIES = 2;
export const POINTS_CHUNK_MAX_RETRIES = 2;
export const PLOTLINE_MAX_RETRIES = 2;

export const CHATTER_RETRY_BASE_DELAY_MS = 1800;
export const POINTS_RETRY_BASE_DELAY_MS = 1200;
export const PLOTLINE_RETRY_BASE_DELAY_MS = 1800;

export const MAX_RETRY_DELAY_MS = 90 * 1000;

export const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const extractHttpStatus = (message: string): number | null => {
  const match = message.match(/status\s+(\d{3})/i);
  if (!match) return null;
  const parsed = Number(match[1]);
  return Number.isInteger(parsed) ? parsed : null;
};

const extractRetryAfterMs = (message: string): number | null => {
  const match = message.match(/retry in\s+([\d.]+)s/i);
  if (!match) return null;
  const parsed = Number(match[1]);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.min(MAX_RETRY_DELAY_MS, Math.ceil(parsed * 1000) + 1200);
};

export const isRateLimitError = (message: string): boolean => {
  const normalized = message.toLowerCase();
  return (
    normalized.includes('429') ||
    normalized.includes('quota') ||
    normalized.includes('rate limit') ||
    normalized.includes('resource_exhausted') ||
    normalized.includes('too many requests')
  );
};

export const getRetryDelayMs = (message: string, retryCount: number, baseDelayMs: number): number => {
  const retryAfter = extractRetryAfterMs(message);
  if (retryAfter) return retryAfter;

  const status = extractHttpStatus(message);
  const multiplier = status === 429 ? 2.4 : 1.85;
  return Math.min(MAX_RETRY_DELAY_MS, Math.round(baseDelayMs * Math.pow(multiplier, retryCount)));
};

export const isRetriableChunkError = (message: string): boolean => {
  const normalized = message.toLowerCase();
  return (
    normalized.includes('429') ||
    normalized.includes('503') ||
    normalized.includes('502') ||
    normalized.includes('timeout') ||
    normalized.includes('temporarily unavailable') ||
    normalized.includes('resource_exhausted') ||
    normalized.includes('rate limit') ||
    normalized.includes('upstream connect error') ||
    normalized.includes('connection reset') ||
    normalized.includes('deadline exceeded')
  );
};

export const isLocationUnsupportedChunkError = (message: string): boolean => {
  const normalized = message.toLowerCase();
  return (
    normalized.includes('upstream_location_unsupported') ||
    normalized.includes('user location is not supported for the api use') ||
    normalized.includes('location is not supported for the api use') ||
    normalized.includes('provider location policy')
  );
};
