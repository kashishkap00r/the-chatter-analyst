import { describe, expect, it } from 'vitest';
import { parseJsonBodyWithLimit } from './request';

const makeStreamingJsonRequest = (json: string): Request => {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(json));
      controller.close();
    },
  });

  return new Request('https://example.com/api', {
    method: 'POST',
    body: stream as any,
    duplex: 'half' as any,
    headers: {
      'content-type': 'application/json',
    },
  } as RequestInit);
};

describe('parseJsonBodyWithLimit', () => {
  it('rejects oversized streaming request bodies even without content-length', async () => {
    const request = makeStreamingJsonRequest(JSON.stringify({ text: 'a'.repeat(5000) }));
    const parsed = await parseJsonBodyWithLimit(request, 512);

    expect(parsed.ok).toBe(false);
    if (parsed.ok === false) {
      expect(parsed.reason).toBe('BODY_TOO_LARGE');
    }
  });

  it('rejects invalid JSON payloads', async () => {
    const request = makeStreamingJsonRequest('{"broken":');
    const parsed = await parseJsonBodyWithLimit(request, 2048);

    expect(parsed.ok).toBe(false);
    if (parsed.ok === false) {
      expect(parsed.reason).toBe('INVALID_JSON');
    }
  });

  it('parses valid JSON payloads under limit', async () => {
    const request = makeStreamingJsonRequest(JSON.stringify({ ok: true, value: 42 }));
    const parsed = await parseJsonBodyWithLimit<{ ok: boolean; value: number }>(request, 2048);

    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.body).toEqual({ ok: true, value: 42 });
    }
  });
});
