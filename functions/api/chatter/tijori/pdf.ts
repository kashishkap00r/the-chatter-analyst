import { error } from "../../../_shared/response";

const ALLOWED_HOSTS = new Set([
  "files.tijoristack.ai",
  "files.tijorifinance.com",
  "stockdiscovery.s3.amazonaws.com",
]);

const handleRequest = async (ctx: { request: Request }): Promise<Response> => {
  const incoming = new URL(ctx.request.url);
  const rawUrl = incoming.searchParams.get("url");
  if (!rawUrl) {
    return error(400, "BAD_REQUEST", "Query param 'url' is required.", "MISSING_URL");
  }

  let target: URL;
  try {
    target = new URL(rawUrl);
  } catch {
    return error(400, "BAD_REQUEST", "Invalid URL.", "INVALID_URL");
  }

  if (target.protocol !== "https:" || !ALLOWED_HOSTS.has(target.hostname)) {
    return error(400, "BAD_REQUEST", "Host not allowed.", "HOST_NOT_ALLOWED");
  }

  let upstream: Response;
  try {
    upstream = await fetch(target.toString(), {
      headers: { "User-Agent": "ChatterAnalyst/1.0" },
    });
  } catch {
    return error(502, "UPSTREAM_ERROR", "Failed to fetch PDF.", "FETCH_FAILED");
  }

  if (!upstream.ok || !upstream.body) {
    return error(502, "UPSTREAM_ERROR", `Upstream returned ${upstream.status}.`, "UPSTREAM_NON_OK");
  }

  return new Response(upstream.body, {
    status: 200,
    headers: {
      "content-type": "application/pdf",
      "content-disposition": "inline",
      "cache-control": "public, max-age=3600",
    },
  });
};

export const onRequestGet = handleRequest;
