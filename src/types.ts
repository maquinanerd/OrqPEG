/**
 * OrqPEG — contrato de tipos compartilhado.
 *
 * Este arquivo é a fonte única de verdade para as estruturas trocadas entre os
 * módulos do sistema. Nenhum módulo deve redefinir localmente um tipo aqui
 * declarado.
 */

/* ------------------------------------------------------------------------- */
/* Resultado                                                                  */
/* ------------------------------------------------------------------------- */

export type Ok<T> = { readonly ok: true; readonly value: T };
export type Err<E> = { readonly ok: false; readonly error: E };
export type Result<T, E = OrqError> = Ok<T> | Err<E>;

export type ErrorCode =
  | 'CONFIG_INVALID'
  | 'CONFIG_NOT_FOUND'
  | 'PROJECT_NOT_FOUND'
  | 'PROJECT_INVALID'
  | 'PROMPT_NOT_FOUND'
  | 'SCHEMA_INVALID'
  | 'VALIDATION_FAILED'
  | 'PATH_UNSAFE'
  | 'API_KEY_PRESENT'
  | 'TOOL_MISSING'
  | 'AUTH_REQUIRED'
  | 'USAGE_LIMIT_REACHED'
  | 'GIT_FAILED'
  | 'GH_FAILED'
  | 'WORKTREE_FAILED'
  | 'LOCK_HELD'
  | 'LOCK_FAILED'
  | 'STATE_CORRUPT'
  | 'POLICY_SNAPSHOT_MISSING'
  | 'WORKTREE_NOT_REGISTERED'
  | 'WORKTREE_OWNERSHIP_MISMATCH'
  | 'WORKTREE_OUTSIDE_ALLOWED_ROOT'
  | 'GIT_OPERATION_IN_PROGRESS'
  | 'PROCESS_FAILED'
  | 'PROCESS_TIMEOUT'
  | 'PROCESS_INTERRUPTED'
  | 'REVIEW_INVALID_JSON'
  | 'REVIEW_SCHEMA_MISMATCH'
  | 'TESTS_FAILED'
  | 'CI_FAILED'
  | 'MERGE_GATE_FAILED'
  | 'MERGE_CONFLICT'
  | 'MERGE_ALREADY_DONE'
  | 'REMOTE_MISMATCH'
  | 'CANCELLED'
  | 'IO_FAILED'
  | 'INTERNAL';

export interface OrqError {
  readonly code: ErrorCode;
  readonly message: string;
  readonly details?: Readonly<Record<string, unknown>>;
  readonly cause?: string;
}

/* ------------------------------------------------------------------------- */
/* Log                                                                        */
/* ------------------------------------------------------------------------- */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogRecord {
  readonly timestamp: string;
  readonly level: LogLevel;
  readonly scope: string;
  readonly message: string;
  readonly data?: Readonly<Record<string, unknown>>;
}

export interface Logger {
  debug(message: string, data?: Record<string, unknown>): void;
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string, data?: Record<string, unknown>): void;
  child(scope: string): Logger;
}

/* ------------------------------------------------------------------------- */
/* Configuração global                                                        */
/* ------------------------------------------------------------------------- */

export interface GlobalConfig {
  version: string;
  panel: {
    host: string;
    port: number;
    openBrowserOnStart: boolean;
  };
  agents: {
    claudeCommand: string;
    codexCommand: string;
    claudeTimeoutSeconds: number;
    codexTimeoutSeconds: number;
    defaultClaudeModel: string | null;
    defaultCodexModel: string | null;
  };
  security: {
    /** Bloqueia execução de IA quando variáveis de API estão presentes. */
    blockWhenApiKeysPresent: boolean;
    /** Variáveis removidas do ambiente de todo processo filho de IA. */
    strippedEnvVars: string[];
    /** Variáveis apenas reportadas como aviso, sem bloquear. */
    warnEnvVars: string[];
  };
  git: {
    /** Nunca habilitar: force push é proibido por projeto. */
    allowForcePush: false;
  };
  paths: {
    /** Raiz padrão para worktrees quando o projeto não define uma. */
    defaultWorktreeRoot: string | null;
  };
  /**
   * Camada global da política de looping. Ausente por padrão.
   *
   * Só os campos declarados sobrepõem os padrões do produto; o projeto e a
   * rodada ainda sobrepõem esta camada. Serve para uma instalação inteira
   * apertar um limite sem editar projeto por projeto.
   */
  loopGuard?: Partial<LoopGuardConfig>;
}

/* ------------------------------------------------------------------------- */
/* Projeto                                                                    */
/* ------------------------------------------------------------------------- */

export type BranchStrategy = 'per_run' | 'fixed' | 'per_prompt';
export type MergeMode = 'dual_ai_consensus' | 'manual' | 'disabled';
export type MergeStrategy = 'squash' | 'merge' | 'rebase';

export interface ProjectWorktreeConfig {
  enabled: boolean;
  rootPath: string | null;
  reuseWhenSafe: boolean;
}

export interface ProjectCommandsConfig {
  install: string[];
  tests: string[];
  timeoutSeconds: number;
}

/**
 * Política de proteção contra looping.
 *
 * Contar tentativas não basta: um ciclo pode repetir o mesmo diff, receber a
 * mesma revisão e falhar no mesmo teste indefinidamente sem nunca estourar o
 * contador. Estes orçamentos e detectores existem para que nenhuma repetição
 * seja ilimitada e nenhuma assinatura seja consumida sem progresso comprovado.
 */
export interface LoopGuardConfig {
  enabled: boolean;

  /* Orçamento de chamadas de IA, por prompt. */
  maxClaudeCallsPerPrompt: number;
  maxCodexCallsPerPrompt: number;
  maxTotalAgentCallsPerPrompt: number;

  /* Orçamento de tempo. */
  maxPromptDurationMinutes: number;
  maxRunDurationMinutes: number;

  /* Detecção de repetição. */
  maxConsecutiveNoProgress: number;
  maxRepeatedReviewFingerprints: number;
  maxRepeatedTestFailureFingerprints: number;

  /* Detectores booleanos. */
  detectDiffOscillation: boolean;
  detectReviewOscillation: boolean;
  stopOnPromptMutation: boolean;
  stopOnContextMutation: boolean;
  stopOnScopeViolation: boolean;

  /* Orçamento de tamanho do diff. `null` desativa o limite. */
  maxChangedFilesPerPrompt: number | null;
  maxChangedLinesPerPrompt: number | null;

  /* Ciclos de correção fora do laço do prompt. */
  maxManualOverridesPerPrompt: number;
  maxCiRepairCycles: number;
  maxMergeCorrectionCycles: number;

  /* Espera do CI. */
  ciPollIntervalSeconds: number;
  ciPollMaxIntervalSeconds: number;
  ciWaitTimeoutMinutes: number;

  /* Retentativas de formato do revisor, separadas da correção de código. */
  maxReviewFormatRetries: number;
}

export interface ProjectExecutionConfig {
  maxAttemptsPerPrompt: number;
  maxReviewerRetries: number;
  continueAfterApproval: boolean;
  stopOnBlocked: boolean;
  loopGuard: LoopGuardConfig;
}

/* ------------------------------------------------------------------------- */
/* Loop Guard                                                                 */
/* ------------------------------------------------------------------------- */

/**
 * Motivos pelos quais uma nova tentativa automática pode ser recusada.
 * Enumerados aqui para que nenhum módulo use string solta.
 */
export type LoopGuardTrigger =
  | 'MAX_ATTEMPTS_REACHED'
  | 'CLAUDE_CALL_BUDGET_EXHAUSTED'
  | 'CODEX_CALL_BUDGET_EXHAUSTED'
  | 'AGENT_CALL_BUDGET_EXHAUSTED'
  | 'PROMPT_TIME_BUDGET_EXHAUSTED'
  | 'RUN_TIME_BUDGET_EXHAUSTED'
  | 'NO_PROGRESS'
  | 'REPEATED_REVIEW_ISSUES'
  | 'REPEATED_TEST_FAILURE'
  | 'OSCILLATION_DETECTED'
  | 'REVIEW_OSCILLATION_DETECTED'
  | 'PROMPT_CHANGED_DURING_RUN'
  | 'PROJECT_CONTEXT_CHANGED'
  | 'PROJECT_CONFIG_CHANGED'
  | 'POLICY_SNAPSHOT_MISSING'
  | 'SCOPE_VIOLATION'
  | 'FORBIDDEN_AREA_CHANGED'
  | 'DIFF_BUDGET_EXCEEDED'
  | 'INCOMPLETE_REVIEW_EVIDENCE'
  | 'REVIEW_FORMAT_RETRIES_EXHAUSTED'
  | 'INVALID_CHANGES_REQUEST'
  | 'AUTH_REQUIRED'
  | 'USAGE_LIMIT_REACHED'
  | 'TOOL_MISSING'
  | 'PROCESS_TIMEOUT'
  | 'REPEATED_CI_FAILURE'
  | 'CI_WAIT_TIMEOUT'
  | 'CI_REPAIR_BUDGET_EXHAUSTED'
  | 'CI_CONFIGURATION_ERROR'
  | 'CI_REQUIRED_CHECK_MISSING'
  | 'MERGE_CORRECTION_BUDGET_EXHAUSTED'
  | 'USER_PAUSED'
  | 'USER_CANCELLED';

/**
 * `hard_stop` exige que a causa seja corrigida fora do laço: nenhum botão de
 * "continuar" o dispensa. `soft_stop` admite, no máximo, uma tentativa extra
 * autorizada explicitamente por uma pessoa.
 */
export type LoopGuardSeverity = 'none' | 'soft_stop' | 'hard_stop';

export type LoopGuardNextAction =
  | 'OPEN_REPORT'
  | 'OPEN_DIFF'
  | 'OPEN_TESTS'
  | 'OPEN_REVIEW'
  | 'EDIT_PROMPT'
  | 'AUTHORIZE_EXTRA_ATTEMPT'
  | 'MARK_FOR_MANUAL_REVIEW'
  | 'SKIP_PROMPT'
  | 'CANCEL_RUN'
  | 'FIX_AUTH'
  | 'WAIT_QUOTA'
  | 'INSTALL_TOOL'
  | 'SPLIT_PROMPT'
  | 'START_NEW_RUN';

export interface LoopGuardDecision {
  allowed: boolean;
  severity: LoopGuardSeverity;
  trigger: LoopGuardTrigger | null;
  reason: string;
  evidence: Readonly<Record<string, unknown>>;
  nextActions: LoopGuardNextAction[];
}

/** Assinaturas normalizadas usadas para detectar repetição e oscilação. */
export interface LoopFingerprints {
  diff: string;
  review: string | null;
  testFailure: string | null;
}

/** Contadores e evidências de uma tentativa, persistidos com o estado. */
export interface AttemptLoopEvidence {
  attempt: number;
  claudeCallCount: number;
  codexCallCount: number;
  totalAgentCallCount: number;

  promptSnapshotHash: string;
  projectContextHash: string;
  projectConfigHash: string;

  diffFingerprintBefore: string;
  diffFingerprintAfter: string;
  reviewFingerprint: string | null;
  testFailureFingerprint: string | null;

  changedFileCount: number;
  changedLineCount: number;

  elapsedPromptMs: number;
  noProgressCount: number;
  repeatedReviewCount: number;
  repeatedTestFailureCount: number;

  triggered: LoopGuardTrigger | null;
}

/**
 * Orçamento acumulado de um prompt dentro de uma execução.
 * Sobrevive à retomada: retomar nunca zera o que já foi consumido.
 */
export interface PromptBudget {
  promptId: string;
  attempts: number;
  claudeCalls: number;
  codexCalls: number;
  reviewFormatRetries: number;
  startedAt: string | null;
  consumedMs: number;
  manualOverridesUsed: number;
  /* Históricos limitados: só existem para detectar repetição. */
  diffFingerprints: string[];
  reviewFingerprints: string[];
  testFailureFingerprints: string[];
  lastTrigger: LoopGuardTrigger | null;
  lastDecisionAt: string | null;
}

/** Autorização humana, pontual e não reutilizável, de uma tentativa extra. */
export interface ManualOverride {
  promptId: string;
  trigger: LoopGuardTrigger;
  authorizedAt: string;
  authorizedBy: string;
  justification: string;
  consumed: boolean;
}

export interface ProjectGitConfig {
  commitAfterApproval: boolean;
  pushAfterRun: boolean;
  commitMessagePrefix: string;
}

export interface ProjectPullRequestConfig {
  enabled: boolean;
  draftDuringExecution: boolean;
  markReadyBeforeMerge: boolean;
  waitForChecks: boolean;
}

export interface ProjectMergeConfig {
  enabled: boolean;
  mode: MergeMode;
  strategy: MergeStrategy;
  deleteBranchAfterMerge: boolean;
  requireClaudeApproval: boolean;
  requireCodexApproval: boolean;
  requireLocalTests: boolean;
  requireCiSuccess: boolean;
  requireNoConflicts: boolean;
  requireNoUnresolvedThreads: boolean;
  invalidateApprovalOnHeadChange: boolean;
  minimumConfidence: number;
}

export interface ProjectAgentsConfig {
  claudeModel: string | null;
  codexModel: string | null;
}

export interface ProjectConfig {
  id: string;
  name: string;
  repositoryPath: string;
  githubRepository: string;
  remote: string;
  baseBranch: string;
  branchStrategy: BranchStrategy;
  worktree: ProjectWorktreeConfig;
  commands: ProjectCommandsConfig;
  execution: ProjectExecutionConfig;
  git: ProjectGitConfig;
  pullRequest: ProjectPullRequestConfig;
  merge: ProjectMergeConfig;
  agents: ProjectAgentsConfig;
  editor?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

/* ------------------------------------------------------------------------- */
/* Política efetiva congelada                                                 */
/* ------------------------------------------------------------------------- */

/**
 * Política do Loop Guard já resolvida, com os tetos que moram fora de
 * `loopGuard` no cadastro.
 *
 * `maxAttemptsPerPrompt` vive em `ProjectExecutionConfig`, não em
 * `LoopGuardConfig`. Enquanto o guard precisar buscá-lo em outro lugar, sempre
 * haverá um caminho que lê o cadastro vivo — foi exatamente assim que o
 * denominador "3/5" apareceu no painel. Aqui os dois andam juntos.
 */
export interface EffectiveLoopGuardPolicy extends LoopGuardConfig {
  maxAttemptsPerPrompt: number;
  maxReviewerRetries: number;
  continueAfterApproval: boolean;
  stopOnBlocked: boolean;
}

/**
 * Orçamento do CI — o CI é um laço como qualquer outro.
 *
 * Sem teto, uma PR com check travado espera para sempre e uma falha
 * determinística consome correção após correção sem nunca convergir.
 */
export interface EffectiveCiPolicy {
  /** Quantas vezes o Claude pode tentar corrigir uma falha de CI. */
  maxRepairCycles: number;
  pollingInitialSeconds: number;
  pollingMaxSeconds: number;
  /** Teto HISTÓRICO: conta desde a primeira espera, não desde a retomada. */
  waitTimeoutMinutes: number;
  /** A mesma falha em dois ciclos encerra o laço. */
  stopOnRepeatedFailure: boolean;
}

/** Orçamento das correções pedidas pelas auditorias finais. */
export interface EffectiveMergeAuditPolicy {
  maxCorrectionCycles: number;
}

/**
 * Espera do CI, persistida.
 *
 * Existe para que o timeout seja histórico. Se o relógio recomeçasse a cada
 * retomada, reiniciar o painel renovaria a espera indefinidamente e o teto
 * nunca seria alcançado.
 */
export interface CiWaitState {
  /** Instante da PRIMEIRA espera deste head SHA. Não muda em retomada. */
  startedAt: string;
  headSha: string;
  lastPolledAt: string | null;
  pollCount: number;
  /** Intervalo da próxima consulta, em segundos, já com backoff aplicado. */
  nextIntervalSeconds: number;
}

/** Um ciclo de reparo de CI, registrado no estado. */
export interface CiRepairRecord {
  cycle: number;
  headShaBefore: string;
  fingerprint: string;
  failedChecks: string[];
  startedAt: string;
  finishedAt: string | null;
  outcome: 'REPAIRED' | 'TESTS_FAILED' | 'NO_CHANGES' | 'AGENT_FAILED';
  headShaAfter: string | null;
}

/** Um ciclo de correção pós-auditoria, registrado no estado. */
export interface MergeCorrectionRecord {
  cycle: number;
  headShaBefore: string;
  /** Problemas que os auditores pediram para corrigir. */
  requestedBy: Array<'claude' | 'codex'>;
  issueFingerprint: string;
  startedAt: string;
  finishedAt: string | null;
  outcome: 'CORRECTED' | 'TESTS_FAILED' | 'NO_CHANGES' | 'AGENT_FAILED';
  headShaAfter: string | null;
}

/** Identidade do repositório, congelada: retomar não pode trocar de alvo. */
export interface EffectiveRepositoryPolicy {
  repositoryPath: string;
  githubRepository: string;
  remote: string;
  baseBranch: string;
  branchStrategy: BranchStrategy;
}

/**
 * Fotografia imutável da política que rege UMA execução.
 *
 * Resolvida uma única vez, antes de `createRun()`, e nunca recalculada. Todo
 * consumidor — guard, painel, override, retomada, relatórios, dry-run
 * histórico, e os futuros orçamentos de CI e de auditoria — lê daqui. O
 * cadastro do projeto continua servindo para identidade, permissão e
 * existência; nunca para limites.
 *
 * O envelope é deliberadamente maior que o Loop Guard: congelar só os limites
 * deixaria a retomada trocar a suíte de testes, o modelo do agente ou a branch
 * base debaixo de uma execução já em curso.
 */
export interface EffectiveExecutionPolicySnapshot {
  schemaVersion: 1;
  capturedAt: string;

  sources: {
    globalConfigHash: string;
    projectConfigHash: string;
    /** `null` significa "esta fase não tem rodada", não "rodada vazia". */
    roundConfigHash: string | null;
  };

  /**
   * Identidade da política resolvida. Muda se, e só se, a política mudar.
   *
   * Duas execuções sob a mesma política têm o mesmo valor — não cobre o
   * envelope (`capturedAt`, origens, procedência), que varia entre execuções
   * idênticas. Para comparação e exibição.
   */
  effectiveHash: string;

  /**
   * Prova de não-adulteração do snapshot inteiro, `sourceMetadata` inclusive.
   *
   * Diferente de `effectiveHash`, cobre a procedência: sem isso, as marcas que
   * declaram um snapshot materializado poderiam ser removidas no disco para que
   * ele se passasse por congelamento histórico legítimo.
   */
  integrityHash: string;

  loopGuard: EffectiveLoopGuardPolicy;
  ci: EffectiveCiPolicy;
  mergeAudit: EffectiveMergeAuditPolicy;
  commands: ProjectCommandsConfig;
  agents: ProjectAgentsConfig;
  git: ProjectGitConfig;
  pullRequest: ProjectPullRequestConfig;
  merge: ProjectMergeConfig;
  repository: EffectiveRepositoryPolicy;
  worktree: ProjectWorktreeConfig;

  sourceMetadata: {
    projectId: string;
    roundId: string | null;
    projectUpdatedAt: string | null;
    /**
     * Verdadeiro quando o snapshot foi materializado depois do início da
     * execução, para uma execução legada. Não é reconstrução histórica: é uma
     * declaração explícita de que a política original se perdeu.
     */
    materializedFromLegacyRun?: boolean;
    materializedAt?: string;
    materializedBy?: string;
  };
}

/**
 * Hashes das fontes no instante do congelamento.
 *
 * Separados de `effectivePolicy.sources` de propósito: aquele grupo descreve
 * de onde a política veio; este é o que a detecção de mutação compara contra o
 * disco a cada volta do laço.
 */
export interface RunSourceSnapshots {
  /** Hash do conteúdo de cada prompt, por `promptId`. */
  promptHashes: Record<string, string>;
  /** Hash do conjunto de prompts: pega inclusão e remoção, não só edição. */
  promptSetHash: string;
  projectContextHash: string | null;
  projectConfigHash: string;
  roundConfigHash: string | null;
}

/* ------------------------------------------------------------------------- */
/* Pacotes curados                                                            */
/* ------------------------------------------------------------------------- */

/**
 * Pacote de prompts curado FORA do OrqPEG.
 *
 * O OrqPEG não planeja projetos. O plano nasce do trabalho da pessoa com um
 * modelo de conversa, é validado à mão, e só então é importado aqui para ser
 * executado. Por isso o importador valida e recusa, mas nunca completa,
 * reescreve ou conserta: um pacote inválido é um pacote inválido, e "corrigido
 * automaticamente" seria o OrqPEG decidindo o que o autor quis dizer.
 */
export interface PackageValidation {
  /** Só `approved` permite executar. Qualquer outro valor bloqueia. */
  status: 'approved' | 'draft' | 'rejected';
  /** Commit do repositório-alvo contra o qual o pacote foi validado. */
  validatedCommitSha: string;
  validatedAt: string;
  validatedBy: string;
  notes?: string;
}

/** Skills declaradas por uma rodada, por agente. Formato `<id>@<versão>`. */
export interface RoundSkillDeclaration {
  claude: string[];
  codex: string[];
}

export interface PackageRound {
  id: string;
  name: string;
  objective: string;
  order: number;
  /** Ids de outras rodadas que precisam estar concluídas antes desta. */
  dependsOn: string[];
  /** Nomes dos arquivos de prompt, na ordem de execução. */
  prompts: string[];
  skills: RoundSkillDeclaration;
}

export interface PackageExecutionPlan {
  schemaVersion: 1;
  packageId: string;
  name: string;
  description: string;
  validation: PackageValidation;
  branchStrategy: BranchStrategy;
  pullRequest: {
    /** Uma PR por rodada é o padrão: a rodada é a unidade de revisão. */
    perRound: boolean;
    draftDuringExecution: boolean;
    waitForChecks: boolean;
  };
  /**
   * Encadear rodadas automaticamente. `false` por padrão: terminar uma rodada
   * é um bom momento para uma pessoa olhar antes de gastar a próxima.
   */
  continueBetweenRounds: boolean;
  loopGuard?: Partial<LoopGuardConfig>;
  rounds: Array<{ id: string; order: number; dependsOn: string[] }>;
}

/** Pacote lido e validado, ainda não importado. */
export interface CuratedPackage {
  rootPath: string;
  plan: PackageExecutionPlan;
  rounds: PackageRound[];
  /** Hash do conteúdo inteiro do pacote, para congelamento e comparação. */
  packageHash: string;
  documents: {
    projectContext: string;
    roadmap: string;
    validation: string;
  };
}

/** Registro de um pacote já importado para a área de dados do projeto. */
export interface ImportedPackageRecord {
  packageId: string;
  name: string;
  version: string;
  packageHash: string;
  sourcePath: string;
  importedAt: string;
  validatedCommitSha: string;
  roundIds: string[];
}

/* ------------------------------------------------------------------------- */
/* Skills locais                                                              */
/* ------------------------------------------------------------------------- */

/**
 * Skill local declarativa.
 *
 * Nesta versão a Skill é DOCUMENTO, não código: entra no prompt do agente e
 * nada mais. Sem marketplace, sem download, sem descoberta automática e sem
 * execução de script — o que reduziria a Skill a um vetor para rodar código
 * arbitrário sob a assinatura do usuário.
 */
export interface SkillManifest {
  id: string;
  name: string;
  version: string;
  description: string;
  /** Só `approved` pode ser ativada. */
  status: 'approved' | 'draft' | 'deprecated';
  compatibleAgents: Array<'claude' | 'codex'>;
  roles: string[];
  entrypoint: string;
  /** Precisa ser `false` nesta versão. `true` é recusado na leitura. */
  executeScripts: boolean;
  /** Precisa ser `false` nesta versão. */
  networkAccess: boolean;
}

/** Skill carregada do catálogo, com o conteúdo e o hash do documento. */
export interface LoadedSkill {
  manifest: SkillManifest;
  category: string;
  directory: string;
  /** Conteúdo do `SKILL.md`, que é o que de fato chega ao agente. */
  content: string;
  contentHash: string;
}

/** Skills congeladas para uma execução, por agente. */
export interface SkillSnapshot {
  capturedAt: string;
  claude: Array<{ id: string; version: string; contentHash: string }>;
  codex: Array<{ id: string; version: string; contentHash: string }>;
}

/* ------------------------------------------------------------------------- */
/* Prompts                                                                    */
/* ------------------------------------------------------------------------- */

export type PromptStatus =
  | 'PENDING'
  | 'RUNNING'
  | 'CHANGES_REQUESTED'
  | 'APPROVED'
  | 'BLOCKED'
  | 'SKIPPED'
  | 'FAILED';

export interface PromptFile {
  /** Identificador estável derivado do nome do arquivo (sem extensão). */
  id: string;
  /** Nome legível extraído do arquivo ou derivado do id. */
  name: string;
  fileName: string;
  absolutePath: string;
  /** Chave de ordenação natural (numérica quando houver prefixo). */
  order: number;
  sizeBytes: number;
}

export interface PromptProgress {
  promptId: string;
  status: PromptStatus;
  attempts: number;
  lastAttemptAt: string | null;
  approvedAt: string | null;
  commitSha: string | null;
  lastVerdict: ReviewVerdict | null;
  blockingIssueCount: number;
}

/* ------------------------------------------------------------------------- */
/* Execução de processos                                                      */
/* ------------------------------------------------------------------------- */

export type ProcessStatus =
  | 'COMPLETED'
  | 'FAILED'
  | 'TIMEOUT'
  | 'INTERRUPTED'
  | 'COMMAND_NOT_FOUND';

export interface ProcessResult {
  command: string;
  args: string[];
  cwd: string;
  status: ProcessStatus;
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  timedOut: boolean;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
}

export interface ProcessRunOptions {
  cwd: string;
  timeoutMs: number;
  /** Ambiente já sanitizado; quando ausente o runner sanitiza process.env. */
  env?: NodeJS.ProcessEnv;
  input?: string;
  maxOutputBytes?: number;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
  signal?: AbortSignal;
}

/* ------------------------------------------------------------------------- */
/* Testes                                                                     */
/* ------------------------------------------------------------------------- */

export type TestStatus =
  | 'PASSED'
  | 'FAILED'
  | 'TIMEOUT'
  | 'INTERRUPTED'
  | 'COMMAND_NOT_FOUND'
  | 'NOT_RUN';

export interface TestCommandResult {
  command: string;
  cwd: string;
  status: TestStatus;
  exitCode: number | null;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  stdout: string;
  stderr: string;
}

export interface TestSuiteResult {
  status: TestStatus;
  passed: boolean;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  commands: TestCommandResult[];
  failedCommands: string[];
}

/* ------------------------------------------------------------------------- */
/* Revisão de prompt (Codex)                                                  */
/* ------------------------------------------------------------------------- */

export type ReviewVerdict = 'APPROVED' | 'CHANGES_REQUESTED' | 'BLOCKED';
export type IssueSeverity = 'blocking' | 'major' | 'minor' | 'info';
export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';

export interface ReviewIssue {
  severity: IssueSeverity;
  title: string;
  description: string;
  file?: string;
  line?: number;
  suggestion?: string;
}

export interface PromptReview {
  verdict: ReviewVerdict;
  summary: string;
  confidence: number;
  meetsPromptRequirements: boolean;
  blockingIssues: ReviewIssue[];
  nonBlockingIssues: ReviewIssue[];
  requiredActions: string[];
  scopeAssessment: {
    withinScope: boolean;
    unexpectedChanges: string[];
  };
  testsAssessment: {
    localTestsPassed: boolean;
    coverageAcceptable: boolean;
  };
  riskAssessment: {
    level: RiskLevel;
    summary: string;
  };
}

/* ------------------------------------------------------------------------- */
/* Auditoria final de merge (Claude e Codex)                                  */
/* ------------------------------------------------------------------------- */

export type MergeVerdict = 'APPROVED_FOR_MERGE' | 'CHANGES_REQUIRED' | 'BLOCKED';

export interface MergeReview {
  verdict: MergeVerdict;
  reviewedHeadSha: string;
  summary: string;
  confidence: number;
  blockingIssues: ReviewIssue[];
  nonBlockingIssues: ReviewIssue[];
  requiredActions: string[];
  riskAssessment: {
    level: RiskLevel;
    summary: string;
  };
  testsAssessment: {
    localTestsPassed: boolean;
    ciPassed: boolean;
    coverageAcceptable: boolean;
  };
  scopeAssessment: {
    withinScope: boolean;
    unexpectedChanges: string[];
  };
}

export interface MergeReviewRecord {
  auditor: 'claude' | 'codex';
  review: MergeReview;
  producedAt: string;
  /** SHA observado pelo OrqPEG no momento em que a auditoria foi disparada. */
  observedHeadSha: string;
  rawOutputPath: string | null;
  /** Invalidada quando o head SHA muda ou um gate reprova posteriormente. */
  invalidated: boolean;
  invalidationReason: string | null;
}

/* ------------------------------------------------------------------------- */
/* Gates de merge                                                             */
/* ------------------------------------------------------------------------- */

export type GateId =
  | 'ALL_PROMPTS_APPROVED'
  | 'ALL_COMMITS_CREATED'
  | 'BRANCH_PUSHED_TO_CORRECT_REMOTE'
  | 'PR_OPEN'
  | 'PR_BASE_CORRECT'
  | 'NO_CONFLICTS'
  | 'LOCAL_TESTS_PASSED'
  | 'REQUIRED_CHECKS_PASSED'
  | 'NO_PENDING_REQUIRED_CHECKS'
  | 'NO_SKIPPED_REQUIRED_CHECKS'
  | 'NO_UNRESOLVED_THREADS'
  | 'NO_HUMAN_CHANGES_REQUESTED'
  | 'CLAUDE_MERGE_APPROVED'
  | 'CODEX_MERGE_APPROVED'
  | 'AUDITORS_SAME_HEAD_SHA'
  | 'MINIMUM_CONFIDENCE_MET'
  | 'NO_BLOCKING_ISSUES'
  | 'HEAD_SHA_UNCHANGED'
  | 'BASE_NOT_INVALIDATED'
  | 'PROJECT_ALLOWS_DUAL_AI_CONSENSUS';

export type GateStatus = 'PASSED' | 'FAILED' | 'SKIPPED' | 'NOT_EVALUATED';

export interface GateResult {
  id: GateId;
  index: number;
  title: string;
  status: GateStatus;
  reason: string;
  evidence?: Readonly<Record<string, unknown>>;
}

export interface MergeGateReport {
  evaluatedAt: string;
  headSha: string;
  baseSha: string;
  allPassed: boolean;
  gates: GateResult[];
  failedGates: GateId[];
}

export interface MergeConsensus {
  reached: boolean;
  headSha: string;
  claude: {
    verdict: MergeVerdict | null;
    confidence: number | null;
    reviewedHeadSha: string | null;
    available: boolean;
  };
  codex: {
    verdict: MergeVerdict | null;
    confidence: number | null;
    reviewedHeadSha: string | null;
    available: boolean;
  };
  sameHeadSha: boolean;
  minimumConfidence: number;
  reasons: string[];
}

export interface MergeOutcome {
  attempted: boolean;
  merged: boolean;
  mergeSha: string | null;
  strategy: MergeStrategy;
  matchedHeadSha: string | null;
  performedAt: string | null;
  reason: string;
  idempotentSkip: boolean;
}

/* ------------------------------------------------------------------------- */
/* GitHub                                                                     */
/* ------------------------------------------------------------------------- */

export type CheckConclusion =
  | 'SUCCESS'
  | 'FAILURE'
  | 'NEUTRAL'
  | 'CANCELLED'
  | 'SKIPPED'
  | 'TIMED_OUT'
  | 'ACTION_REQUIRED'
  | 'STALE'
  | 'STARTUP_FAILURE'
  | 'PENDING';

export interface CheckRun {
  name: string;
  status: 'QUEUED' | 'IN_PROGRESS' | 'COMPLETED' | 'PENDING' | 'UNKNOWN';
  conclusion: CheckConclusion;
  detailsUrl: string | null;
  required: boolean;
  workflowName: string | null;
  startedAt: string | null;
  completedAt: string | null;
}

export interface ChecksSummary {
  headSha: string;
  total: number;
  passed: number;
  failed: number;
  pending: number;
  skipped: number;
  allRequiredPassed: boolean;
  anyRequiredPending: boolean;
  anyRequiredFailed: boolean;
  anyRequiredSkipped: boolean;
  runs: CheckRun[];
}

export interface PullRequestInfo {
  number: number;
  url: string;
  title: string;
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  isDraft: boolean;
  baseRefName: string;
  headRefName: string;
  headSha: string;
  baseSha: string | null;
  mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN';
  mergeStateStatus: string | null;
  merged: boolean;
  mergeCommitSha: string | null;
  reviewDecision: 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | null;
  unresolvedThreadCount: number;
}

/* ------------------------------------------------------------------------- */
/* Git                                                                        */
/* ------------------------------------------------------------------------- */

export interface GitStatusEntry {
  path: string;
  indexStatus: string;
  worktreeStatus: string;
  renamedFrom: string | null;
}

export interface GitStatus {
  branch: string | null;
  ahead: number;
  behind: number;
  clean: boolean;
  entries: GitStatusEntry[];
}

export interface WorktreeInfo {
  path: string;
  branch: string | null;
  headSha: string | null;
  isMain: boolean;
  isDetached: boolean;
  isLocked: boolean;
}

/* ------------------------------------------------------------------------- */
/* Estado de execução                                                         */
/* ------------------------------------------------------------------------- */

export type RunState =
  | 'IDLE'
  | 'VALIDATING'
  | 'PREPARING_WORKTREE'
  | 'RUNNING_CLAUDE'
  | 'RUNNING_TESTS'
  | 'BUILDING_REVIEW_PACKAGE'
  | 'RUNNING_CODEX'
  | 'CHANGES_REQUESTED'
  | 'PROMPT_APPROVED'
  | 'COMMITTING'
  | 'PUSHING'
  | 'CREATING_PR'
  | 'WAITING_CI'
  | 'CI_FAILED'
  | 'RUNNING_CLAUDE_MERGE_AUDIT'
  | 'RUNNING_CODEX_MERGE_AUDIT'
  | 'MERGE_CONSENSUS_PENDING'
  | 'MERGE_APPROVED'
  | 'MERGING'
  | 'MERGED'
  | 'BLOCKED'
  /**
   * A execução parou de propósito, por decisão do Loop Guard. Não é falha
   * inesperada: o estado foi preservado e falta uma decisão humana.
   */
  | 'LOOP_GUARD_TRIGGERED'
  | 'AUTH_REQUIRED'
  | 'USAGE_LIMIT_REACHED'
  | 'INTERRUPTED'
  | 'FAILED'
  | 'COMPLETED'
  | 'CANCELLED';

export interface RunEvent {
  at: string;
  state: RunState;
  message: string;
  data?: Readonly<Record<string, unknown>>;
}

export interface RunRecord {
  schemaVersion: 1;
  runId: string;
  projectId: string;
  state: RunState;
  previousState: RunState | null;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
  dryRun: boolean;

  baseCommitSha: string | null;
  branchName: string | null;
  worktreePath: string | null;
  workingDirectory: string | null;

  prompts: PromptProgress[];
  currentPromptId: string | null;
  currentAttempt: number;

  commits: Array<{ promptId: string; sha: string; message: string; at: string }>;

  pushedAt: string | null;
  pushedRemote: string | null;

  pullRequest: PullRequestInfo | null;
  checks: ChecksSummary | null;

  finalTests: TestSuiteResult | null;

  mergeReviews: MergeReviewRecord[];
  consensus: MergeConsensus | null;
  gateReport: MergeGateReport | null;
  mergeOutcome: MergeOutcome | null;

  events: RunEvent[];
  lastError: OrqError | null;
  pauseRequested: boolean;
  cancelRequested: boolean;

  /* Loop Guard — orçamento e decisões, preservados através de retomadas. */
  budgets: PromptBudget[];
  overrides: ManualOverride[];
  lastLoopGuard: LoopGuardDecision | null;
  ciRepairCycles: number;
  mergeCorrectionCycles: number;

  /** Espera do CI em curso. `null` quando nenhuma espera começou. */
  ciWait: CiWaitState | null;
  /** Assinaturas de falha de CI, na ordem dos ciclos. Detecta repetição. */
  ciFailureFingerprints: string[];
  ciRepairs: CiRepairRecord[];
  mergeCorrections: MergeCorrectionRecord[];

  /**
   * Política congelada no início da execução. Fonte da verdade para todo
   * limite, em toda retomada.
   *
   * `null` só ocorre em execuções criadas antes deste campo existir. É tratado
   * fail-closed: a execução não é retomada em silêncio e o painel declara a
   * política histórica indisponível em vez de inventar denominadores a partir
   * do cadastro atual.
   */
  effectivePolicy: EffectiveExecutionPolicySnapshot | null;
  /** Hashes das fontes no congelamento, comparados contra o disco a cada volta. */
  sourceSnapshots: RunSourceSnapshots | null;

  /**
   * Mantidos por compatibilidade com execuções gravadas antes de
   * `sourceSnapshots`. Escrita nova usa `sourceSnapshots`.
   *
   * @deprecated
   */
  projectContextHash: string | null;
  projectConfigHash: string | null;
}

/* ------------------------------------------------------------------------- */
/* Locks                                                                      */
/* ------------------------------------------------------------------------- */

export type LockScope = 'project' | 'worktree' | 'run' | 'pr' | 'merge' | 'state';

export interface LockInfo {
  scope: LockScope;
  key: string;
  pid: number;
  hostname: string;
  projectId: string | null;
  runId: string | null;
  operation: string;
  acquiredAt: string;
  heartbeatAt: string;
}

export interface LockHandle {
  readonly info: LockInfo;
  release(): Promise<void>;
}

/* ------------------------------------------------------------------------- */
/* Ambiente e diagnóstico                                                     */
/* ------------------------------------------------------------------------- */

export type DiagnosticStatus = 'OK' | 'AVISO' | 'ERRO';

export interface DiagnosticItem {
  id: string;
  category: string;
  title: string;
  status: DiagnosticStatus;
  detail: string;
  remediation?: string;
}

export interface DiagnosticReport {
  generatedAt: string;
  orqpegVersion: string;
  overall: DiagnosticStatus;
  counts: { ok: number; aviso: number; erro: number };
  items: DiagnosticItem[];
}

export interface ToolAvailability {
  name: string;
  command: string;
  available: boolean;
  version: string | null;
  path: string | null;
  authenticated: boolean | null;
  detail: string;
}

export interface ApiGuardReport {
  /** Nomes das variáveis detectadas. Valores nunca são lidos nem gravados. */
  presentKeys: string[];
  warnKeys: string[];
  blocked: boolean;
  strippedForChildren: string[];
}

/* ------------------------------------------------------------------------- */
/* Agentes                                                                    */
/* ------------------------------------------------------------------------- */

export interface AgentInvocation {
  agent: 'claude' | 'codex';
  role: 'executor' | 'corrector' | 'prompt-reviewer' | 'merge-auditor';
  instructionPath: string;
  cwd: string;
  model: string | null;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  status: ProcessStatus;
  exitCode: number | null;
  sessionId: string | null;
  stdoutPath: string;
  stderrPath: string;
  usageLimitReached: boolean;
  authRequired: boolean;
}

export interface AgentRunOptions {
  cwd: string;
  instruction: string;
  timeoutMs: number;
  model?: string | null;
  /** Diretório de artefatos onde os logs desta invocação serão gravados. */
  artifactDir: string;
  /** Modo somente leitura: revisores e auditores nunca podem editar. */
  readOnly: boolean;
  signal?: AbortSignal;
  jsonSchema?: unknown;
}

export interface AgentRunResult {
  invocation: AgentInvocation;
  /** Texto final produzido pelo agente (stdout já normalizado). */
  output: string;
  process: ProcessResult;
}

/* ------------------------------------------------------------------------- */
/* Artefatos e relatórios                                                     */
/* ------------------------------------------------------------------------- */

export interface AttemptSummary {
  runId: string;
  projectId: string;
  promptId: string;
  attempt: number;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  claude: AgentInvocation | null;
  tests: TestSuiteResult | null;
  codex: AgentInvocation | null;
  review: PromptReview | null;
  changedFiles: string[];
  approved: boolean;
  blocked: boolean;
  notes: string[];
}

export interface ReportBundle {
  json: string;
  markdown: string;
  html: string;
}

/* ------------------------------------------------------------------------- */
/* Painel                                                                     */
/* ------------------------------------------------------------------------- */

export interface PanelProjectSummary {
  id: string;
  name: string;
  repositoryPath: string;
  githubRepository: string;
  baseBranch: string;
  worktreeEnabled: boolean;
  promptTotal: number;
  promptApproved: number;
  promptPending: number;
  activeRunId: string | null;
  activeState: RunState | null;
  pullRequestNumber: number | null;
  pullRequestUrl: string | null;
  ciStatus: string | null;
  consensusReached: boolean | null;
  merged: boolean;
  lastError: string | null;
}

export interface PanelHomeData {
  product: string;
  version: string;
  generatedAt: string;
  tools: ToolAvailability[];
  apiGuard: ApiGuardReport;
  projects: PanelProjectSummary[];
  activeRuns: number;
  pausedRuns: number;
  blockedRuns: number;
  recentActivity: RunEvent[];
  recentMerges: Array<{
    projectId: string;
    runId: string;
    prNumber: number | null;
    mergeSha: string | null;
    at: string | null;
  }>;
}
