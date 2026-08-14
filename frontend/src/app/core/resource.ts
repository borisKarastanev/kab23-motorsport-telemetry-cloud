import { Signal, computed } from '@angular/core';

/**
 * Reading an `httpResource` without taking the whole view down with it.
 *
 * **`httpResource.value()` throws `ResourceValueError` whenever the resource is
 * in an error state, and `defaultValue` does not cover that** — it covers the
 * not-yet-loaded and loading cases only. An unguarded `value()` read inside a
 * `computed` that a template binds therefore throws *during change detection*,
 * which takes down the entire view rather than omitting the failed data.
 *
 * That is not a rare path in this app. Every one of these is a state the API
 * produces normally:
 *
 * - `GET /tracks/:track/map` **404s by design** for any track string the cloud
 *   has not seeded — `TracksService.resolve` is explicit that this is "a
 *   first-class answer, not a failure", because a car reports whatever its
 *   independently-versioned on-car database calls the track.
 * - Any authenticated read **401s** once the 24 h JWT expires, which a
 *   pit-wall browser left open across a multi-day event can still outlive.
 * - Session-scoped reads **403** for another team's session and **404** for a
 *   deleted one.
 *
 * So every read goes through here, and the rule is greppable: a bare `.value()`
 * anywhere outside this file is a bug.
 *
 * **`hasValue()` is false while *loading* too**, not only on error, so it
 * cannot tell "failed" from "still in flight". Never treat a null/fallback
 * result as evidence that a request settled — read `resource.status()` or a
 * status field on the payload for that. (Getting this wrong is what made a
 * retry budget reset on every retry and poll forever.)
 */
type ReadableResource<T> = { hasValue(): boolean; value(): T };

export function guarded<T>(resource: ReadableResource<T>): Signal<T | null>;
export function guarded<T>(resource: ReadableResource<T>, fallback: T): Signal<T>;
export function guarded<T>(resource: ReadableResource<T>, fallback: T | null = null) {
  return computed(() => (resource.hasValue() ? (resource.value() ?? fallback) : fallback));
}
