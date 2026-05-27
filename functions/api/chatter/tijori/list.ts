import { error, json } from "../../../_shared/response";

interface Env {
  TIJORI_API_KEY?: string;
}

const TIJORI_LIST_URL = "https://www.tijoristack.ai/api/v1/concalls/list/";

interface TijoriCompanyInfo {
  name?: string;
  sector?: string;
  slug?: string;
  isin?: string;
}

interface TijoriRawItem {
  company_info?: TijoriCompanyInfo;
  status?: string;
  concall_event_time?: string;
  transcript?: string | null;
  recording_link?: string | null;
}

interface TijoriRawResponse {
  pagination?: Record<string, unknown>;
  data?: TijoriRawItem[];
}

const passthroughKeys = ["offset", "page_size", "mcap", "isin", "upcoming"] as const;

const handleRequest = async (ctx: { request: Request; env: Env }): Promise<Response> => {
  const apiKey = ctx.env.TIJORI_API_KEY;
  if (!apiKey) {
    return error(500, "CONFIG_ERROR", "Tijori API key is not configured.", "MISSING_TIJORI_KEY");
  }

  const incoming = new URL(ctx.request.url);
  const upstream = new URL(TIJORI_LIST_URL);

  for (const key of passthroughKeys) {
    const value = incoming.searchParams.get(key);
    if (value !== null && value !== "") upstream.searchParams.set(key, value);
  }

  const q = incoming.searchParams.get("q")?.trim();
  if (q) upstream.searchParams.set("company_name", q);

  if (!upstream.searchParams.has("page_size")) {
    upstream.searchParams.set("page_size", "30");
  }

  let upstreamResp: Response;
  try {
    upstreamResp = await fetch(upstream.toString(), {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
        "User-Agent": "ChatterAnalyst/1.0",
      },
    });
  } catch {
    return error(502, "UPSTREAM_ERROR", "Failed to reach Tijori.", "FETCH_FAILED");
  }

  if (!upstreamResp.ok) {
    return error(
      502,
      "UPSTREAM_ERROR",
      `Tijori responded ${upstreamResp.status}.`,
      "UPSTREAM_NON_OK",
    );
  }

  let payload: TijoriRawResponse;
  try {
    payload = (await upstreamResp.json()) as TijoriRawResponse;
  } catch {
    return error(502, "UPSTREAM_ERROR", "Tijori response was not JSON.", "BAD_JSON");
  }

  const items = Array.isArray(payload.data) ? payload.data : [];
  const data = items.map((item) => ({
    slug: item.company_info?.slug ?? "",
    name: item.company_info?.name ?? "Unknown",
    sector: item.company_info?.sector ?? "",
    isin: item.company_info?.isin ?? "",
    concall_event_time: item.concall_event_time ?? "",
    transcript:
      typeof item.transcript === "string" && item.transcript.length > 0 ? item.transcript : "",
    status: item.status ?? "",
  }));

  return json({
    pagination: payload.pagination ?? {},
    data,
  });
};

export const onRequestGet = handleRequest;
