// Node resolves an explicit directory argument as a module entry. Keep
// `node --test tests/` equivalent to the glob command with process isolation;
// several session-manager tests deliberately leave a poisoned socket slot.
import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const directory = fileURLToPath(new URL('.', import.meta.url));
if (process.argv[1] && resolve(process.argv[1]) === resolve(directory)) {
  const files = readdirSync(directory).filter((name) => name.endsWith('.test.mjs') && name !== 'directory.test.mjs')
    .sort().map((name) => resolve(directory, name));
  const env = { ...process.env };
  // The child is a new test coordinator, not this runner's worker process.
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit', env });
  process.exitCode = result.status ?? 1;
}
