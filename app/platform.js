// Browser capabilities are read only when explicitly creating the platform.
//
// P3-24 (design-p3 §1.14): a microphone permission the app already obtained
// from a user gesture must not be asked for a second time. `provideStream`
// hands one acquired stream to the next getUserMedia call, which consumes it —
// so a start that follows a settings save reuses that stream instead of showing
// a second permission prompt. The offer is single-use and is dropped as soon as
// it is taken or replaced; nothing here stores or reuses it beyond that.
export function createPlatform(env = globalThis) {
  let offered = null;
  const takeOffered = () => { const stream = offered; offered = null; return stream; };
  return Object.freeze({
    isSecureContext: env.isSecureContext === true,
    isUserActive: () => env.navigator?.userActivation?.isActive !== false,
    /**
     * Offer a stream — or a promise of one — to the next getUserMedia; null
     * clears a stale offer. A promise is what the caller has at the moment the
     * gesture runs, and capture calls getUserMedia before it settles, so the
     * offer must be made synchronously and awaited here.
     */
    provideStream(stream) {
      const previous = offered;
      offered = stream ?? null;
      return previous;
    },
    get offeredStream() { return offered; },
    getUserMedia: async constraints => {
      const ready = takeOffered();
      // A live stream satisfies the request; an ended, missing or refused one
      // is discarded so the browser is asked properly instead of the capture
      // failing on it.
      let stream = null;
      try { stream = await ready; } catch { stream = null; }
      if (stream && stream.getAudioTracks?.().some((track) => track.readyState !== 'ended')) return stream;
      return env.navigator.mediaDevices.getUserMedia(constraints);
    },
    createAudioContext: () => new (env.AudioContext || env.webkitAudioContext)(),
    createWorkletNode: context => new env.AudioWorkletNode(context, 'interp-capture', {
      numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1],
      channelCount: 1, channelCountMode: 'explicit', channelInterpretation: 'speakers',
    }),
    setTimeout: (fn, ms) => env.setTimeout(fn, ms),
    clearTimeout: id => env.clearTimeout(id),
    document: env.document,
    page: env,
  });
}
