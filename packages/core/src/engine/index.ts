export * from './api';
export {
  CONFIG_KEYS,
  type ConfigKey,
  configSchema,
  type LoadConfigOptions,
  type LoadedConfig,
  loadConfig,
  projectTrustKey,
  resolveRegistry,
  sameRegistry,
  trustProjectRegistry,
  validateConfig,
  writeConfigValue,
} from './config';
export { createEngine } from './engine';
export { createFileRegistry } from './file-registry';
export {
  diffFiles,
  hashInstalledDir,
  isNetworkPath,
  isWithin,
  LINK_MARKER,
  mkdirp,
  removeTree,
  renameWithRetry,
  retrySettings,
  WriteGuard,
} from './fsutil';
export {
  type Journal,
  type JournalStep,
  journalDir,
  journalFile,
  newTxid,
  readJournals,
  writeJournal,
} from './journal';
export { emptyLock, parseLock, readLock, serializeLock, sortKeysDeep, writeLock } from './lock';
export {
  acquireProcessLock,
  isProcessAlive,
  lockSettings,
  PROCESS_LOCK_FILE,
  processLockFile,
} from './proclock';
export { latestVersion, type ResolveOptions, type ResolveOutcome, resolveVersion } from './resolve';
export {
  CONFIG_FILE,
  findProjectRoot,
  LOCK_FILE,
  lockFilePath,
  STATE_DIR,
  scopeId,
  scopeStateDir,
  scopeTmpDir,
} from './state';
