const TRACKER_STATE_URL =
  "https://raw.githubusercontent.com/kashishkap00r/company-chatter/main/data/tracker_state.json";

const handleRequest = async (): Promise<Response> => {
  try {
    const upstream = await fetch(TRACKER_STATE_URL, {
      headers: { "User-Agent": "ChatterAnalyst/1.0" },
    });

    if (!upstream.ok) {
      return new Response(
        JSON.stringify({ error: "Failed to fetch tracker state" }),
        { status: 502, headers: { "content-type": "application/json" } },
      );
    }

    const data = await upstream.text();

    return new Response(data, {
      status: 200,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "public, max-age=300",
        "access-control-allow-origin": "*",
      },
    });
  } catch {
    return new Response(
      JSON.stringify({ error: "Internal error fetching tracker state" }),
      { status: 500, headers: { "content-type": "application/json" } },
    );
  }
};

export const onRequestGet = handleRequest;
