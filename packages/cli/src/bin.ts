import { run } from './program';

// A closed pipe (e.g. `agenthub list | head -1`) must not crash a command that is changing
// files; the remaining output is simply dropped.
for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code !== 'EPIPE') process.exitCode = 1;
  });
}

process.on('SIGINT', () => {
  process.stderr.write('\ncancelled\n');
  process.exit(130);
});

run(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  () => {
    process.exitCode = 1;
  },
);
