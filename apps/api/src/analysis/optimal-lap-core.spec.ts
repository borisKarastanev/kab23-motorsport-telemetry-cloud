import { pickBestSectors, SectoredLap } from './optimal-lap-core';

/**
 * Fixtures straight from the algorithm specification's worked example
 * (`~/development/optimal-lap-algorithm.md` §1), so the arithmetic in this
 * file is checked against numbers a reader can verify by hand.
 */
const WORKED_EXAMPLE: SectoredLap[] = [
  {
    lapNumber: 1,
    lapMs: 86_480,
    distanceM: 2100,
    sectorMs: [28_410, 30_720, 27_350],
  },
  {
    lapNumber: 2,
    lapMs: 85_800,
    distanceM: 2100,
    sectorMs: [28_300, 31_060, 26_440],
  },
  {
    lapNumber: 3,
    lapMs: 87_330,
    distanceM: 2100,
    sectorMs: [28_770, 31_440, 27_120],
  },
  {
    lapNumber: 4,
    lapMs: 86_700,
    distanceM: 2100,
    sectorMs: [27_840, 31_660, 27_200],
  },
];

describe('pickBestSectors', () => {
  it('combines the best sector from each lap, per the worked example', () => {
    const result = pickBestSectors(WORKED_EXAMPLE);

    expect(result).not.toBeNull();
    expect(result!.sectors).toEqual([
      { sector: 0, lapNumber: 4, sectorMs: 27_840 },
      { sector: 1, lapNumber: 1, sectorMs: 30_720 },
      { sector: 2, lapNumber: 2, sectorMs: 26_440 },
    ]);
    expect(result!.lapMs).toBe(85_000);
    // Strictly faster than the best actual lap (lap 2, 85 800 ms).
    expect(result!.lapMs).toBeLessThan(85_800);
    expect(result!.matchesLapNumber).toBeNull();
  });

  it('leaves a lap that was fastest nowhere contributing nothing', () => {
    const result = pickBestSectors(WORKED_EXAMPLE);
    expect(result!.sectors.some((s) => s.lapNumber === 3)).toBe(false);
  });

  it('says so when every sector comes from the same lap', () => {
    const laps: SectoredLap[] = [
      {
        lapNumber: 1,
        lapMs: 90_000,
        distanceM: 2000,
        sectorMs: [30_000, 30_000, 30_000],
      },
      {
        lapNumber: 2,
        lapMs: 95_000,
        distanceM: 2000,
        sectorMs: [32_000, 32_000, 31_000],
      },
    ];

    const result = pickBestSectors(laps);
    expect(result!.matchesLapNumber).toBe(1);
  });

  it('breaks a tie by the lower lap number', () => {
    const laps: SectoredLap[] = [
      {
        lapNumber: 5,
        lapMs: 90_000,
        distanceM: 2000,
        sectorMs: [30_000, 30_000, 30_000],
      },
      {
        lapNumber: 2,
        lapMs: 90_000,
        distanceM: 2000,
        sectorMs: [30_000, 30_000, 30_000],
      },
      {
        lapNumber: 9,
        lapMs: 90_000,
        distanceM: 2000,
        sectorMs: [30_000, 30_000, 30_000],
      },
    ];

    const result = pickBestSectors(laps);
    expect(result!.sectors.every((s) => s.lapNumber === 2)).toBe(true);
    expect(result!.matchesLapNumber).toBe(2);
  });

  it('excludes a lap with a short sector count entirely, not just for the missing sector', () => {
    const laps: SectoredLap[] = [
      {
        lapNumber: 1,
        lapMs: 90_000,
        distanceM: 2000,
        sectorMs: [10_000, 40_000],
      }, // missing S3
      {
        lapNumber: 2,
        lapMs: 95_000,
        distanceM: 2000,
        sectorMs: [32_000, 32_000, 31_000],
      },
      {
        lapNumber: 3,
        lapMs: 93_000,
        distanceM: 2000,
        sectorMs: [31_000, 31_000, 31_000],
      },
    ];

    const result = pickBestSectors(laps);
    expect(result!.sectors.every((s) => s.lapNumber !== 1)).toBe(true);
  });

  it('excludes a lap with a zero or non-finite sector', () => {
    const laps: SectoredLap[] = [
      {
        lapNumber: 1,
        lapMs: 90_000,
        distanceM: 2000,
        sectorMs: [0, 40_000, 40_000],
      },
      {
        lapNumber: 2,
        lapMs: 90_000,
        distanceM: 2000,
        sectorMs: [30_000, NaN, 30_000],
      },
      {
        lapNumber: 3,
        lapMs: 93_000,
        distanceM: 2000,
        sectorMs: [31_000, 31_000, 31_000],
      },
      {
        lapNumber: 4,
        lapMs: 93_000,
        distanceM: 2000,
        sectorMs: [31_000, 31_000, 31_000],
      },
    ];

    const result = pickBestSectors(laps);
    expect(
      result!.sectors.every((s) => s.lapNumber === 3 || s.lapNumber === 4),
    ).toBe(true);
  });

  it('returns null with exactly one eligible lap', () => {
    const laps: SectoredLap[] = [
      {
        lapNumber: 1,
        lapMs: 90_000,
        distanceM: 2000,
        sectorMs: [30_000, 30_000, 30_000],
      },
      { lapNumber: 2, lapMs: 90_000, distanceM: 2000, sectorMs: [1] }, // ineligible: wrong count
    ];

    expect(pickBestSectors(laps)).toBeNull();
  });

  it('returns null with zero laps', () => {
    expect(pickBestSectors([])).toBeNull();
  });

  it('honours a sector count other than three', () => {
    const laps: SectoredLap[] = [
      {
        lapNumber: 1,
        lapMs: 40_000,
        distanceM: 1000,
        sectorMs: [10_000, 10_000, 10_000, 10_000],
      },
      {
        lapNumber: 2,
        lapMs: 41_000,
        distanceM: 1000,
        sectorMs: [9_000, 11_000, 11_000, 10_000],
      },
    ];

    const result = pickBestSectors(laps, 4);
    expect(result!.sectors).toHaveLength(4);
    expect(result!.lapMs).toBe(9_000 + 10_000 + 10_000 + 10_000);
  });

  it("sums an equal share of each contributing lap's distance", () => {
    const laps: SectoredLap[] = [
      {
        lapNumber: 1,
        lapMs: 90_000,
        distanceM: 3000,
        sectorMs: [29_000, 30_000, 31_000],
      },
      {
        lapNumber: 2,
        lapMs: 90_000,
        distanceM: 3300,
        sectorMs: [30_000, 29_000, 31_000],
      },
    ];

    const result = pickBestSectors(laps);
    // S1 from lap 1 (1000 m share), S2 from lap 2 (1100 m share), S3 tied at
    // 31 000 — lower lap number wins, lap 1 (1000 m share).
    expect(result!.distanceM).toBeCloseTo(1000 + 1100 + 1000, 5);
  });
});
