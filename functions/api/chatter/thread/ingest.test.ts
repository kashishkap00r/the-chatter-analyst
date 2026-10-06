import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchTextFromUrl } from './ingest';

const EDITION_URL = 'https://thechatter.zerodha.com/p/the-chatter-rbi-tata-steel-m-and';

const htmlResponse = (body: string): Response =>
  new Response(body, { status: 200, headers: { 'content-type': 'text/html' } });

const statusResponse = (status: number, headers: Record<string, string> = {}): Response =>
  new Response('rate limited', { status, headers });

const stubFetch = (responses: Response[]): { calls: () => number } => {
  let index = 0;
  const spy = vi.fn(async () => {
    const response = responses[Math.min(index, responses.length - 1)];
    index += 1;
    return response.clone();
  });
  vi.stubGlobal('fetch', spy);
  return { calls: () => spy.mock.calls.length };
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('fetchTextFromUrl', () => {
  it('recovers when Substack returns a transient 429 before succeeding', async () => {
    const tracker = stubFetch([
      statusResponse(429),
      htmlResponse('<article><p>Tata Steel said margins improved.</p></article>'),
    ]);

    const text = await fetchTextFromUrl(EDITION_URL);

    expect(text).toContain('Tata Steel said margins improved.');
    expect(tracker.calls()).toBe(2);
  });

  it('retries transient 5xx responses from the Substack edge', async () => {
    const tracker = stubFetch([
      statusResponse(503),
      htmlResponse('<article><p>M&amp;M reported strong tractor volumes.</p></article>'),
    ]);

    const text = await fetchTextFromUrl(EDITION_URL);

    expect(text).toContain('tractor volumes');
    expect(tracker.calls()).toBe(2);
  });

  it('gives up after exhausting attempts and reports the rate limit status', async () => {
    const tracker = stubFetch([statusResponse(429)]);

    await expect(fetchTextFromUrl(EDITION_URL)).rejects.toThrow(/429/);
    expect(tracker.calls()).toBeGreaterThan(1);
  });

  it('does not retry a permanent 404', async () => {
    const tracker = stubFetch([statusResponse(404)]);

    await expect(fetchTextFromUrl(EDITION_URL)).rejects.toThrow(/404/);
    expect(tracker.calls()).toBe(1);
  });
});
