import { defineProvider, ProviderError } from './contract.js';

// No built-in or test providers: P1-13 explicitly registers reviewed product code.
export function createRegistry() {
  const providers = new Map();
  return Object.freeze({
    register(definition, adapter) {
      const provider = defineProvider(definition, adapter);
      if (providers.has(provider.descriptor.id)) throw new ProviderError('DUPLICATE_PROVIDER');
      providers.set(provider.descriptor.id, provider);
      return provider.descriptor;
    },
    get(id) {
      const provider = providers.get(id);
      if (!provider) throw new ProviderError('UNKNOWN_PROVIDER');
      return provider;
    },
    has(id) { return providers.has(id); },
    list() { return Object.freeze([...providers.values()].map(({ descriptor }) => descriptor)); },
  });
}
