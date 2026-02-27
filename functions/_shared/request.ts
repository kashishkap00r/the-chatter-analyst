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

export const readContentLength = (request: Request): number => {
  const parsed = Number(request.headers.get("content-length") || "0");
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return parsed;
};

export const isContentLengthOverLimit = (contentLength: number, maxBodyBytes: number): boolean =>
  contentLength > maxBodyBytes;

interface ReadBodyResult {
  ok: boolean;
  reason?: JsonBodyParseFailureReason;
  text?: string;
  bytesRead: number;
}

const readBodyTextWithLimit = async (
  request: Request,
  maxBodyBytes: number,
): Promise<ReadBodyResult> => {
  if (!request.body) {
    return {
      ok: true,
      text: "",
      bytesRead: 0,
    };
  }

  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  const textChunks: string[] = [];
  let bytesRead = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;

      bytesRead += value.byteLength;
      if (bytesRead > maxBodyBytes) {
        await reader.cancel();
        return {
          ok: false,
          reason: "BODY_TOO_LARGE",
          bytesRead,
        };
      }

      textChunks.push(decoder.decode(value, { stream: true }));
    }
    textChunks.push(decoder.decode());
  } catch {
    return {
      ok: false,
      reason: "INVALID_JSON",
      bytesRead,
    };
  } finally {
    reader.releaseLock();
  }

  return {
    ok: true,
    text: textChunks.join(""),
    bytesRead,
  };
};

export const parseJsonBodyWithLimit = async <T = any>(
  request: Request,
  maxBodyBytes: number,
): Promise<JsonBodyParseResult<T>> => {
  const contentLength = readContentLength(request);
  if (isContentLengthOverLimit(contentLength, maxBodyBytes)) {
    return { ok: false, reason: "BODY_TOO_LARGE", contentLength };
  }

  const bodyText = await readBodyTextWithLimit(request, maxBodyBytes);
  if (!bodyText.ok) {
    return {
      ok: false,
      reason: bodyText.reason || "INVALID_JSON",
      contentLength: Math.max(contentLength, bodyText.bytesRead),
    };
  }

  try {
    const body = JSON.parse(bodyText.text || "") as T;
    return {
      ok: true,
      body,
      contentLength: Math.max(contentLength, bodyText.bytesRead),
    };
  } catch {
    return {
      ok: false,
      reason: "INVALID_JSON",
      contentLength: Math.max(contentLength, bodyText.bytesRead),
    };
  }
};
