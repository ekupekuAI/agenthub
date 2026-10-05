/**
 * What every command receives: parsed global flags, the output channel and lazily built
 * engine wiring.
 */
import type { AgentHubConfig, AgentId, Engine, Scope } from '@agenthub/core';
import { clean, type Output } from './output';
import type { ConfirmOptions, PromptInput } from './prompt';
import { createWiring, type Wiring } from './wiring';

export interface GlobalOptions {
  json: boolean;
  yes: boolean;
  dryRun: boolean;
  global: boolean;
  agent?: AgentId[];
  dev: boolean;
  force: boolean;
  verbose: boolean;
  color: boolean;
  channel?: 'stable' | 'beta';
}

export interface Runtime {
  cwd: string;
  env: Record<string, string | undefined>;
  stdout: { write(chunk: string): unknown; isTTY?: boolean };
  stderr: { write(chunk: string): unknown; isTTY?: boolean };
  stdin: NodeJS.ReadableStream & PromptInput;
}

export interface CommandResult {
  data: unknown;
  /** Non-zero exit with a successful report (e.g. doctor found problems). */
  exitCode?: number;
}

export class CommandContext {
  private wiringPromise: Promise<Wiring> | undefined;
  private registryNoticed = false;

  constructor(
    readonly command: string,
    readonly opts: GlobalOptions,
    readonly runtime: Runtime,
    readonly out: Output,
  ) {}

  get cwd(): string {
    return this.runtime.cwd;
  }

  get env(): Record<string, string | undefined> {
    return this.runtime.env;
  }

  configFlags(): Partial<AgentHubConfig> {
    const flags: Partial<AgentHubConfig> = {};
    if (this.opts.channel !== undefined) flags.channel = this.opts.channel;
    return flags;
  }

  wiring(): Promise<Wiring> {
    if (this.wiringPromise === undefined) {
      this.wiringPromise = createWiring({
        cwd: this.cwd,
        env: this.env,
        flags: this.configFlags(),
        global: this.opts.global,
      });
    }
    return this.wiringPromise;
  }

  async engine(): Promise<Engine> {
    return (await this.wiring()).engine;
  }

  /** Finishes or undoes interrupted transactions and reports what happened (stderr). */
  async recover(): Promise<void> {
    const engine = await this.engine();
    const messages = await engine.recover();
    for (const message of messages) this.out.notice(`recovered: ${message}`);
  }

  /**
   * Says (once, on stderr) when the registry was chosen by the project's own config file (which
   * the user must have trusted), and which project settings were ignored, so a cloned repository
   * cannot silently decide where packages are downloaded from.
   */
  async registryNotice(opts: { warnings?: boolean } = {}): Promise<void> {
    if (this.registryNoticed) return;
    this.registryNoticed = true;
    const wiring = await this.wiring();
    // Project settings the loader ignored (e.g. an untrusted project registry). Plans list
    // them under Notes, so commands that print a plan pass `warnings: false`.
    if (opts.warnings !== false) {
      for (const warning of wiring.config.warnings ?? []) this.out.warn(clean(warning));
    }
    if (wiring.registrySource !== 'project' || wiring.registry === null) return;
    const file = wiring.config.projectConfigPath ?? '.agenthub/config.json';
    this.out.notice(
      `note: using the registry ${clean(wiring.registry.id)} set by the project config ${clean(file)}`,
    );
  }

  /** -g → user; otherwise the engine's default (project inside a repo, user outside). */
  async scope(): Promise<Scope> {
    if (this.opts.global) return 'user';
    return (await this.engine()).defaultScope();
  }

  /** Agents from --agent; otherwise the engine applies the config pin or detection (D3). */
  agents(): AgentId[] | undefined {
    return this.opts.agent;
  }

  /** --channel; otherwise the engine uses the configured channel. */
  channel(): 'stable' | 'beta' | undefined {
    return this.opts.channel;
  }

  confirmOptions(): ConfirmOptions {
    return { yes: this.opts.yes, json: this.opts.json, stdin: this.runtime.stdin };
  }

  /** Banner for --dev (design §8.2). */
  devBanner(): void {
    if (!this.opts.dev) return;
    this.out.notice(
      this.out.errStyle.yellow(
        'DEVELOPER MODE: policy BLOCK decisions are overridden for this command and recorded in the audit log.',
      ),
    );
  }
}
