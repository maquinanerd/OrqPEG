import type {
  AgentRunOptions,
  AgentRunResult,
  ChecksSummary,
  GlobalConfig,
  Logger,
  MergeGateReport,
  MergeConsensus,
  MergeOutcome,
  ProjectConfig,
  PullRequestInfo,
  Result,
  RunRecord,
  TestSuiteResult,
  AgentInvocation,
} from '../types';
import type { CommitSummary } from '../git/git';

/**
 * Portas do orquestrador.
 *
 * O orquestrador nunca importa diretamente os adaptadores concretos: ele recebe
 * este conjunto de funções. Isso permite que a suíte de testes execute o ciclo
 * completo (Claude → testes → Codex → correção → commit → PR → CI → auditoria →
 * consenso → merge) contra dublês, sem jamais tocar em uma IA real, na rede ou
 * no repositório do usuário.
 */

export interface AgentPortOptions extends AgentRunOptions {
  role: AgentInvocation['role'];
  config: GlobalConfig;
}

export interface GitPort {
  headSha(dir: string): Promise<Result<string>>;
  currentBranch(dir: string): Promise<Result<string>>;
  changedFiles(dir: string): Promise<Result<string[]>>;
  statusText(dir: string): Promise<Result<string>>;
  diffStat(dir: string, from?: string): Promise<Result<string>>;
  diffPatch(dir: string, from?: string): Promise<Result<string>>;
  addPaths(dir: string, paths: string[]): Promise<Result<void>>;
  commit(dir: string, message: string): Promise<Result<string>>;
  push(
    dir: string,
    remote: string,
    branch: string,
    setUpstream: boolean,
  ): Promise<Result<void>>;
  remoteUrl(dir: string, remote: string): Promise<Result<string>>;
  commitLog(dir: string, fromRef: string): Promise<Result<string>>;
  /**
   * Commits alcançáveis a partir do HEAD e ausentes em `fromRef`, com a
   * mensagem completa. É o que permite descobrir, numa retomada, que o commit
   * que a execução ia criar JÁ existe — o caso de queda entre `git commit` e a
   * gravação do estado.
   */
  listCommitsSince(dir: string, fromRef: string): Promise<Result<CommitSummary[]>>;
  /** Arquivos alterados por um commit: prova de conteúdo na conciliação. */
  commitChangedFiles(dir: string, sha: string): Promise<Result<string[]>>;
}

export interface WorktreePort {
  prepare(input: {
    repoDir: string;
    worktreePath: string;
    branch: string;
    baseRef: string;
    reuseWhenSafe: boolean;
  }): Promise<Result<{ path: string; branch: string | null }>>;
  /**
   * Prova que o worktree pertence a esta execução, antes de adotá-lo numa
   * retomada. Falha com `WORKTREE_NOT_REGISTERED`,
   * `WORKTREE_OWNERSHIP_MISMATCH`, `WORKTREE_OUTSIDE_ALLOWED_ROOT` ou
   * `GIT_OPERATION_IN_PROGRESS`.
   */
  verifyOwnership(input: {
    repoDir: string;
    worktreePath: string;
    canonicalPath: string;
    branch: string;
    allowedRoot: string;
  }): Promise<Result<{ path: string; branch: string | null }>>;
}

export interface GitHubPort {
  createDraftPullRequest(input: {
    cwd: string;
    repo: string;
    base: string;
    head: string;
    title: string;
    body: string;
    draft: boolean;
  }): Promise<Result<PullRequestInfo>>;
  getPullRequest(input: {
    cwd: string;
    repo: string;
    prNumber: number;
  }): Promise<Result<PullRequestInfo>>;
  findPullRequestForBranch(input: {
    cwd: string;
    repo: string;
    head: string;
  }): Promise<Result<PullRequestInfo | null>>;
  updatePullRequestBody(input: {
    cwd: string;
    repo: string;
    prNumber: number;
    body: string;
  }): Promise<Result<void>>;
  markReadyForReview(input: {
    cwd: string;
    repo: string;
    prNumber: number;
  }): Promise<Result<void>>;
  getChecks(input: {
    cwd: string;
    repo: string;
    prNumber: number;
  }): Promise<Result<ChecksSummary>>;
  waitForChecks(input: {
    cwd: string;
    repo: string;
    prNumber: number;
    timeoutMs: number;
    pollIntervalMs: number;
    signal?: AbortSignal;
  }): Promise<Result<ChecksSummary>>;
}

export interface MergePort {
  execute(input: {
    project: ProjectConfig;
    run: RunRecord;
    pr: PullRequestInfo;
    gateReport: MergeGateReport;
    consensus: MergeConsensus;
    cwd: string;
    logger: Logger;
  }): Promise<Result<MergeOutcome>>;
}

export interface TestPort {
  run(input: {
    commands: string[];
    cwd: string;
    timeoutSeconds: number;
    signal?: AbortSignal;
    onCommandStart?: (command: string) => void;
  }): Promise<TestSuiteResult>;
}

export interface AgentPort {
  runClaude(options: AgentPortOptions): Promise<Result<AgentRunResult>>;
  runCodex(options: AgentPortOptions): Promise<Result<AgentRunResult>>;
  claudeAvailable(config: GlobalConfig): Promise<boolean>;
  codexAvailable(config: GlobalConfig): Promise<boolean>;
}

export interface OrchestratorPorts {
  agents: AgentPort;
  git: GitPort;
  worktree: WorktreePort;
  github: GitHubPort;
  merge: MergePort;
  tests: TestPort;
}
