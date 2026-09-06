// Browser capabilities are read only when explicitly creating the platform.
export function createPlatform(env = globalThis) {
  return Object.freeze({
    isSecureContext: env.isSecureContext === true,
    isUserActive: () => env.navigator?.userActivation?.isActive !== false,
    getUserMedia: constraints => env.navigator.mediaDevices.getUserMedia(constraints),
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
