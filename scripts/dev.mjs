/**
 * `npm run dev`: starts the API (port 4000) and the web app (Vite) together,
 * with each line prefixed by where it came from. Ctrl+C stops both.
 */
import { spawn } from 'node:child_process';

const procs = [
  ['api', 'dev:server', '\x1b[36m'],
  ['web', 'dev:web', '\x1b[35m'],
].map(([name, script, color]) => {
  const child = spawn(`npm run ${script}`, { shell: true, env: process.env });
  const prefix = (chunk) => chunk.toString().split(/\r?\n/).filter(Boolean).map((l) => `${color}[${name}]\x1b[0m ${l}`).join('\n');
  child.stdout.on('data', (c) => console.log(prefix(c)));
  child.stderr.on('data', (c) => console.error(prefix(c)));
  child.on('exit', (code) => {
    console.log(`${color}[${name}]\x1b[0m stopped (exit ${code}). Stopping the rest.`);
    stopAll();
  });
  return child;
});

let stopping = false;
function stopAll() {
  if (stopping) return;
  stopping = true;
  for (const p of procs) if (p.exitCode === null) p.kill();
  setTimeout(() => process.exit(0), 500);
}
process.on('SIGINT', stopAll);
process.on('SIGTERM', stopAll);
