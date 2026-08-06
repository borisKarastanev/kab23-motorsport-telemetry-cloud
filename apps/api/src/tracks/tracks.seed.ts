/**
 * The tracks this platform knows a start/finish gate for.
 *
 * ## Provenance
 *
 * Copied from the on-car dash's track database,
 * `~/development/kab23-motorsport-race-dash/data/track-db.json`, which is the
 * upstream source and stays so — the dash surveys and confirms these gates, the
 * cloud only consumes them. Each entry there carries a `start` field holding a
 * flat `[lat1, lon1, lat2, lon2]` pair of gate endpoints; `deviceTrackIds` holds
 * that entry's own `id`, which is what a device actually reports.
 *
 * **Only the dash repo's copy has the gates.** The older
 * `~/development/track-db.json` export is the same 1 462 tracks with no `start`
 * fields at all — seeding from it would produce rows that look complete and
 * segment nothing.
 *
 * ## Why three rows and not 1 462
 *
 * Exactly three entries in that database have a confirmed gate. A track without
 * one is useless here — it cannot be segmented — and the full list is the dash's
 * to own and refresh. Copying it wholesale would make this a stale mirror of
 * someone else's data.
 *
 * ## Adding a track
 *
 * Add the entry here and restart the API; `TracksSeedService` upserts by slug,
 * so a corrected gate propagates to existing databases. There is no API write
 * path — see `Track`.
 */
export interface TrackSeed {
  slug: string;
  name: string;
  country: string;
  centreLat: number;
  centreLon: number;
  sfLat1: number;
  sfLon1: number;
  sfLat2: number;
  sfLon2: number;
  deviceTrackIds: string[];
}

export const TRACK_SEEDS: TrackSeed[] = [
  {
    slug: 'kaloyanovo',
    name: 'Kaloyanovo',
    country: 'Bulgaria',
    centreLat: 42.341337751867,
    centreLon: 24.734736084938,
    sfLat1: 42.3411288,
    sfLon1: 24.737,
    sfLat2: 42.3409841,
    sfLon2: 24.7369101,
    deviceTrackIds: ['52a619159ac25e7d6beb0e53'],
  },
  {
    slug: 'a1-motor-park',
    name: 'A1 Motor Park',
    country: 'Bulgaria',
    centreLat: 42.3147398375785,
    centreLon: 23.539260448775,
    sfLat1: 42.3143121,
    sfLon1: 23.5393053,
    sfLat2: 42.3143359,
    sfLon2: 23.5389566,
    deviceTrackIds: ['68e8e882e1ce37bfc607ff8b'],
  },
  {
    slug: 'serres-automotive',
    name: 'Serres Automotive',
    country: 'Greece',
    centreLat: 41.0718767178675,
    centreLon: 23.51628653228,
    sfLat1: 41.0732367,
    sfLon1: 23.5178661,
    sfLat2: 41.0730709,
    sfLon2: 23.5176703,
    deviceTrackIds: ['53479d4a9ac25e8c373ba8b8'],
  },
];
