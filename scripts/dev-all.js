// Cross-platform "dev:all" runner.
// Bun does not support shell backgrounding ("&") on Windows, so we spawn both
// workspaces and manage their lifecycle here.

const specs = [
  {
    name: 'backend',
    cmd: ['bun', 'run', '--filter', '@llm-gateway/backend', 'dev'],
  },
  {
    name: 'web',
    cmd: ['bun', 'run', '--filter', '@llm-gateway/web', 'dev'],
  },
];

const args = process.argv.slice(2);
if (args.includes('--dry-run')) {
  for (const s of specs) {
    console.log(`[dry-run] ${s.name}: ${s.cmd.join(' ')}`);
  }
  process.exit(0);
}

const children = specs.map((s) => {
  const child = Bun.spawn({
    cmd: s.cmd,
    stdout: 'inherit',
    stderr: 'inherit',
    stdin: 'inherit',
    env: process.env,
  });
  return { ...s, child };
});

let shuttingDown = false;
async function shutdown(exitCode) {
  if (shuttingDown) return;
  shuttingDown = true;

  for (const c of children) {
    try {
      c.child.kill();
    } catch {
      // Ignore if already exited.
    }
  }

  await Promise.allSettled(children.map((c) => c.child.exited));
  process.exit(exitCode);
}

process.on('SIGINT', () => void shutdown(130));
process.on('SIGTERM', () => void shutdown(143));

Promise.race(
  children.map(async (c) => {
    const code = await c.child.exited;
    return { name: c.name, code };
  })
).then(async (firstExit) => {
  // If any child exits, stop the other one and exit with the same code.
  console.error(`[dev:all] ${firstExit.name} exited with code ${firstExit.code}`);
  await shutdown(firstExit.code);
});
