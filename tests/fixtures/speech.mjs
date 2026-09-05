import { createDeviceTTS } from '../../app/audio/device-tts.js';

export const voices = ['ja', 'ko', 'en'].map(lang => ({ lang, voiceURI: lang, localService: false }));
export async function flush() { for (let i = 0; i < 8; i++) await Promise.resolve(); }
export function createSpeechFixture(options = {}) {
  let time = 0, next = 0;
  const timers = new Map();
  const clock = {
    now: () => time,
    setTimeout(fn, ms) { timers.set(++next, { at: time + ms, fn }); return next; },
    clearTimeout(id) { timers.delete(id); },
  };
  class Synth extends EventTarget {
    voices = [...voices]; spoken = []; cancelled = 0; listeners = new Set();
    addEventListener(type, fn, opts) { this.listeners.add(fn); super.addEventListener(type, fn, opts); }
    removeEventListener(type, fn) { this.listeners.delete(fn); super.removeEventListener(type, fn); }
    getVoices() { return this.voices; }
    speak(u) { this.spoken.push(u); }
    cancel() { this.cancelled++; }
    end() { this.spoken.at(-1)?.onend?.(); }
    changeVoices(value) { this.voices = value; this.dispatchEvent(new Event('voiceschanged')); }
  }
  const synth = new Synth();
  const deviceTTS = createDeviceTTS({ speechSynthesis: synth,
    SpeechSynthesisUtterance: class { constructor(text) { this.text = text; } }, ...clock, ...options });
  return { synth, deviceTTS, clock, timers,
    async advance(ms) {
      const end = time + ms;
      while (true) {
        const due = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        const [id, task] = due; timers.delete(id); time = task.at; task.fn(); await flush();
      }
      time = end; await flush();
    },
  };
}
