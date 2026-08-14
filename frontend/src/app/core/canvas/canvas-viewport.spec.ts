import {
  fitTransform,
  nearestWithin,
  pan,
  screenToWorld,
  worldToScreen,
  zoomAt,
} from './canvas-viewport';

describe('fitTransform', () => {
  it('centres square bounds in a square canvas with no margin', () => {
    const t = fitTransform({ minX: 0, maxX: 10, minY: 0, maxY: 10 }, 100, 100, 0);

    expect(t.scale).toBeCloseTo(10);
    // World centre (5, 5) must map to the canvas centre (50, 50).
    expect(worldToScreen(t, 5, 5)).toEqual({ x: 50, y: 50 });
  });

  it('scales down to fit the narrower canvas dimension, not the wider one', () => {
    // Square content, a canvas twice as wide as it is tall — height governs.
    const t = fitTransform({ minX: 0, maxX: 10, minY: 0, maxY: 10 }, 400, 100, 0);
    expect(t.scale).toBeCloseTo(10);
  });

  it('applies margin as a fraction of the content span', () => {
    const noMargin = fitTransform({ minX: 0, maxX: 10, minY: 0, maxY: 10 }, 100, 100, 0);
    const withMargin = fitTransform({ minX: 0, maxX: 10, minY: 0, maxY: 10 }, 100, 100, 0.1);

    // More padding means the same content is drawn smaller.
    expect(withMargin.scale).toBeLessThan(noMargin.scale);
  });

  it('does not divide by zero on a single-point (degenerate) bounds box', () => {
    const t = fitTransform({ minX: 5, maxX: 5, minY: 5, maxY: 5 }, 100, 100, 0.1);

    expect(Number.isFinite(t.scale)).toBe(true);
    expect(Number.isFinite(t.x)).toBe(true);
    expect(Number.isFinite(t.y)).toBe(true);
  });

  it('returns a safe identity-ish transform when the canvas has no size yet', () => {
    const t = fitTransform({ minX: 0, maxX: 10, minY: 0, maxY: 10 }, 0, 0, 0.1);
    expect(t).toEqual({ scale: 1, x: 0, y: 0 });
  });
});

describe('worldToScreen / screenToWorld', () => {
  it('round-trip through each other', () => {
    const t = { scale: 3.5, x: 12, y: -7 };
    const screen = worldToScreen(t, 41.07, 23.51);
    const world = screenToWorld(t, screen.x, screen.y);

    expect(world.x).toBeCloseTo(41.07);
    expect(world.y).toBeCloseTo(23.51);
  });
});

describe('zoomAt', () => {
  const limits = { min: 0.1, max: 100 };

  it('keeps the world point under the cursor fixed on screen', () => {
    const t = { scale: 1, x: 0, y: 0 };
    const cursor = { x: 150, y: 80 };
    const worldUnderCursorBefore = screenToWorld(t, cursor.x, cursor.y);

    const zoomed = zoomAt(t, cursor.x, cursor.y, 2, limits);
    const screenAfter = worldToScreen(zoomed, worldUnderCursorBefore.x, worldUnderCursorBefore.y);

    expect(screenAfter.x).toBeCloseTo(cursor.x);
    expect(screenAfter.y).toBeCloseTo(cursor.y);
  });

  it('multiplies scale by the requested factor when unclamped', () => {
    const t = { scale: 2, x: 0, y: 0 };
    const zoomed = zoomAt(t, 0, 0, 1.5, limits);
    expect(zoomed.scale).toBeCloseTo(3);
  });

  it('clamps to the maximum and still keeps the cursor point fixed', () => {
    const t = { scale: 50, x: 0, y: 0 };
    const cursor = { x: 40, y: 60 };
    const worldUnderCursorBefore = screenToWorld(t, cursor.x, cursor.y);

    const zoomed = zoomAt(t, cursor.x, cursor.y, 10, limits);

    expect(zoomed.scale).toBe(limits.max);
    const screenAfter = worldToScreen(zoomed, worldUnderCursorBefore.x, worldUnderCursorBefore.y);
    expect(screenAfter.x).toBeCloseTo(cursor.x);
    expect(screenAfter.y).toBeCloseTo(cursor.y);
  });

  it('clamps to the minimum', () => {
    const t = { scale: 1, x: 0, y: 0 };
    const zoomed = zoomAt(t, 0, 0, 0.001, limits);
    expect(zoomed.scale).toBe(limits.min);
  });
});

describe('pan', () => {
  it('translates by screen-space deltas without touching scale', () => {
    const t = { scale: 4, x: 10, y: -5 };
    const panned = pan(t, 3, 7);
    expect(panned).toEqual({ scale: 4, x: 13, y: 2 });
  });
});

describe('nearestWithin', () => {
  const candidates = [
    { x: 0, y: 0 },
    { x: 100, y: 100 },
    { x: 20, y: 0 },
  ];

  it('returns the index of the nearest candidate within the threshold', () => {
    expect(nearestWithin(18, 0, candidates, 10)).toBe(2);
  });

  it('returns null when nothing is within the threshold', () => {
    expect(nearestWithin(500, 500, candidates, 10)).toBeNull();
  });

  it('returns null for an empty candidate list', () => {
    expect(nearestWithin(0, 0, [], 10)).toBeNull();
  });

  it('picks the closer of two candidates both within the threshold', () => {
    const close = [
      { x: 5, y: 0 },
      { x: 9, y: 0 },
    ];
    expect(nearestWithin(10, 0, close, 20)).toBe(1);
  });
});
