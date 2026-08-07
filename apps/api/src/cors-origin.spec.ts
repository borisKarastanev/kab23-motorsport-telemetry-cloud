import { corsOptionsFor } from './cors-origin';

describe('corsOptionsFor', () => {
  it('allowlists the configured origins with credentials', () => {
    expect(corsOptionsFor('http://localhost:4200')).toEqual({
      origin: ['http://localhost:4200'],
      credentials: true,
    });
  });

  it('splits and trims a comma-separated list', () => {
    expect(corsOptionsFor('http://a.test, https://b.test').origin).toEqual([
      'http://a.test',
      'https://b.test',
    ]);
  });

  /**
   * The production setting, and the reason this helper exists. Empty must mean
   * `false` — "send no Access-Control-Allow-Origin" — and never `true`, which is
   * the reflect-any-origin behaviour Phases 0–4 shipped. Same-origin requests
   * from behind nginx do not look for the header at all, so nothing legitimate
   * is lost.
   */
  it('refuses every cross-origin request when nothing is configured', () => {
    expect(corsOptionsFor('')).toEqual({ origin: false, credentials: true });
    expect(corsOptionsFor(undefined)).toEqual({
      origin: false,
      credentials: true,
    });
  });
});
