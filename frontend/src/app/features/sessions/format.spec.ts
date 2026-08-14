import { duration, signedSeconds } from './format';

describe('signedSeconds', () => {
  it('renders an em dash for null', () => {
    expect(signedSeconds(null)).toBe('—');
  });

  it('renders an em dash for undefined', () => {
    expect(signedSeconds(undefined)).toBe('—');
  });

  it('renders a positive delta with a leading plus', () => {
    expect(signedSeconds(184)).toBe('+0.184');
  });

  it('renders a negative delta with a minus sign', () => {
    expect(signedSeconds(-184)).toBe('−0.184');
  });

  it('renders zero as a positive delta', () => {
    expect(signedSeconds(0)).toBe('+0.000');
  });
});

describe('duration', () => {
  it('renders an em dash while the session has not ended', () => {
    expect(duration('2026-08-14T09:00:00Z')).toBe('—');
  });

  it('renders seconds only under a minute', () => {
    expect(duration('2026-08-14T09:00:00Z', '2026-08-14T09:00:45Z')).toBe('45s');
  });

  it('renders minutes and seconds over a minute', () => {
    expect(duration('2026-08-14T09:00:00Z', '2026-08-14T09:32:07Z')).toBe('32m 7s');
  });

  it('renders an em dash for a negative span', () => {
    // A clock-skewed or malformed pair — never shown as a negative duration.
    expect(duration('2026-08-14T09:32:07Z', '2026-08-14T09:00:00Z')).toBe('—');
  });
});
