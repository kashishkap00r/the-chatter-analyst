export type JsonBodyParseFailureReason = "BODY_TOO_LARGE" | "INVALID_JSON";

export type JsonBodyParseResult<T> =
  | {
      ok: true;
      body: T;
      contentLength: number;
    }
  | {
      ok: false;
      reason: JsonBodyParseFailureReason;
      contentLength: number;
    };

export const readContentLength = (request: Request): number =>
  Number(request.headers.get("content-length") || "0");

export const isContentLengthOverLimit = (contentLength: number, maxBodyBytes: number): boolean =>
  contentLength > maxBodyBytes;

export const parseJsonBodyWithLimit = async <T = any>(
  request: Request,
  maxBodyBytes: number,
): Promise<JsonBodyParseResult<T>> => {
  const contentLength = readContentLength(request);
  if (isContentLengthOverLimit(contentLength, maxBodyBytes)) {
    return { ok: false, reason: "BODY_TOO_LARGE", contentLength };
  }

  try {
    const body = (await request.json()) as T;
    return { ok: true, body, contentLength };
  } catch {
    return { ok: false, reason: "INVALID_JSON", contentLength };
  }
};
