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
  // P3-26: the selected input device, applied to BOTH capture paths here rather
  // than in each of them, so neither can lose the mono/echo/noise constraints
  // while adding a device. null means the system default, which is always
  // available and is what an unknown or vanished selection falls back to.
  let inputDeviceId = null;
  const takeOffered = () => { const stream = offered; offered = null; return stream; };
  /** The caller's audio constraints plus the chosen device; nothing is dropped. */
  const withDevice = (constraints) => {
    if (inputDeviceId === null) return constraints;
    const audio = constraints?.audio;
    if (audio === undefined || audio === false) return constraints;
    // `ideal`, never `exact`: a device that has gone away must fall back to the
    // system default instead of failing the request (P3-25).
    const merged = audio === true ? { deviceId: { ideal: inputDeviceId } }
      : { ...audio, deviceId: { ideal: inputDeviceId } };
    return { ...constraints, audio: merged };
  };
  /** True when the stream's audio track is the device that is selected now. */
  const matchesDevice = (stream) => {
    if (inputDeviceId === null) return true;
    const tracks = stream?.getAudioTracks?.() ?? [];
    return tracks.some((track) => {
      const settings = track.getSettings?.();
      // A browser that reports no device id is trusted: refusing it would ask
      // for the microphone a second time for nothing.
      return !settings || settings.deviceId === undefined || settings.deviceId === inputDeviceId;
    });
  };
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
    /**
     * P3-26: the microphone to capture from; null is the system default.
     * Changing it drops any stream offered for the old device, so a start after
     * a change cannot reuse it.
     */
    setInputDevice(deviceId) {
      const next = typeof deviceId === 'string' && deviceId ? deviceId : null;
      if (next === inputDeviceId) return inputDeviceId;
      inputDeviceId = next;
      offered = null;
      return inputDeviceId;
    },
    get inputDeviceId() { return inputDeviceId; },
    getUserMedia: async constraints => {
      const ready = takeOffered();
      // A live stream satisfies the request; an ended, missing or refused one
      // is discarded so the browser is asked properly instead of the capture
      // failing on it. A stream from a device that is no longer the selected
      // one is discarded too (P3-26: the pre-acquired stream follows the same
      // choice as a fresh request).
      let stream = null;
      try { stream = await ready; } catch { stream = null; }
      if (stream && stream.getAudioTracks?.().some((track) => track.readyState !== 'ended')
        && matchesDevice(stream)) return stream;
      return env.navigator.mediaDevices.getUserMedia(withDevice(constraints));
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
