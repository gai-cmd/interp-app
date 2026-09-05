import { CAPABILITIES, ProviderError, assertActive, normalizeError } from './contract.js';

// Race cancellation without retaining AbortSignal.reason (it may contain secrets).
// A late session is still closed even when its open promise ignored cancellation.
function abortable(operation, signal, onLate = () => {}) {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new ProviderError('ABORTED'));
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve().then(() => {
      assertActive(signal);
      return operation();
    }).then((value) => {
      if (signal.aborted) {
        Promise.resolve().then(() => onLate(value)).catch(() => {});
        reject(new ProviderError('ABORTED'));
      } else resolve(value);
    }, reject).finally(() => signal.removeEventListener('abort', abort));
    if (signal.aborted) abort();
  });
}

/**
 * getCredentialRef({ providerId, keySource, transport }, { signal }) returns
 * { providerId, keySource, transport, reference }, never a whole key store.
 * reference is opaque; only the selected adapter's authentication boundary may
 * resolve it. Hub references must not contain a raw provider key.
 * context.budget.consume({ providerId, capability, transport, signal }) charges
 * one attempt or throws BUDGET_EXHAUSTED. It is synchronous and shared by all
 * stages of a turn; this router never creates/reset budgets or retries.
 * These injection interfaces bridge P1-03/P1-05, which do not exist yet.
 * Optional hub.call(capability, request, context) is a trusted verified hub
 * adapter, absent in P1. It receives no direct adapter or direct credentials.
 */
export function createRouter({ registry, getCredentialRef, hub } = {}) {
  if (!registry || typeof getCredentialRef !== 'function') throw new ProviderError('INVALID_REQUEST');

  async function call(capability, request, context = {}) {
    let normalize;
    let detach = () => {};
    let keepSession = false;
    let stopSession = () => {};
    let cancelWork = () => {};
    try {
      if (!CAPABILITIES.includes(capability)) throw new ProviderError('CAPABILITY_UNSUPPORTED');
      const { descriptor, methods } = registry.get(context.providerId);
      normalize = descriptor.quotaPolicy.normalizeError;
      const cap = descriptor.capabilities[capability];
      if (cap.implementation === 'unsupported') throw new ProviderError('CAPABILITY_UNSUPPORTED');
      if (cap.implementation !== 'ready') throw new ProviderError('CAPABILITY_UNIMPLEMENTED');
      const transport = context.transport ?? 'direct';
      if (transport !== 'direct' && transport !== 'hub') throw new ProviderError('TRANSPORT_UNSUPPORTED');
      if (transport === 'direct' && (!descriptor.browserDirect || !cap.transports.includes('direct'))) {
        throw new ProviderError(cap.transports.includes('hub') || !descriptor.browserDirect ? 'HUB_REQUIRED' : 'TRANSPORT_UNSUPPORTED');
      }
      if (!cap.transports.includes(transport)) throw new ProviderError('TRANSPORT_UNSUPPORTED');
      if (transport === 'hub' && typeof hub?.call !== 'function') throw new ProviderError('HUB_REQUIRED');
      const { keySource } = context;
      const allowed = transport === 'hub'
        ? keySource === 'hub' && descriptor.credentialPolicy.hubManaged
        : (keySource === 'personal' && descriptor.credentialPolicy.directPersonal)
          || (keySource === 'shared' && descriptor.credentialPolicy.directShared);
      if (!allowed) throw new ProviderError('CREDENTIAL_FORBIDDEN');
      if (!request?.input || !cap.inputFormats.includes(request.input.format)) throw new ProviderError('INPUT_UNSUPPORTED');
      if (request.model !== undefined && !cap.models.includes(request.model)) throw new ProviderError('INVALID_REQUEST');
      if (request.voice !== undefined && !cap.voices.includes(request.voice)) throw new ProviderError('INVALID_REQUEST');
      if (!context.signal || typeof context.signal.addEventListener !== 'function'
        || !Number.isSafeInteger(context.generation) || context.generation < 0
        || typeof context.turnId !== 'string' || typeof context.sessionId !== 'string') throw new ProviderError('INVALID_REQUEST');
      assertActive(context.signal);
      if (typeof context.budget?.consume !== 'function') throw new ProviderError('BUDGET_REQUIRED');
      // Snapshot validated routing inputs before any asynchronous credential work.
      const adapterRequest = Object.freeze({
        ...Object.fromEntries(['sourceLanguage', 'targetLanguage', 'language', 'voice', 'model']
          .filter((key) => request[key] !== undefined).map((key) => [key, request[key]])),
        input: Object.freeze(Object.fromEntries(['format', 'text', 'audio']
          .filter((key) => request.input[key] !== undefined).map((key) => [key, request.input[key]]))),
      });
      const ids = { turnId: context.turnId, sessionId: context.sessionId, generation: context.generation };

      const controller = new AbortController();
      const { signal } = controller;
      cancelWork = () => controller.abort();
      const abort = () => { controller.abort(); stopSession(); };
      context.signal.addEventListener('abort', abort, { once: true });
      detach = () => context.signal.removeEventListener('abort', abort);
      if (context.signal.aborted) abort();
      const address = Object.freeze({ providerId: descriptor.id, keySource, transport });
      const credential = await abortable(() => getCredentialRef(address, { signal }), signal);
      if (!credential) throw new ProviderError('CREDENTIAL_REQUIRED');
      if (credential.providerId !== address.providerId || credential.keySource !== keySource
        || credential.transport !== transport) throw new ProviderError('CREDENTIAL_MISMATCH');
      if (credential.reference === undefined || credential.reference === null) throw new ProviderError('CREDENTIAL_REQUIRED');
      const streaming = capability === 'live' || capability === 'voice';
      let ended = false;
      let session;
      let closing;
      const emit = (event) => {
        if (ended || signal.aborted || !streaming || !event) return;
        const fields = {
          audio: ['audio', 'sampleRate'], transcript: ['text', 'final'],
          subtitle: ['sourceText', 'translatedText', 'final', 'revision'],
          interrupted: [], complete: [], error: ['error'], closed: [],
        }[event.type];
        if (!Array.isArray(fields)) return;
        if (event.type === 'closed') { ended = true; detach(); }
        const data = Object.fromEntries(fields.filter((key) => event[key] !== undefined)
          .map((key) => [key, key === 'error' ? normalizeError(event.error, normalize) : event[key]]));
        // Consumer failures must not break adapter cleanup or become provider errors.
        try { context.onEvent?.(Object.freeze({ ...data, type: event.type, ...ids })); } catch { /* Consumer-owned failure. */ }
      };
      const close = () => {
        if (closing) return closing;
        ended = true;
        controller.abort();
        detach();
        closing = Promise.resolve().then(() => {
          if (typeof session?.close === 'function') return session.close();
        }).catch((error) => { throw normalizeError(error, normalize); });
        return closing;
      };
      stopSession = () => { if (session) close().catch(() => {}); };
      const adapterContext = Object.freeze({ ...ids, ...address, signal,
        credentialRef: credential.reference, budget: context.budget, onEvent: emit });
      const result = await abortable(() => {
        context.budget.consume({ ...address, capability, signal });
        assertActive(signal);
        return transport === 'hub'
          ? hub.call(capability, adapterRequest, adapterContext)
          : methods[capability](adapterRequest, adapterContext);
      }, signal, streaming ? (late) => late?.close() : undefined);
      if (streaming) session = result;
      assertActive(signal);
      if (!streaming) return result;
      const names = capability === 'live' ? ['sendAudio', 'finishInput'] : ['speak', 'cancel'];
      if (!session || [...names, 'close'].some((name) => typeof session[name] !== 'function')) {
        await close();
        throw new ProviderError('INVALID_RESULT');
      }
      const wrapped = { close };
      for (const name of names) {
        wrapped[name] = async (...args) => {
          try {
            assertActive(signal);
            if (ended) throw new ProviderError('SESSION_CLOSED');
            // Cancellation ends this session; reopening is owned by the engine.
            if (name === 'cancel') {
              ended = true;
              try { return await abortable(() => session.cancel(...args), signal); }
              finally { await close(); }
            }
            return await abortable(() => session[name](...args), signal);
          } catch (error) { throw normalizeError(error, normalize); }
        };
      }
      keepSession = !ended;
      return Object.freeze(wrapped);
    } catch (error) {
      cancelWork();
      stopSession();
      throw normalizeError(error, normalize);
    } finally {
      if (!keepSession) detach();
    }
  }

  return Object.freeze({ call });
}
