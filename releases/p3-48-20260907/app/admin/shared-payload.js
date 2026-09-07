// P3-34: the shared-event key payload generator (design-p3 §1.7 step 8).
//
// Deliberately separate from the policy editor. The policy is a public document
// that must never contain a key; this tool builds a one-off fragment for one
// event and hands it to the person, and its output never touches the draft or
// the export.
//
// It is also not the P2-25 site QR. That one shares the app's URL and carries
// nothing secret; this one carries a key and must be treated accordingly — it
// is produced only on an explicit press, never logged, and cleared on close.
//
// The event id in a payload is not a signature and proves no administrator
// identity (§1.7); the app matches it against the deployed policy, which is
// what actually authorises it.
import { MAX_FRAGMENT_LENGTH, parseSharedFragment } from '../security/shared-key.js';

/** The versions this generator writes. v1 stays parseable but is not produced. */
export const GENERATED_VERSION = 2;
export const PAYLOAD_ERRORS = Object.freeze(['event', 'key', 'expiry', 'tooLong', 'policy']);

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
/** Active events of the deployed policy, the only ones a payload may name. */
export function activeEvents(policy, { now = Date.now() } = {}) {
  const events = Array.isArray(policy?.sharedEvents) ? policy.sharedEvents : [];
  const time = now instanceof Date ? now.getTime() : Number(now);
  return Object.freeze(events.filter((event) => {
    if (!isObject(event) || event.enabled === false) return false;
    const ends = event.expiresAt ?? null;
    if (ends === null || ends === undefined) return true;
    const at = Date.parse(ends);
    return !Number.isFinite(at) || at > time;
  }).map((event) => Object.freeze({ ...event })));
}

/**
 * buildSharedPayload({ policy, eventId, key, now? })
 * -> { ok: true, fragment, payload } | { ok: false, error }
 *
 * The event, provider, name and expiry all come from the deployed policy, so a
 * payload cannot name an event the app will not recognise. The key comes from
 * the person and is never stored, logged or defaulted.
 */
export function buildSharedPayload({ policy, eventId, key, now = Date.now(), registry = null } = {}) {
  const fail = (error) => Object.freeze({ ok: false, error });
  const event = activeEvents(policy, { now }).find((item) => item.id === eventId);
  if (!event) return fail('event');
  if (typeof key !== 'string' || key.trim() === '') return fail('key');
  // The policy states an event's end as an ISO datetime; the payload format
  // carries it as epoch milliseconds (shared-key.js validDeadline). Converting
  // here is what keeps a generated link parseable — the round-trip check below
  // is what caught the mismatch.
  const ends = event.expiresAt ?? null;
  const expiresAt = typeof ends === 'string' ? Date.parse(ends) : ends;
  if (!Number.isSafeInteger(expiresAt) || expiresAt < 0) return fail('expiry');
  if (expiresAt <= (now instanceof Date ? now.getTime() : Number(now))) return fail('expiry');
  const payload = {
    version: GENERATED_VERSION,
    providerId: event.providerId,
    eventId: event.id,
    eventName: event.eventName,
    key: key.trim(),
    expiresAt,
  };
  const fragment = `#shared=${encodeURIComponent(JSON.stringify(payload))}`;
  if (fragment.length > MAX_FRAGMENT_LENGTH) return fail('tooLong');
  // The app's own parser is the acceptance test: a payload this tool produces
  // must round-trip through the code that will read it. The parser needs the
  // provider registry, so the check runs when one is supplied and is reported
  // rather than assumed when it is not.
  let roundTrips = null;
  if (registry) {
    try { roundTrips = parseSharedFragment(fragment, { registry, now: () => now }) !== null; }
    catch { roundTrips = false; }
    if (roundTrips === false) return fail('policy');
  }
  return Object.freeze({ ok: true, fragment, payload: Object.freeze({ ...payload }), roundTrips });
}

/**
 * createSharedPayloadTool({ policy, navigator?, now? }) keeps the generated
 * fragment in memory only, hands it over on an explicit copy, and clears it on
 * close. Nothing here writes to storage or logs.
 */
export function createSharedPayloadTool({ policy = null, navigator: nav = null, now = Date.now,
  registry = null } = {}) {
  let current = null, deployed = policy;
  return Object.freeze({
    /** The deployed policy to read events from; this applies nothing anywhere. */
    useDeployedPolicy(next) { deployed = next; current = null; },
    events: () => activeEvents(deployed, { now: now() }),
    get fragment() { return current?.fragment ?? null; },
    /** Build from a key the person typed; the key is never kept beyond this. */
    generate({ eventId, key }) {
      const built = buildSharedPayload({ policy: deployed, eventId, key, now: now(), registry });
      current = built.ok ? built : null;
      // The result describes the link without being it: the key travels only
      // through copy(), so nothing that renders this can echo it to a screen,
      // a log or a status line. A failure carries a code and nothing else.
      if (!built.ok) return built;
      const { key: _key, ...describable } = built.payload;
      return Object.freeze({ ok: true, length: built.fragment.length,
        payload: Object.freeze(describable), roundTrips: built.roundTrips });
    },
    /** Explicit copy only; a failure offers the text for manual selection. */
    async copy() {
      if (!current) return Object.freeze({ result: 'blocked' });
      const clipboard = nav?.clipboard;
      if (typeof clipboard?.writeText !== 'function') return Object.freeze({ result: 'manual', text: current.fragment });
      try { await clipboard.writeText(current.fragment); } catch { return Object.freeze({ result: 'manual', text: current.fragment }); }
      return Object.freeze({ result: 'copied' });
    },
    /** Closing the tool forgets the key-bearing fragment. */
    close() { current = null; },
  });
}
