/**
 * The `agenthub` command line: one command, clear output, a meaningful exit code.
 */

import { AgentHubError } from '@agenthub/core';
import { Command, CommanderError, Option } from 'commander';
import { approveCommand } from './commands/approve';
import { configCommand } from './commands/config';
import { diffCommand } from './commands/diff';
import { doctorCommand } from './commands/doctor';
import { infoCommand } from './commands/info';
import { installCommand } from './commands/install';
import { listCommand } from './commands/list';
import { parseAgentIds, parseChannel } from './commands/options';
import { packCommand } from './commands/pack';
import { removeCommand } from './commands/remove';
import { rollbackCommand } from './commands/rollback';
import { searchCommand } from './commands/search';
import { updateCommand } from './commands/update';
import { verifyCommand } from './commands/verify';
import { CommandContext, type CommandResult, type GlobalOptions, type Runtime } from './context';
import { exitCodeFor, Output } from './output';
import { launchTui, tuiRequest } from './tui/launch';

declare const __AGENTHUB_VERSION__: string | undefined;

export const VERSION: string =
  typeof __AGENTHUB_VERSION__ === 'string' ? __AGENTHUB_VERSION__ : '0.0.0-dev';

/**
 * Commands that never recover interrupted transactions first: recovery writes (it undoes or
 * finishes a journal), and a journal may belong to another agenthub process that is still
 * running. Read-only commands, --dry-run and `update --check` leave journals alone; doctor
 * reports them.
 */
const NO_RECOVER = new Set([
  'pack',
  'config',
  'doctor',
  'list',
  'verify',
  'search',
  'info',
  'diff',
]);

export function recoversFirst(
  command: string,
  globals: Pick<GlobalOptions, 'dryRun'>,
  local: Record<string, unknown>,
): boolean {
  if (NO_RECOVER.has(command) || globals.dryRun) return false;
  return !(command === 'update' && local.check === true);
}

const COMMANDS = new Set([
  'doctor',
  'pack',
  'install',
  'list',
  'remove',
  'verify',
  'config',
  'search',
  'info',
  'update',
  'rollback',
  'diff',
  'approve',
]);

const HELP_EPILOG = `
Environment:
  AGENTHUB_HOME        machine-local state folder (default: ~/.agenthub)
  AGENTHUB_REGISTRY    registry to use: https://… or file:<folder> (overrides config)
  AGENTHUB_CHANNEL     release channel: stable or beta (overrides config)
  AGENTHUB_USER_HOME   home folder used for the user scope (default: your home folder)
  AGENTHUB_AGENTS      testing and CI only: replaces agent detection with a list,
                       e.g. "claude-code,codex:medium" (id[:high|medium|low])
  NO_COLOR             disable colors (same as --no-color)
  AGENTHUB_NO_TUI      never open the interactive mode

Interactive mode:
  Run "agenthub" with no command on a terminal for the interactive app (type / for
  commands). Scripts, pipes, CI and every command above keep this classic output.

Exit codes:
  0 ok · 1 error or problems found · 2 usage
  3 blocked by policy, or new capabilities need approval (--approve-capabilities)
  4 integrity or drift · 5 incompatible · 130 cancelled

Examples:
  agenthub doctor
  agenthub install ./my-skill
  agenthub install web-testing@^1.2 --dry-run
  agenthub update --check
  agenthub diff web-testing
  agenthub update web-testing --approve-capabilities
  agenthub config trust-registry   (let this project's config choose the registry)
  agenthub verify --json
  agenthub --version`;

interface RawGlobals {
  json?: boolean;
  yes?: boolean;
  dryRun?: boolean;
  global?: boolean;
  agent?: GlobalOptions['agent'];
  dev?: boolean;
  force?: boolean;
  verbose?: boolean;
  color?: boolean;
  channel?: GlobalOptions['channel'];
}

function toGlobals(raw: RawGlobals): GlobalOptions {
  const opts: GlobalOptions = {
    json: raw.json === true,
    yes: raw.yes === true,
    dryRun: raw.dryRun === true,
    global: raw.global === true,
    dev: raw.dev === true,
    force: raw.force === true,
    verbose: raw.verbose === true,
    color: raw.color !== false,
  };
  if (raw.agent !== undefined) opts.agent = raw.agent;
  if (raw.channel !== undefined) opts.channel = raw.channel;
  return opts;
}

/** Best-effort read of flags before commander has parsed them (for early errors). */
function preScan(argv: string[]): {
  json: boolean;
  verbose: boolean;
  color: boolean;
  command: string;
} {
  const end = argv.indexOf('--');
  const args = end === -1 ? argv : argv.slice(0, end);
  const command = args.find((arg) => COMMANDS.has(arg)) ?? 'agenthub';
  return {
    json: args.includes('--json'),
    verbose: args.includes('--verbose'),
    color: !args.includes('--no-color'),
    command,
  };
}

export function defaultRuntime(): Runtime {
  return {
    cwd: process.cwd(),
    env: process.env,
    stdout: process.stdout,
    stderr: process.stderr,
    stdin: process.stdin,
  };
}

interface RunState {
  command: string;
  out: Output | null;
  result: CommandResult | null;
}

type Handler = (ctx: CommandContext, ...args: never[]) => Promise<CommandResult>;

export function buildProgram(runtime: Runtime, state: RunState): Command {
  const program = new Command('agenthub');
  program
    .description(
      'Install, verify and update agent skills (SKILL.md) for Claude Code, Codex, Cursor and VS Code.',
    )
    .usage('<command> [options]')
    .exitOverride()
    .configureOutput({
      writeOut: (text) => runtime.stdout.write(text),
      writeErr: (text) => runtime.stderr.write(text),
      // Usage errors are reported through our own error output (and JSON envelope).
      outputError: () => undefined,
    })
    .configureHelp({ showGlobalOptions: true })
    .helpOption('-h, --help', 'show help')
    .helpCommand('help [command]', 'show help for a command')
    .option('--json', 'print exactly one JSON object on stdout')
    .option('-y, --yes', 'skip the confirmation (after reviewing the plan)')
    .option('--dry-run', 'show what would happen without changing anything')
    .option('-g, --global', 'use the user scope (~) instead of the current project')
    .addOption(
      new Option(
        '--agent <ids>',
        'comma-separated agents: claude-code, codex, cursor, vscode',
      ).argParser(parseAgentIds),
    )
    .option('--dev', 'developer mode: override policy blocks (logged to the audit log)')
    .option('--force', 'replace modified or unmanaged skill folders')
    .option('--verbose', 'show more detail, including internal error traces')
    .option('--no-color', 'disable colors')
    .addOption(
      new Option('--channel <channel>', 'release channel: stable or beta').argParser(parseChannel),
    )
    .addHelpText('after', HELP_EPILOG);

  const action =
    (name: string, handler: Handler) =>
    async (...args: unknown[]): Promise<void> => {
      const command = args[args.length - 1] as Command;
      const local = (args[args.length - 2] ?? {}) as Record<string, unknown>;
      const positional = args.slice(0, -2);
      const globals = toGlobals(command.optsWithGlobals<RawGlobals>());
      const out = new Output({
        json: globals.json,
        verbose: globals.verbose,
        color: globals.color,
        env: runtime.env,
        stdout: runtime.stdout,
        stderr: runtime.stderr,
      });
      state.command = name;
      state.out = out;
      const ctx = new CommandContext(name, globals, runtime, out);
      if (recoversFirst(name, globals, local)) await ctx.recover();
      const call = handler as (ctx: CommandContext, ...rest: unknown[]) => Promise<CommandResult>;
      state.result = await call(ctx, ...positional, local);
    };

  program
    .command('doctor')
    .description('check agents, scopes, the lock and leftovers (read-only)')
    .action(action('doctor', doctorCommand as Handler));

  program
    .command('pack')
    .description('validate a skill folder and build a .skillpkg archive')
    .argument('<dir>', 'skill folder (its name must match the SKILL.md name)')
    .option('-o, --output <file>', 'output file (default: <name>-<version>.skillpkg)')
    .option('--version <semver>', 'version to stamp (overrides agenthub.yaml)')
    .action(
      action('pack', ((
        ctx: CommandContext,
        dir: string,
        opts: { output?: string; version?: string },
      ) => packCommand(ctx, dir, opts)) as Handler),
    );

  program
    .command('install')
    .description(
      'install a skill folder, a .skillpkg or name[@range]; no argument restores the lock',
    )
    .argument('[target]', 'folder, .skillpkg file, or name[@range] from the registry')
    .option(
      '--approve-capabilities',
      'approve capabilities the installed version did not have (--yes alone never does)',
    )
    .action(
      action('install', ((
        ctx: CommandContext,
        target: string | undefined,
        opts: { approveCapabilities?: boolean },
      ) => installCommand(ctx, target, opts)) as Handler),
    );

  program
    .command('list')
    .description('list installed skills (project and user scope; -g for user only)')
    .action(action('list', listCommand as Handler));

  program
    .command('remove')
    .description('remove an installed skill (modified files are kept unless --force)')
    .argument('<name>', 'skill name')
    .action(
      action('remove', ((ctx: CommandContext, name: string) =>
        removeCommand(ctx, name)) as Handler),
    );

  program
    .command('verify')
    .description('re-hash installed files against the lock (exit 4 on drift)')
    .argument('[name]', 'skill name (default: every skill in the scope)')
    .action(
      action('verify', ((ctx: CommandContext, name: string | undefined) =>
        verifyCommand(ctx, name)) as Handler),
    );

  program
    .command('config')
    .description('show the effective configuration, or get/set/unset a key')
    .argument('[action]', 'get, set, unset or trust-registry')
    .argument('[key]', 'registry, agents, channel or telemetry')
    .argument('[value]', 'value for set')
    .addHelpText(
      'after',
      `
Keys:
  registry   https://… or file:<folder>
  agents     comma-separated agent ids, or "detected"
  channel    stable or beta
  telemetry  true or false (off by default)

set and unset write the project config inside a project, the user config with -g.
A registry in a project's config is ignored until you run "agenthub config trust-registry"
in that project (recorded in your user config).`,
    )
    .action(
      action('config', ((
        ctx: CommandContext,
        verb: string | undefined,
        key: string | undefined,
        value: string | undefined,
      ) => configCommand(ctx, verb, key, value)) as Handler),
    );

  program
    .command('search')
    .description('search the registry (filter with --agent and --category)')
    .argument('<query>', 'search text')
    .option('--category <category>', 'only skills in this category')
    .action(
      action('search', ((ctx: CommandContext, query: string, opts: { category?: string }) =>
        searchCommand(ctx, query, opts)) as Handler),
    );

  program
    .command('info')
    .description('show versions, digests, permissions, requirements and scan findings')
    .argument('<name>', 'skill name')
    .action(
      action('info', ((ctx: CommandContext, name: string) => infoCommand(ctx, name)) as Handler),
    );

  program
    .command('update')
    .description('update installed skills (--check shows updates without changing anything)')
    .argument('[name]', 'skill name (default: every installed skill)')
    .option('--check', 'only show available updates; never writes')
    .option(
      '--safe',
      'apply only updates with no capability expansion, a valid approval and no worse policy outcome; skip the rest',
    )
    .option(
      '--approve-capabilities',
      'approve capabilities beyond the approved version (--yes alone never does)',
    )
    .action(
      action('update', ((
        ctx: CommandContext,
        name: string | undefined,
        opts: { check?: boolean; safe?: boolean; approveCapabilities?: boolean },
      ) => updateCommand(ctx, name, opts)) as Handler),
    );

  program
    .command('diff')
    .description(
      'capability and file changes between the installed version and a registry version (read-only)',
    )
    .argument('<name>', 'skill name')
    .option('--to <version>', 'compare with this version (default: the update candidate)')
    .action(
      action('diff', ((ctx: CommandContext, name: string, opts: { to?: string }) =>
        diffCommand(ctx, name, opts)) as Handler),
    );

  program
    .command('approve')
    .description("record that you reviewed the installed version's capability inventory")
    .argument('<name>', 'skill name')
    .option('--note <text>', 'why it was approved (stored in the lock)')
    .action(
      action('approve', ((ctx: CommandContext, name: string, opts: { note?: string }) =>
        approveCommand(ctx, name, opts)) as Handler),
    );

  program
    .command('rollback')
    .description('restore the previous version of a skill from its snapshot')
    .argument('<name>', 'skill name')
    .action(
      action('rollback', ((ctx: CommandContext, name: string) =>
        rollbackCommand(ctx, name)) as Handler),
    );

  return program;
}

function commanderToError(error: CommanderError): AgentHubError {
  const message = error.message.replace(/^error:\s*/i, '');
  return new AgentHubError('USAGE', message);
}

/** Runs the CLI and returns the process exit code. Never throws. */
export async function run(argv: string[], runtime: Runtime = defaultRuntime()): Promise<number> {
  const early = preScan(argv);
  const state: RunState = { command: early.command, out: null, result: null };
  const fallbackOut = (): Output =>
    new Output({
      json: early.json,
      verbose: early.verbose,
      color: early.color,
      env: runtime.env,
      stdout: runtime.stdout,
      stderr: runtime.stderr,
    });

  if (argv.length === 1 && (argv[0] === '--version' || argv[0] === '-V')) {
    runtime.stdout.write(`${VERSION}\n`);
    return 0;
  }

  // `agenthub` alone on a terminal opens the interactive mode; scripts, pipes, CI and every
  // subcommand keep the classic CLI.
  const interactive = tuiRequest(argv, runtime);
  if (interactive !== null) {
    try {
      return await launchTui(interactive, runtime, VERSION);
    } catch (error) {
      const out = fallbackOut();
      out.failure('agenthub', error);
      out.notice('The interactive mode could not start; run "agenthub --help" for the commands.');
      return exitCodeFor(error);
    }
  }

  try {
    const program = buildProgram(runtime, state);
    await program.parseAsync(argv.length === 0 ? ['--help'] : argv, { from: 'user' });
    const out = state.out;
    if (out === null || state.result === null) return 0;
    out.success(state.command, state.result.data);
    return state.result.exitCode ?? 0;
  } catch (error) {
    if (error instanceof CommanderError) {
      if (error.code === 'commander.helpDisplayed' || error.code === 'commander.version') {
        return 0;
      }
      // Help printed because no command was given.
      if (error.code === 'commander.help') return 2;
      const usage = commanderToError(error);
      const out = state.out ?? fallbackOut();
      out.failure(state.command, usage);
      const scoped = state.command !== 'agenthub' && error.code !== 'commander.unknownCommand';
      if (!out.json) {
        out.notice(`Run "agenthub ${scoped ? `${state.command} ` : ''}--help" for usage.`);
      }
      return usage.exitCode;
    }
    const out = state.out ?? fallbackOut();
    out.failure(state.command, error);
    return exitCodeFor(error);
  }
}
