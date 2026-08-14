import { ConfigService } from '@nestjs/config';
import { OverpassClient, OverpassError } from './overpass.client';

const config = (): ConfigService => {
  const values: Record<string, unknown> = {
    OVERPASS_URL: 'https://overpass.example/interpreter',
    OVERPASS_SEARCH_RADIUS_M: 2000,
    OVERPASS_TIMEOUT_MS: 20000,
    OVERPASS_USER_AGENT: 'test-agent',
  };
  return { get: (key: string) => values[key] } as unknown as ConfigService;
};

const jsonResponse = (body: unknown, init: Partial<Response> = {}) =>
  ({
    ok: true,
    status: 200,
    headers: new Headers({ 'content-type': 'application/json' }),
    text: () => Promise.resolve(JSON.stringify(body)),
    ...init,
  }) as Response;

const htmlResponse = (status: number) =>
  ({
    ok: status < 400,
    status,
    headers: new Headers({ 'content-type': 'text/html; charset=utf-8' }),
    text: () => Promise.resolve('<html>rate limited</html>'),
  }) as Response;

describe('OverpassClient', () => {
  let fetchMock: jest.Mock;

  beforeEach(() => {
    fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  it('POSTs an around() query for highway=raceway with an identifying User-Agent', async () => {
    const body = { elements: [] };
    fetchMock.mockResolvedValue(jsonResponse(body));

    const client = new OverpassClient(config());
    await expect(client.fetchRaceways(41.07, 23.51)).resolves.toEqual(body);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://overpass.example/interpreter');
    expect(init.method).toBe('POST');
    expect(init.headers['User-Agent']).toBe('test-agent');
    const decoded = decodeURIComponent(
      (init.body as string).slice('data='.length),
    );
    expect(decoded).toContain(
      'way(around:2000,41.07,23.51)["highway"="raceway"]',
    );
    expect(decoded).toContain('out geom;');
  });

  it('rejects on a non-JSON content-type even when the status is 200', async () => {
    // Hit for real against overpass-api.de: a rate-limited or malformed query
    // can come back as an HTML page under HTTP 200, not just under 4xx.
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'text/html; charset=utf-8' }),
      text: () => Promise.resolve('<html>oops</html>'),
    } as Response);

    const client = new OverpassClient(config());
    await expect(client.fetchRaceways(41.07, 23.51)).rejects.toThrow(
      OverpassError,
    );
  });

  it('rejects on a non-2xx status', async () => {
    fetchMock.mockResolvedValue(htmlResponse(429));

    const client = new OverpassClient(config());
    await expect(client.fetchRaceways(41.07, 23.51)).rejects.toThrow(
      OverpassError,
    );
  });

  it('rejects when the body claims JSON but is not parseable', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      text: () => Promise.resolve('not json'),
    } as Response);

    const client = new OverpassClient(config());
    await expect(client.fetchRaceways(41.07, 23.51)).rejects.toThrow(
      OverpassError,
    );
  });

  it('wraps a network failure as an OverpassError', async () => {
    fetchMock.mockRejectedValue(new Error('network down'));

    const client = new OverpassClient(config());
    await expect(client.fetchRaceways(41.07, 23.51)).rejects.toThrow(
      OverpassError,
    );
  });
});
