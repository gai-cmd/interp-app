// Synthetic speech only; no real recordings or credentials.
export const sentences = [
  { chunks: ['はい。次です！', '정말? Yes!'], expected: ['はい。', '次です！', '정말?', 'Yes!'] },
  { chunks: ['Value 3.', '14입니다. 次は２．', '５です。'], expected: ['Value 3.14입니다.', '次は２．５です。'] },
  { chunks: ['Dr.', ' Smith met Mr. Lee in the U.S. today. Next!'], expected: ['Dr. Smith met Mr. Lee in the U.S. today.', 'Next!'] },
  { chunks: ['「안녕。」「Hello!」'], expected: ['「안녕。」', '「Hello!」'] },
  { chunks: ['go ', 'go ', 'go!'], expected: ['go go go!'] },
  { chunks: ['Yes! ', 'Yes!'], expected: ['Yes!', 'Yes!'] },
];

export function fakeClock() {
  let time = 0, next = 0;
  const pending = new Map();
  return {
    now: () => time,
    setTimeout(fn, ms) { const id = next++; pending.set(id, { fn, at: time + ms }); return id; },
    clearTimeout(id) { pending.delete(id); },
    get size() { return pending.size; },
    callbacks: () => [...pending.values()].map(({ fn }) => fn),
    tick(ms) {
      const target = time + ms;
      while (true) {
        const entry = [...pending].filter(([, job]) => job.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!entry) break;
        pending.delete(entry[0]); time = entry[1].at; entry[1].fn();
      }
      time = target;
    },
  };
}
