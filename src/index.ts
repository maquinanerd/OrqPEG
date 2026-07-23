/**
 * OrqPEG — superfície pública do pacote.
 *
 * Reexporta os pontos de entrada estáveis para uso programático e pelos testes.
 * O executável fica em `dist/cli/main.js`.
 */

export type * from './types';

export { runCli } from './cli/commands';
export { runDiagnostics, renderDiagnosticReport } from './cli/diagnostics';

export { runProject, describeRunState } from './execution/orchestrator';
export { createDefaultPorts } from './execution/default-ports';
export { buildDryRunPlan, renderDryRunPlan } from './execution/dry-run';
export type { OrchestratorPorts } from './execution/ports';

export { startPanelServer } from './server/http-server';
export { createEventHub } from './server/events';

export {
  loadGlobalConfig,
  saveGlobalConfig,
  ensureGlobalConfig,
  defaultGlobalConfig,
  validateGlobalConfig,
} from './config/global-config';

export {
  listProjects,
  getProject,
  createProject,
  updateProject,
  removeProjectRegistration,
} from './projects/project-store';

export { discoverPrompts, readPrompt } from './prompts/prompt-store';
export { parsePrompt } from './prompts/prompt-parser';

export {
  createRun,
  loadRun,
  saveRun,
  listRuns,
  latestRun,
  findActiveRun,
  transition,
  canTransition,
  invalidateMergeApprovals,
  requestPause,
  requestCancel,
  recordRunIntent,
  readPersistedIntent,
} from './state/run-state';

/* Controle de execução viva: quem pausa e quem cancela fala com estas funções. */
export {
  getController,
  isRunLive,
  listControllers,
  requestPauseOnLiveRun,
  requestCancelOnLiveRun,
  shutdownAllRuns,
  awaitAllRuns,
} from './execution/run-control';
export type { RunIntent, RunControlSnapshot, IntentAcceptance } from './execution/run-control';
export { watchPersistedIntent } from './execution/intent-watcher';
export {
  pauseRun,
  cancelRun,
  isRunning,
  listRunningProjects,
  describeRunningRuns,
  shutdownRuns,
} from './server/run-manager';

export { acquireLock, withLock, listLocks } from './state/locks';

export { evaluateGates, GATE_DEFINITIONS, describeGateReport } from './merge/gates';
export { computeConsensus } from './merge/consensus';
export { executeMerge } from './merge/merge-executor';

export { runTestSuite, summarizeTestSuite } from './tests-runner/test-runner';

export {
  inspectApiEnvironment,
  assertChildEnvIsClean,
  BLOCKING_API_ENV_VARS,
} from './security/api-guard';
export { buildSanitizedEnv, buildToolEnv } from './security/env-sanitizer';
export { validateIdentifier, resolveWithinRoot, validateAbsolutePath } from './security/path-guard';
export { validateBranchName, slugifyForBranch, buildRunBranchName } from './security/branch-name';

export { buildRunReport, writeRunReport } from './reports/report-generator';
