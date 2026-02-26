export interface SharedErrorShape {
  code: string;
  message: string;
  reasonCode?: string;
  details?: unknown;
}

export interface SharedErrorEnvelope {
  error: SharedErrorShape;
}

export const json = (payload: unknown, status = 200): Response =>
  new Response(JSON.stringify(payload), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
    },
  });

export const error = (
  status: number,
  code: string,
  message: string,
  reasonCode?: string,
  details?: unknown,
): Response =>
  json(
    {
      error: {
        code,
        message,
        reasonCode,
        details,
      },
    } satisfies SharedErrorEnvelope,
    status,
  );
