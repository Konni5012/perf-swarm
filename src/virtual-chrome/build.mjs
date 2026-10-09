import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const result = spawnSync('docker', ['build', '--platform', 'linux/amd64', '-t', 'perf-swarm-chrome:1', fileURLToPath(new URL('.', import.meta.url))], { stdio: 'inherit' });
if (result.error) console.error('Install and start Docker, then run this command again:', result.error.message);
process.exit(result.status ?? 1);
