import * as path from 'node:path';
import type {
  AttemptSummary,
  CiRepairRecord,
  MergeCorrectionRecord,
  EffectiveExecutionPolicySnapshot,
  GlobalConfig,
  Logger,
  LoadedSkill,
  LoopGuardDecision,
  LoopGuardTrigger,
  MergeReview,
  MergeReviewRecord,
  OrqError,
  PromptBudget,
  ProjectConfig,
  PromptFile,
  PromptReview,
  Result,
  RoundSkillDeclaration,
  RunRecord,
  RunSourceSnapshots,
  RunState,
  SkillSnapshot,
  TestSuiteResult,
} from '../types';
import { fail, ok } from '../utils/errors';
import {
  createExclusiveDirSync,
  listDirectoriesSync,
  readJsonSync,
  readTextSync,
  writeArtifactSync,
  writeExclusiveSync,
} from '../utils/fs-atomic';
import {
  attemptArtifactDir,
  ensureDir,
  normalizeForCompare,
  mergeAuditArtifactDir,
  projectArtifactsDir,
  projectDir,
} from '../utils/paths';
import { compactStamp, nowIso, sleep } from '../utils/time';
import { buildRunBranchName } from '../security/branch-name';
import { inspectApiEnvironment } from '../security/api-guard';
import { getProject, readDeclaredLoopGuard } from '../projects/project-store';
import { discoverPrompts, readPrompt } from '../prompts/prompt-store';
import type { ParsedPrompt } from '../prompts/prompt-parser';
import {
  allPromptsApproved,
  createRun,
  invalidateMergeApprovals,
  loadRun,
  saveRun,
  transition,
  updatePromptProgress,
} from '../state/run-state';
import type { IntentWriteMode } from '../state/run-state';
import {
  TRAILER_OPERATION_ID,
  openCommitIntent,
  pendingCommitEntries,
  readTrailer,
  settleCommitIntent,
  withCommitTrailers,
} from '../state/commit-journal';
import { listLocks, withLock } from '../state/locks';
import { buildMergeAuditPackage, buildReviewPackage } from '../review/review-package';
import type { AuditedPromptContent } from '../review/review-package';
import {
  loadSchema,
  parseMergeReview,
  parsePromptReview,
  reviewIsApproval,
} from '../review/review-parser';
import { summarizeTestSuite } from '../tests-runner/test-runner';
import {
  buildClaudeCorrectionInstruction,
  buildClaudeExecutionInstruction,
  buildCiRepairInstruction,
  buildMergeCorrectionInstruction,
  buildClaudeMergeAuditInstruction,
  buildCodexMergeAuditInstruction,
  buildCodexPromptReviewInstruction,
} from '../agents/instruction-builder';
import { evaluateGates } from '../merge/gates';
import { computeConsensus } from '../merge/consensus';
import { defaultWorktreePath } from '../git/worktree';
import { remoteMatchesRepository } from '../git/git';
import { writeRunReport } from '../reports/report-generator';
import { renderLoopGuardReport } from '../reports/loop-guard-report';
import {
  assertRunCanContinue,
  createPromptBudget,
  describeDecision,
  evaluateLoopGuard,
  severityOf,
  wasOverrideApplied,
} from './loop-guard';
import { consumeOverride, hasPendingOverride, pendingOverrideCount } from './override';
import {
  contentHash,
  diffFingerprint,
  measureDiff,
  pushBounded,
  reviewFingerprint,
  stableHash,
  testFailureFingerprint,
} from './fingerprints';
import {
  advanceCiWait,
  decideCi,
  failureSignalsFrom,
  rebaseCiWaitOnHead,
} from './ci-budget';
import {
  assertEffectivePolicySnapshot,
  executionRelevantProjectConfigHash,
  resolveEffectiveExecutionPolicy,
} from './effective-policy';
import type { RoundPolicyOverrides } from './effective-policy';
import {
  loadSkillCatalog,
  renderSkillsForAgent,
  resolveDeclaredSkills,
  snapshotSkills,
  verifySkillsAgainstSnapshot,
} from '../skills/skill-catalog';
import type { ResolvedSkills } from '../skills/skill-catalog';
import { renderPullRequestBody } from './pr-body';
import type { OrchestratorPorts } from './ports';
import { registerRun, releaseRun } from './run-control';
import type { RunController } from './run-control';
import { watchPersistedIntent } from './intent-watcher';
import type { IntentWatcher } from './intent-watcher';

/**
 * Orquestrador do OrqPEG.
 *
 * Implementa o fluxo operacional obrigatório do produto. Regra central: o
 * sistema NUNCA avança porque uma IA declarou que terminou. Toda progressão
 * depende de evidência verificada pelo próprio OrqPEG — testes executados
 * localmente, JSON de revisão válido, checks reais do CI e consenso das duas
 * auditorias sobre exatamente o mesmo head SHA.
 */

export interface RunOptions {
  projectId: string;
  dryRun: boolean;
  resumeRunId?: string | null;
  /**
   * Camada de rodada desta execução, já validada pela fronteira.
   *
   * Só tem efeito quando a execução é NOVA. Numa retomada a política vem
   * congelada de `run.effectivePolicy`, e aceitar uma rodada aqui seria
   * prometer um efeito que não acontece — a fronteira recusa a combinação
   * antes de chegar neste ponto.
   */
  roundConfig?: RoundPolicyOverrides | null;
  config: GlobalConfig;
  logger: Logger;
  ports: OrchestratorPorts;
  signal?: AbortSignal;
  onUpdate?: (run: RunRecord) => void;
}

interface Context {
  project: ProjectConfig;
  config: GlobalConfig;
  logger: Logger;
  ports: OrchestratorPorts;
  /**
   * Sinal do controlador vivo desta execução. SEMPRE definido.
   *
   * Antes ele era opcional e, na prática, nunca abortava: a pausa e o
   * cancelamento gravavam uma marca no JSON que o laço em curso jamais relia.
   * Agora ele é a mesma coisa que o `AbortSignal` de `run-control`, propagado a
   * toda porta que cria processo filho.
   */
  signal: AbortSignal;
  /** Controlador vivo: intenção corrente, etapa e identidade da execução. */
  control: RunController;
  /**
   * Primeira falha de persistência observada, se houve.
   *
   * `save` não pode lançar (interromperia o fluxo em pontos onde há trabalho a
   * preservar), mas o erro também não pode ser descartado: ele é registrado
   * aqui e transformado em parada explícita nos portões críticos, antes de
   * qualquer chamada de IA, commit, push, PR ou merge.
   */
  persistError: OrqError | null;
  onUpdate: ((run: RunRecord) => void) | undefined;
  prompts: PromptFile[];
  workingDir: string;

  /**
   * Política congelada desta execução.
   *
   * `project` continua no contexto para identidade, caminhos e comandos de
   * infraestrutura. Nenhum limite sai dele: quem precisa de teto lê `policy`.
   */
  policy: EffectiveExecutionPolicySnapshot;

  /* --- Evidência corrente, alimentada a cada tentativa -------------------
   * O Loop Guard precisa comparar a tentativa atual com as anteriores. Estes
   * campos guardam o que a última volta produziu, para que a decisão seja
   * tomada sobre fatos e não sobre suposição.
   * -------------------------------------------------------------------- */
  /** Hash do prompt no instante em que a execução começou, por prompt. */
  promptSnapshots: Map<string, string>;
  lastScopeViolations: string[];
  lastForbiddenViolations: string[];
  lastChangedFileCount: number;
  lastChangedLineCount: number;
  lastReviewEvidenceComplete: boolean;
}

/* ------------------------------------------------------------------------- */
/* Entrada pública                                                            */
/* ------------------------------------------------------------------------- */

export async function runProject(options: RunOptions): Promise<Result<RunRecord>> {
  /*
   * O controlador é publicado ANTES de qualquer `await`.
   *
   * Isso não é detalhe de estilo: quem dispara a execução em segundo plano
   * (`startRunInBackground`) precisa que o controlador já exista quando a
   * chamada retorna, senão haveria uma janela — a aquisição do lock, a
   * validação das CLIs — em que pausar ou cancelar não encontraria ninguém
   * para atender e responderia sucesso sem ter parado nada.
   */
  const control = registerRun({
    projectId: options.projectId,
    externalSignal: options.signal,
  });
  if (control === null) {
    return fail(
      'LOCK_HELD',
      `Já existe uma execução em andamento para o projeto "${options.projectId}" neste processo.`,
      { projectId: options.projectId },
    );
  }

  try {
    const locked = await withLock(
      {
        scope: 'project',
        key: options.projectId,
        projectId: options.projectId,
        operation: options.dryRun ? 'dry-run' : 'execução',
      },
      async () => executeWithinLock(options, control),
    );
    if (!locked.ok) return locked;
    return locked.value;
  } finally {
    /* Limpeza em sucesso, falha, cancelamento e exceção — sem exceção. Deixar o
       registro sujo faria a execução seguinte do mesmo projeto ser recusada
       por um controlador que já não existe. */
    releaseRun(control);
  }
}

async function executeWithinLock(
  options: RunOptions,
  control: RunController,
): Promise<Result<RunRecord>> {
  const { logger, config, ports } = options;

  const projectResult = getProject(options.projectId);
  if (!projectResult.ok) return projectResult;
  const project = projectResult.value;

  const guard = inspectApiEnvironment({ config });
  if (guard.blocked) {
    logger.error(
      `Execução bloqueada: variáveis de API detectadas (${guard.presentKeys.join(', ')}).`,
    );
    return fail(
      'API_KEY_PRESENT',
      'Execução de IA bloqueada porque há variáveis de API no ambiente. O OrqPEG opera apenas com as assinaturas Claude Max e ChatGPT Plus.',
      { presentKeys: guard.presentKeys },
    );
  }
  if (guard.warnKeys.length > 0) {
    logger.warn(`Variáveis de roteamento ativas: ${guard.warnKeys.join(', ')}.`);
  }

  const promptsResult = discoverPrompts(project.id);
  if (!promptsResult.ok) return promptsResult;
  const prompts = promptsResult.value;
  if (prompts.length === 0) {
    return fail(
      'PROMPT_NOT_FOUND',
      `Nenhum prompt encontrado para o projeto "${project.name}". Coloque arquivos .md em data/projects/${project.id}/prompts.`,
    );
  }

  let run: RunRecord;
  let policy: EffectiveExecutionPolicySnapshot;

  if (options.resumeRunId) {
    const loaded = loadRun(project.id, options.resumeRunId);
    if (!loaded.ok) return loaded;

    /*
     * Retomada NÃO recompõe a política.
     *
     * A fonte da verdade é `run.effectivePolicy`, congelada quando a execução
     * começou. Uma execução legada, sem snapshot, para aqui em vez de ser
     * retomada em silêncio sob os limites de hoje.
     */
    const asserted = assertEffectivePolicySnapshot(loaded.value);
    if (!asserted.ok) return asserted;
    policy = asserted.value;

    /*
     * A retomada é o ÚNICO ponto em que a intenção é desligada, e por isso é o
     * único que grava em modo `REPLACE`.
     *
     * Limpar apenas na memória não bastaria: a marca continuaria no disco, e a
     * vigília de intenção — que existe justamente para enxergar pedidos vindos
     * de outro processo — leria a pausa antiga e pararia a retomada no primeiro
     * tique. Fica registrado no disco que a folha foi limpa deliberadamente.
     */
    const cleared = saveRun(
      { ...loaded.value, pauseRequested: false, cancelRequested: false },
      'REPLACE',
    );
    if (!cleared.ok) return cleared;
    run = cleared.value;
    logger.info(
      `Retomando execução ${run.runId} no estado ${run.state}, sob a política congelada em ${policy.capturedAt}.`,
    );
  } else {
    const roundConfig = options.roundConfig ?? null;
    const resolved = resolveEffectiveExecutionPolicy({
      globalConfig: config,
      projectConfig: project,
      declaredProjectLoopGuard: readDeclaredLoopGuard(project.id),
      /* Ausência continua sendo `null` explícito — não uma configuração
         inventada com valores neutros. */
      roundConfig,
    });
    if (!resolved.ok) return resolved;
    policy = resolved.value;

    /* As Skills são resolvidas ANTES de a execução existir. Falhar aqui não
       cria registro nenhum: uma rodada que declara Skill que o catálogo não
       tem rodaria sob regras diferentes das que foram validadas, e isso é
       indistinguível de não ter validado. */
    const frozenSkills = freezeDeclaredSkills(roundConfig?.skills ?? null);
    if (!frozenSkills.ok) return frozenSkills;

    run = createRun({
      projectId: project.id,
      dryRun: options.dryRun,
      prompts,
      effectivePolicy: policy,
      /* O hash vem da política já resolvida em vez de ser recalculado aqui:
         duas derivações do mesmo dado divergem no dia em que só uma delas for
         atualizada. */
      sourceSnapshots: captureSourceSnapshots(
        project,
        prompts,
        policy.sources.roundConfigHash,
      ),
      skills: frozenSkills.value,
    });
    logger.info(
      `Nova execução ${run.runId} com ${String(prompts.length)} prompt(s), ` +
        `política ${policy.effectiveHash} congelada` +
        (roundConfig === null ? ' (sem rodada)' : ` na rodada ${roundConfig.roundId}`) +
        `, ${describeFrozenSkills(frozenSkills.value)}.`,
    );
  }

  /* A identidade só existe agora; a partir daqui quem pedir pausa ou
     cancelamento sabe exatamente qual execução está atendendo. */
  control.bindRun(run.runId);

  const ctx: Context = {
    project,
    config,
    logger,
    ports,
    signal: control.signal,
    control,
    persistError: null,
    onUpdate: options.onUpdate,
    prompts,
    workingDir: run.workingDirectory ?? project.repositoryPath,
    policy,
    /* Na retomada, os hashes vêm do disco: recalculá-los aqui compararia a
       edição contra ela mesma e o gatilho nunca dispararia. */
    promptSnapshots: promptSnapshotsOf(run, prompts),
    lastScopeViolations: [],
    lastForbiddenViolations: [],
    lastChangedFileCount: 0,
    lastChangedLineCount: 0,
    lastReviewEvidenceComplete: true,
  };

  /* Vigília da intenção persistida: é o que faz `PAUSAR.cmd`, rodando em outro
     processo, interromper de fato o processo filho desta execução. */
  const watcher: IntentWatcher = watchPersistedIntent({
    projectId: project.id,
    runId: run.runId,
    controller: control,
    onAdopted: (intent) => {
      logger.warn(
        `Intenção de ${intent === 'CANCEL' ? 'cancelamento' : 'pausa'} lida do estado persistido; ` +
          `a etapa "${control.step}" será interrompida.`,
      );
    },
  });

  try {
    return await pipeline(ctx, run);
  } catch (error) {
    return await failFromException(ctx, run, error);
  } finally {
    watcher.stop();
  }
}

/**
 * Encerramento por exceção, SEM apagar o que já foi persistido.
 *
 * O defeito que esta função substitui: o `catch` externo gravava a referência
 * de `run` capturada ANTES da pipeline. Como a pipeline reatribui uma variável
 * local, tudo o que ela havia persistido — prompts aprovados, commits, PR —
 * era sobrescrito pela cópia inicial. Uma exceção no terceiro prompt apagava os
 * dois primeiros do arquivo de estado, e a retomada refazia trabalho aprovado.
 *
 * Agora o registro é RELIDO do disco e a falha é ACRESCENTADA a ele. E se a
 * exceção veio de uma parada pedida pelo usuário, o estado final honra a
 * intenção em vez de rotular tudo como `FAILED` — pausa, cancelamento e falha
 * continuam sendo três coisas distintas.
 */
async function failFromException(
  ctx: Context,
  initial: RunRecord,
  error: unknown,
): Promise<Result<RunRecord>> {
  const reloaded = loadRun(initial.projectId, initial.runId);
  if (!reloaded.ok) {
    ctx.logger.error(
      `Não foi possível reler o estado de ${initial.runId} após a exceção: ${reloaded.error.message}. ` +
        'A falha será registrada sobre a última cópia em memória.',
    );
  }
  /* O fallback é a cópia em memória — nunca a inicial capturada antes da
     pipeline, que é justamente a que apagava o progresso. */
  const base = reloaded.ok ? reloaded.value : initial;

  const message = error instanceof Error ? error.message : String(error);
  const stop = externalStop(ctx, base);

  const finished: RunRecord =
    stop === null
      ? {
          ...transition(base, 'FAILED', 'Falha inesperada na execução.'),
          lastError: { code: 'INTERNAL', message },
        }
      : {
          ...applyExternalStop(ctx, base, stop, `exceção: ${message}`),
          lastError: { code: 'CANCELLED', message },
        };

  const saved = saveRun(finished);
  if (!saved.ok) {
    ctx.logger.error(
      `Falha ao persistir o desfecho da exceção em ${initial.runId}: ${saved.error.message}`,
      { code: saved.error.code },
    );
  }
  ctx.onUpdate?.(saved.ok ? saved.value : finished);

  if (stop !== null) {
    return ok(saved.ok ? saved.value : finished);
  }
  return fail('INTERNAL', 'Falha inesperada na execução.', { runId: initial.runId }, error);
}

/* ------------------------------------------------------------------------- */
/* Pipeline                                                                   */
/* ------------------------------------------------------------------------- */

async function pipeline(ctx: Context, initial: RunRecord): Promise<Result<RunRecord>> {
  let run = initial;

  const beforePreparing = haltIfRequested(ctx, run, 'preparação');
  if (beforePreparing) return ok(beforePreparing);

  const prepared = await prepare(ctx, run);
  if (!prepared.ok) return prepared;
  run = prepared.value;
  ctx.workingDir = run.workingDirectory ?? ctx.project.repositoryPath;

  const afterPreparing = haltIfRequested(ctx, run, 'após a preparação');
  if (afterPreparing) return ok(afterPreparing);

  /*
   * Conciliação do diário de commits, antes de qualquer prompt.
   *
   * É aqui que uma queda entre `git commit` e a gravação do estado é reparada:
   * o commit órfão é reencontrado pelo carimbo, validado e adotado. Sem esta
   * passagem, o prompt correspondente seria reexecutado e commitado de novo.
   * Roda também em execução nova — custa uma leitura de arquivo quando não há
   * nada pendente, e cobre o caso de um worktree reaproveitado.
   */
  if (!run.dryRun) {
    const reconciled = await reconcileCommitJournal(ctx, run);
    if (!reconciled.ok) return reconciled;
    run = reconciled.value;
  }

  if (run.dryRun) {
    run = saveStop(ctx, transition(run, 'COMPLETED', 'Dry-run concluído: nenhuma alteração real.'));
    writeRunReport({ project: ctx.project, run });
    return ok(run);
  }

  const executed = await executePromptLoop(ctx, run);
  if (!executed.ok) return executed;
  run = executed.value;

  if (!allPromptsApproved(run)) {
    /*
     * O estado de parada já definido pelo laço é PRESERVADO.
     *
     * Quando o Loop Guard interrompe, ele nomeia o motivo (LOOP_GUARD_TRIGGERED
     * com gatilho e relatório). Sobrescrever isso aqui por um BLOCKED genérico
     * apagaria a causa da linha do tempo e faria a parada consciente parecer
     * uma falha qualquer. Só descrevemos a interrupção quando nenhum estado de
     * parada específico foi registrado.
     */
    if (!isStopState(run.state)) {
      run = saveStop(
        ctx,
        transition(
          run,
          'BLOCKED',
          'Nem todos os prompts foram aprovados; publicação interrompida.',
        ),
      );
    } else {
      ctx.logger.info(
        `Publicação interrompida: a execução parou em ${run.state}${
          run.lastLoopGuard?.trigger ? ` (${run.lastLoopGuard.trigger})` : ''
        }.`,
      );
    }
    writeRunReport({ project: ctx.project, run });
    return ok(run);
  }

  /* Nenhuma publicação começa depois que a intenção foi aceita: push, PR e
     merge são justamente o que o cancelamento precisa impedir. */
  const beforePublish = haltIfRequested(ctx, run, 'publicação');
  if (beforePublish) {
    writeRunReport({ project: ctx.project, run: beforePublish });
    return ok(beforePublish);
  }

  const persistedOk = assertPersistence(ctx, 'publicação');
  if (!persistedOk.ok) return persistedOk;

  const published = await publish(ctx, run);
  if (!published.ok) return published;
  run = published.value;

  // Sem push, PR e CI verdes não há o que auditar para merge. Interromper aqui
  // evita gastar duas auditorias de IA sobre um estado que já reprovou.
  if (!canProceedToAudit(run)) {
    writeRunReport({ project: ctx.project, run });
    return ok(run);
  }

  const beforeAudit = haltIfRequested(ctx, run, 'auditoria final');
  if (beforeAudit) {
    writeRunReport({ project: ctx.project, run: beforeAudit });
    return ok(beforeAudit);
  }

  const audited = await auditAndMerge(ctx, run);
  if (!audited.ok) return audited;
  run = audited.value;

  writeRunReport({ project: ctx.project, run });
  return ok(run);
}

/* ------------------------------------------------------------------------- */
/* Etapa 1 — preparação                                                       */
/* ------------------------------------------------------------------------- */

async function prepare(ctx: Context, input: RunRecord): Promise<Result<RunRecord>> {
  /*
   * `prepare()` apenas CONFERE a política congelada.
   *
   * Ele rodava também na retomada e reescrevia os hashes com os valores de
   * agora — o que apagava a única evidência de que o cadastro havia sido
   * editado entre a parada e a retomada, e transformava a detecção de mutação
   * em código morto. Aqui não se recalcula, não se substitui, não se atualiza
   * e não se recaptura.
   */
  const asserted = assertEffectivePolicySnapshot(input);
  if (!asserted.ok) return asserted;

  const validatingSaved = persistCheckpoint(
    ctx,
    transition(input, 'VALIDATING', 'Validando configuração e ferramentas.'),
    'entrada em VALIDATING',
  );
  if (!validatingSaved.ok) return validatingSaved;
  let run = validatingSaved.value;

  const { project, ports, config, logger } = ctx;

  const claudeOk = await ports.agents.claudeAvailable(config);
  if (!claudeOk) {
    run = saveStop(
      ctx,
      transition(run, 'AUTH_REQUIRED', 'Claude Code não está disponível no PATH.'),
    );
    return fail(
      'TOOL_MISSING',
      'Claude Code (comando "claude") não foi encontrado. Instale-o e autentique com a assinatura Claude Max.',
    );
  }

  // A ausência do Codex não impede a execução dos prompts, mas impede o merge:
  // o gate CODEX_MERGE_APPROVED reprovará. O usuário é avisado desde já.
  const codexOk = await ports.agents.codexAvailable(config);
  if (!codexOk) {
    logger.warn(
      'Codex CLI não encontrado. A revisão e a auditoria do Codex ficarão indisponíveis e o merge automático permanecerá BLOQUEADO.',
    );
  }

  const remote = await ports.git.remoteUrl(project.repositoryPath, project.remote);
  if (!remote.ok) return remote;
  if (!remoteMatchesRepository(remote.value, project.githubRepository)) {
    run = saveStop(ctx, transition(run, 'FAILED', 'Remoto do projeto não confere.'));
    return fail(
      'REMOTE_MISMATCH',
      `O remoto "${project.remote}" não aponta para ${project.githubRepository}. Push e merge foram impedidos por segurança.`,
      { expected: project.githubRepository },
    );
  }

  /*
   * O SHA-base é congelado na PRIMEIRA preparação e nunca recalculado.
   *
   * Recalculá-lo na retomada rebaseava a execução silenciosamente: o diff
   * entregue aos auditores passava a ser medido contra um ponto mais recente
   * — inclusive contra commits que a própria execução acabara de criar. Foi
   * assim que a conciliação de um commit órfão deixou de encontrá-lo: a busca
   * `base..HEAD` começava DEPOIS do commit procurado.
   */
  const existingBase = run.baseCommitSha;
  const baseSha = existingBase
    ? ok(existingBase)
    : await ports.git.headSha(project.repositoryPath);
  if (!baseSha.ok) return baseSha;

  const branchResult = buildRunBranchName(project.id, run.runId.replace(/^run-/, ''));
  if (!branchResult.ok) return branchResult;
  const branchName = branchResult.value;

  if (run.dryRun) {
    const worktreePath = resolveWorktreePath(project, run.runId);
    run = saveStop(ctx, {
      ...transition(run, 'PREPARING_WORKTREE', 'Dry-run: worktree apenas simulado.'),
      baseCommitSha: baseSha.value,
      branchName,
      worktreePath,
      workingDirectory: project.repositoryPath,
    });
    return ok(run);
  }

  /* A branch e o SHA-base precisam estar no disco ANTES de qualquer escrita no
     repositório: é por eles que a retomada e a conciliação se orientam. */
  const preparingSaved = persistCheckpoint(
    ctx,
    {
      ...transition(run, 'PREPARING_WORKTREE', 'Preparando branch e worktree.'),
      baseCommitSha: baseSha.value,
      branchName,
    },
    'registro da branch e do SHA-base',
  );
  if (!preparingSaved.ok) return preparingSaved;
  run = preparingSaved.value;

  if (!project.worktree.enabled) {
    return persistCheckpoint(
      ctx,
      { ...run, workingDirectory: project.repositoryPath, worktreePath: null },
      'diretório de trabalho no próprio repositório',
    );
  }

  const worktreePath = resolveWorktreePath(project, run.runId);

  /*
   * Retomada adota o próprio worktree, sujo ou não — mediante PROVA.
   *
   * A regra de "não reaproveitar worktree sujo" existe para impedir que uma
   * execução se aproprie do trabalho pendente de outra. Ao retomar, a sujeira é
   * o trabalho que o OrqPEG preservou de propósito ao parar, e recriar o
   * worktree perderia exatamente o que se quis proteger.
   *
   * O que mudou é o critério. Antes, a única evidência era
   * `git -C <caminho> rev-parse --abbrev-ref HEAD` — e `git -C` responde pelo
   * repositório que CONTÉM o diretório, então a resposta certa podia vir de
   * outro worktree, ou de um diretório que nem worktree registrado era. Um
   * merge em conflito, que mantém o HEAD anexado, também passava. Agora a
   * adoção exige prova positiva de propriedade e ausência de operação Git pela
   * metade; qualquer falha para a execução com o motivo nomeado.
   */
  if (run.worktreePath && run.branchName === branchName) {
    const owned = await ports.worktree.verifyOwnership({
      repoDir: project.repositoryPath,
      worktreePath: run.worktreePath,
      canonicalPath: worktreePath,
      branch: branchName,
      allowedRoot: worktreeRootOf(project),
    });
    if (!owned.ok) {
      saveStop(
        ctx,
        transition(
          run,
          'BLOCKED',
          `O worktree registrado nesta execução não pôde ser adotado: ${owned.error.message}`,
          { code: owned.error.code },
        ),
      );
      return owned;
    }

    /*
     * Lock de escopo `worktree`, além do lock de projeto.
     *
     * O lock de projeto serializa execuções do MESMO projeto. Ele não impede
     * que dois projetos apontem para o mesmo diretório de worktree por engano
     * de cadastro; a chave aqui é o caminho, e o dono é o runId.
     */
    const claim = await claimWorktree(ctx, run, run.worktreePath);
    if (!claim.ok) {
      saveStop(ctx, transition(run, 'BLOCKED', claim.error.message, { code: claim.error.code }));
      return claim;
    }

    ctx.logger.info(
      `Retomando no worktree já existente desta execução: ${run.worktreePath}`,
    );
    return persistCheckpoint(
      ctx,
      { ...run, workingDirectory: run.worktreePath },
      'adoção do worktree da execução',
    );
  }

  const prepared = await ports.worktree.prepare({
    repoDir: project.repositoryPath,
    worktreePath,
    branch: branchName,
    baseRef: baseSha.value,
    reuseWhenSafe: project.worktree.reuseWhenSafe,
  });
  if (!prepared.ok) {
    saveStop(ctx, transition(run, 'FAILED', 'Falha ao preparar o worktree.'));
    return prepared;
  }

  return persistCheckpoint(
    ctx,
    { ...run, worktreePath: prepared.value.path, workingDirectory: prepared.value.path },
    'registro do worktree preparado',
  );
}

function worktreeRootOf(project: ProjectConfig): string {
  return project.worktree.rootPath ?? path.join(project.repositoryPath, '..', 'AI-Worktrees');
}

function resolveWorktreePath(project: ProjectConfig, runId: string): string {
  return defaultWorktreePath(worktreeRootOf(project), project.id, runId);
}

/**
 * Verifica que nenhum OUTRO `runId` detém o worktree.
 *
 * Lock existente do mesmo run é normal: é o rastro da execução anterior deste
 * mesmo trabalho. Lock de outro run significa que há duas execuções apontando
 * para o mesmo diretório — situação que só se resolve com decisão humana.
 */
async function claimWorktree(
  ctx: Context,
  run: RunRecord,
  worktreePath: string,
): Promise<Result<void>> {
  const key = normalizeForCompare(worktreePath);
  const existing = listLocks().find(
    (lock) => lock.scope === 'worktree' && normalizeForCompare(lock.key) === key,
  );

  if (existing && existing.runId !== null && existing.runId !== run.runId) {
    return fail(
      'WORKTREE_OWNERSHIP_MISMATCH',
      `O worktree ${worktreePath} está reservado pela execução ${existing.runId} (${existing.operation}, desde ${existing.acquiredAt}). Worktree sujo de outra execução não é adotado.`,
      { worktreePath, holder: existing.runId, requester: run.runId },
    );
  }

  ctx.logger.debug?.(`Worktree ${worktreePath} adotado pela execução ${run.runId}.`);
  return ok(undefined);
}

/* ------------------------------------------------------------------------- */
/* Etapa 2 — laço de prompts                                                  */
/* ------------------------------------------------------------------------- */

async function executePromptLoop(ctx: Context, input: RunRecord): Promise<Result<RunRecord>> {
  let run = input;

  for (const promptFile of ctx.prompts) {
    const progress = run.prompts.find((p) => p.promptId === promptFile.id);
    if (progress?.status === 'APPROVED') {
      ctx.logger.info(`Prompt ${promptFile.id} já aprovado; pulando.`);
      continue;
    }

    const halted = haltIfRequested(ctx, run, `prompt ${promptFile.id}`);
    if (halted) return ok(halted);

    const parsed = readPrompt(promptFile);
    if (!parsed.ok) return parsed;

    const outcome = await executeSinglePrompt(ctx, run, promptFile, parsed.value);
    if (!outcome.ok) return outcome;
    run = outcome.value;

    const current = run.prompts.find((p) => p.promptId === promptFile.id);
    if (current?.status !== 'APPROVED') {
      if (ctx.policy.loopGuard.stopOnBlocked) {
        ctx.logger.warn(`Prompt ${promptFile.id} não aprovado. Interrompendo conforme política.`);
        return ok(run);
      }
      ctx.logger.warn(`Prompt ${promptFile.id} não aprovado. Continuando conforme política.`);
    }
  }

  return ok(run);
}

async function executeSinglePrompt(
  ctx: Context,
  input: RunRecord,
  promptFile: PromptFile,
  parsed: ParsedPrompt,
): Promise<Result<RunRecord>> {
  let run = input;
  const { project, config, logger, ports } = ctx;
  const maxAttempts = Math.max(1, ctx.policy.loopGuard.maxAttemptsPerPrompt);

  let previousReview: PromptReview | null = null;
  let lastTests: TestSuiteResult | null = null;

  /*
   * A numeração continua de onde parou, e o teto inclui as tentativas extras
   * já autorizadas por uma pessoa.
   *
   * Continuar a contagem não é cosmético: o diretório de artefatos é
   * `attempt-<n>`. Reiniciar em 1 ao retomar SOBRESCREVIA a evidência da
   * primeira tentativa original — diff, saída do Claude, testes e revisão do
   * Codex eram substituídos e perdidos. Sem o teto estendido, por sua vez, um
   * override concedido nunca seria exercido: o `for` terminaria antes de o
   * portão ser consultado.
   */
  const alreadyAttempted = budgetOf(run, promptFile.id).attempts;
  const effectiveMaxAttempts = maxAttempts + pendingOverrideCount(run, promptFile.id);

  for (let attempt = alreadyAttempted + 1; attempt <= effectiveMaxAttempts; attempt += 1) {
    /* Nenhuma tentativa nova depois de a intenção ter sido aceita, e nenhuma
       tentativa nova com o estado sem conseguir ser gravado. */
    const beforeAttempt = haltIfRequested(
      ctx,
      run,
      `${promptFile.id}: início da tentativa ${String(attempt)}`,
    );
    if (beforeAttempt) return ok(beforeAttempt);

    const persistedOk = assertPersistence(ctx, `${promptFile.id}: início da tentativa`);
    if (!persistedOk.ok) return persistedOk;

    /* ---------------------------------------------------------------------
     * Portão do Loop Guard.
     *
     * Nenhuma chamada de IA acontece sem passar por aqui. A decisão é tomada
     * ANTES de gastar a assinatura, e a ausência de motivo para parar não é
     * autorização: `assertRunCanContinue` exige aprovação explícita.
     * ------------------------------------------------------------------- */
    const gateDecision = decideNextAttempt(ctx, run, promptFile.id, attempt, {
      previousReview,
      lastTests,
    });
    const gate = assertRunCanContinue(gateDecision);
    if (!gate.canContinue) {
      run = saveStop(ctx, applyLoopGuardStop(ctx, run, promptFile.id, gateDecision));
      return ok(run);
    }

    // A autorização é consumida no instante da passagem, não ao fim da
    // tentativa: se o processo cair no meio, ela não volta a valer.
    if (wasOverrideApplied(gateDecision)) {
      run = saveStop(ctx, consumeOverride(run, promptFile.id));
      ctx.logger.warn(
        `Tentativa ${attempt} de ${promptFile.id} liberada por autorização manual ` +
          `(gatilho suprimido: ${String(gateDecision.evidence['suppressedTrigger'])}).`,
      );
    }

    /*
     * O diretório da tentativa não pode existir.
     *
     * A numeração já deriva do contador persistido, o que resolve a causa
     * lógica. Esta é a proteção física: se o número repetir por qualquer
     * motivo — registro restaurado de backup, cópia manual, defeito futuro — o
     * sistema para em vez de truncar a evidência da tentativa anterior.
     */
    const attemptDirResult = createExclusiveDirSync(
      attemptArtifactDir(project.id, run.runId, promptFile.id, attempt),
    );
    if (!attemptDirResult.ok) {
      run = saveStop(
        ctx,
        transition(
          run,
          'FAILED',
          `Artefatos da tentativa ${String(attempt)} de ${promptFile.id} já existem em disco.`,
        ),
      );
      return attemptDirResult;
    }
    const artifactDir = attemptDirResult.value;
    const attemptStartedAt = nowIso();

    const clockSaved = persistCheckpoint(
      ctx,
      startPromptClock(run, promptFile.id, attemptStartedAt),
      `${promptFile.id}: relógio da tentativa ${String(attempt)}`,
    );
    if (!clockSaved.ok) return clockSaved;
    run = clockSaved.value;

    writeArtifactSync(path.join(artifactDir, 'prompt-original.md'), parsed.rawBody);

    const runningSaved = persistCheckpoint(
      ctx,
      {
        ...transition(
          run,
          'RUNNING_CLAUDE',
          `Prompt ${promptFile.id}: tentativa ${attempt} de ${maxAttempts}.`,
        ),
        currentPromptId: promptFile.id,
        currentAttempt: attempt,
      },
      `${promptFile.id}: entrada em RUNNING_CLAUDE`,
    );
    if (!runningSaved.ok) return runningSaved;
    run = runningSaved.value;

    const progressSaved = persistCheckpoint(
      ctx,
      updatePromptProgress(run, promptFile.id, {
        status: 'RUNNING',
        attempts: attempt,
        lastAttemptAt: attemptStartedAt,
      }),
      `${promptFile.id}: progresso da tentativa`,
    );
    if (!progressSaved.ok) return progressSaved;
    run = progressSaved.value;

    /* --- Claude implementa ou corrige --------------------------------- */
    const promptIndex = ctx.prompts.findIndex((p) => p.id === promptFile.id) + 1;
    const common = {
      projectName: project.name,
      repositoryPath: project.repositoryPath,
      workingDirectory: ctx.workingDir,
      branchName: run.branchName ?? '',
      baseBranch: project.baseBranch,
      promptId: promptFile.id,
      promptName: promptFile.name,
      promptContent: parsed.rawBody,
      attempt,
      maxAttempts,
      testCommands: ctx.policy.commands.tests,
    };

    /* As Skills valem para a tentativa que está prestes a acontecer, então a
       conferência é aqui e não uma vez no início: entre a tentativa anterior e
       esta, alguém pode ter editado o documento. */
    const skillsIntact = verifyRunSkills(run);
    if (!skillsIntact.ok) {
      run = saveStop(ctx, stopBySkillMutation(ctx, run, promptFile.id, skillsIntact.error.message));
      return ok(run);
    }

    const baseInstruction =
      attempt === 1 || previousReview === null
        ? buildClaudeExecutionInstruction({
            ...common,
            promptIndex,
            promptTotal: ctx.prompts.length,
          })
        : buildClaudeCorrectionInstruction({
            ...common,
            reviewer: 'Codex',
            reviewSummary: previousReview.summary,
            requiredActions: previousReview.requiredActions,
            blockingIssues: previousReview.blockingIssues,
            nonBlockingIssues: previousReview.nonBlockingIssues,
            failedTestCommands: lastTests?.failedCommands ?? [],
            testOutputExcerpt: lastTests ? summarizeTestSuite(lastTests) : '',
          });

    const instruction = withSkills(baseInstruction, skillsIntact.value.claude);

    const beforeClaude = haltIfRequested(ctx, run, `${promptFile.id}: chamada do Claude`);
    if (beforeClaude) return ok(beforeClaude);

    ctx.control.setStep(`${promptFile.id}: Claude implementando (tentativa ${String(attempt)})`);
    const claude = await ports.agents.runClaude({
      role: attempt === 1 ? 'executor' : 'corrector',
      config,
      cwd: ctx.workingDir,
      instruction,
      timeoutMs: config.agents.claudeTimeoutSeconds * 1000,
      model: ctx.policy.agents.claudeModel,
      artifactDir,
      readOnly: false,
      signal: ctx.signal,
    });

    /*
     * A chamada é contabilizada mesmo quando falha: ela consumiu orçamento.
     * E o registro dessa contabilidade é um CHECKPOINT: se ele não chegar ao
     * disco, a suíte de testes não pode começar. Sem isso, uma tentativa
     * avançava com o orçamento do Loop Guard parado numa versão antiga.
     */
    const claudeCallSaved = persistCheckpoint(
      ctx,
      recordAgentCall(run, promptFile.id, 'claude'),
      `${promptFile.id}: contabilização da chamada do Claude`,
    );
    if (!claudeCallSaved.ok) return claudeCallSaved;
    run = claudeCallSaved.value;

    /* O Claude pode ter sido derrubado pelo aborto. Parar AQUI é o que impede
       a etapa seguinte (a suíte de testes) de começar depois de uma pausa —
       exatamente o comportamento que faltava. */
    const afterClaude = haltIfRequested(ctx, run, `${promptFile.id}: após o Claude`);
    if (afterClaude) return ok(afterClaude);

    if (!claude.ok) {
      const state = mapAgentErrorState(claude.error.code);
      run = saveStop(ctx, {
        ...transition(run, state, `Claude falhou no prompt ${promptFile.id}.`),
        lastError: claude.error,
      });
      return ok(run);
    }

    /* --- OrqPEG executa os testes oficiais ---------------------------- */
    const testsStateSaved = persistCheckpoint(
      ctx,
      transition(run, 'RUNNING_TESTS', 'Executando a suíte oficial de testes.'),
      `${promptFile.id}: entrada em RUNNING_TESTS`,
    );
    if (!testsStateSaved.ok) return testsStateSaved;
    run = testsStateSaved.value;

    ctx.control.setStep(`${promptFile.id}: suíte de testes (tentativa ${String(attempt)})`);
    const tests = await ports.tests.run({
      commands: ctx.policy.commands.tests,
      cwd: ctx.workingDir,
      timeoutSeconds: ctx.policy.commands.timeoutSeconds,
      signal: ctx.signal,
      onCommandStart: (command) => logger.info(`  → ${command}`),
    });
    lastTests = tests;

    const afterTests = haltIfRequested(ctx, run, `${promptFile.id}: após os testes`);
    if (afterTests) return ok(afterTests);

    writeArtifactSync(
      path.join(artifactDir, 'tests-summary.json'),
      `${JSON.stringify(tests, null, 2)}\n`,
    );
    writeArtifactSync(path.join(artifactDir, 'tests-full.log'), renderTestsLog(tests));

    /* --- Pacote de auditoria ------------------------------------------ */
    const packageStateSaved = persistCheckpoint(
      ctx,
      transition(run, 'BUILDING_REVIEW_PACKAGE', 'Montando o pacote de auditoria.'),
      `${promptFile.id}: montagem do pacote de auditoria`,
    );
    if (!packageStateSaved.ok) return packageStateSaved;
    run = packageStateSaved.value;

    const changed = await ports.git.changedFiles(ctx.workingDir);
    const statusText = await ports.git.statusText(ctx.workingDir);
    const diffStat = await ports.git.diffStat(ctx.workingDir, run.baseCommitSha ?? undefined);
    const diffPatch = await ports.git.diffPatch(ctx.workingDir, run.baseCommitSha ?? undefined);

    const changedFiles = changed.ok ? changed.value : [];

    /* Assinatura do que o executor produziu nesta volta. É o que permite
       detectar, na próxima, que nada mudou ou que o código está oscilando. */
    const patchText = diffPatch.ok ? diffPatch.value : '';
    const currentDiffPrint = diffFingerprint(patchText);
    const measured = measureDiff(patchText);

    const diffPrintSaved = persistCheckpoint(
      ctx,
      withBudget(run, promptFile.id, (budget) => ({
        ...budget,
        diffFingerprints: pushBounded(budget.diffFingerprints, currentDiffPrint),
      })),
      `${promptFile.id}: assinatura do diff`,
    );
    if (!diffPrintSaved.ok) return diffPrintSaved;
    run = diffPrintSaved.value;

    ctx.lastChangedFileCount = measured.files;
    ctx.lastChangedLineCount = measured.lines;
    const violations = classifyScope(parsed, changedFiles);
    ctx.lastScopeViolations = violations.outsideAllowed;
    ctx.lastForbiddenViolations = violations.forbidden;
    ctx.lastReviewEvidenceComplete =
      changedFiles.length === 0 || patchText.trim().length > 0;
    writeArtifactSync(path.join(artifactDir, 'changed-files.txt'), changedFiles.join('\n'));
    writeArtifactSync(
      path.join(artifactDir, 'git-status.txt'),
      statusText.ok ? statusText.value : '',
    );
    writeArtifactSync(path.join(artifactDir, 'git-diff-stat.txt'), diffStat.ok ? diffStat.value : '');
    writeArtifactSync(path.join(artifactDir, 'git-diff.patch'), diffPatch.ok ? diffPatch.value : '');

    const reviewPackage = buildReviewPackage({
      project,
      prompt: parsed,
      promptRaw: parsed.rawBody,
      attempt,
      workingDir: ctx.workingDir,
      changedFiles,
      diffStat: diffStat.ok ? diffStat.value : '',
      diffPatch: diffPatch.ok ? diffPatch.value : '',
      gitStatus: statusText.ok ? statusText.value : '',
      tests,
      previousReview,
    });
    writeArtifactSync(path.join(artifactDir, 'review-package.md'), reviewPackage);

    /* --- Codex revisa (somente leitura) ------------------------------- */
    const codexStateSaved = persistCheckpoint(
      ctx,
      transition(run, 'RUNNING_CODEX', 'Codex revisando a implementação.'),
      `${promptFile.id}: entrada em RUNNING_CODEX`,
    );
    if (!codexStateSaved.ok) return codexStateSaved;
    run = codexStateSaved.value;

    const schema = loadSchema('prompt-review.schema.json');
    if (!schema.ok) return schema;

    /* Mesma conferência de antes da chamada do Claude: o revisor precisa julgar
       sob as regras que o executor recebeu, e uma Skill editada entre as duas
       chamadas faria o revisor cobrar o que o executor nunca leu. */
    const skillsIntactForReview = verifyRunSkills(run);
    if (!skillsIntactForReview.ok) {
      run = saveStop(
        ctx,
        stopBySkillMutation(ctx, run, promptFile.id, skillsIntactForReview.error.message),
      );
      return ok(run);
    }

    const beforeCodex = haltIfRequested(ctx, run, `${promptFile.id}: revisão do Codex`);
    if (beforeCodex) return ok(beforeCodex);

    ctx.control.setStep(`${promptFile.id}: Codex revisando (tentativa ${String(attempt)})`);
    const codex = await ports.agents.runCodex({
      role: 'prompt-reviewer',
      config,
      cwd: ctx.workingDir,
      // A instrução define as regras e o formato de resposta; o pacote de
      // auditoria (diff completo, testes, escopo) segue anexado como evidência.
      instruction: `${withSkills(
        buildCodexPromptReviewInstruction({
          projectName: project.name,
          repositoryPath: project.repositoryPath,
          workingDirectory: ctx.workingDir,
          branchName: run.branchName ?? '',
          promptId: promptFile.id,
          promptName: promptFile.name,
          promptContent: parsed.rawBody,
          attempt,
          maxAttempts,
          changedFiles,
          diffSummary: diffStat.ok ? diffStat.value : '',
          testsSummary: summarizeTestSuite(tests),
          responseSchema: JSON.stringify(schema.value, null, 2),
        }),
        skillsIntactForReview.value.codex,
      )}\n\n${reviewPackage}`,
      timeoutMs: config.agents.codexTimeoutSeconds * 1000,
      model: ctx.policy.agents.codexModel,
      artifactDir,
      readOnly: true,
      signal: ctx.signal,
    });

    /* Mesmo raciocínio da contabilização do Claude: sem o registro no disco,
       nenhuma aprovação e nenhum commit podem acontecer. */
    const codexCallSaved = persistCheckpoint(
      ctx,
      recordAgentCall(run, promptFile.id, 'codex'),
      `${promptFile.id}: contabilização da chamada do Codex`,
    );
    if (!codexCallSaved.ok) return codexCallSaved;
    run = codexCallSaved.value;

    const afterCodex = haltIfRequested(ctx, run, `${promptFile.id}: após o Codex`);
    if (afterCodex) return ok(afterCodex);

    if (!codex.ok) {
      // Sem revisor não há aprovação possível: o prompt fica bloqueado. Jamais
      // aprovamos por ausência do revisor.
      const state = mapAgentErrorState(codex.error.code);
      run = saveStop(ctx, {
        ...transition(
          run,
          state,
          `Revisão do Codex indisponível para ${promptFile.id}: ${codex.error.message}`,
        ),
        lastError: codex.error,
      });
      run = saveStop(ctx, updatePromptProgress(run, promptFile.id, { status: 'BLOCKED' }));
      writeAttemptSummary(ctx, run, promptFile, attempt, attemptStartedAt, {
        tests,
        review: null,
        changedFiles,
        approved: false,
        blocked: true,
        notes: [`Codex indisponível: ${codex.error.message}`],
      });
      return ok(run);
    }

    const review = parsePromptReview(codex.value.output, schema.value);
    writeArtifactSync(
      path.join(artifactDir, 'codex-review.json'),
      review.ok ? `${JSON.stringify(review.value, null, 2)}\n` : codex.value.output,
    );

    if (!review.ok) {
      logger.warn(`JSON de revisão inválido na tentativa ${attempt}: ${review.error.message}`);
      previousReview = null;
      writeAttemptSummary(ctx, run, promptFile, attempt, attemptStartedAt, {
        tests,
        review: null,
        changedFiles,
        approved: false,
        blocked: false,
        notes: [`JSON de revisão inválido: ${review.error.message}`],
      });
      continue;
    }

    previousReview = review.value;

    /* Assinaturas de revisão e de falha alimentam os detectores de repetição
       e de oscilação na próxima volta do laço. */
    const printsSaved = persistCheckpoint(
      ctx,
      withBudget(run, promptFile.id, (budget) => {
        const reviewPrint = reviewFingerprint(review.value);
        const testPrint = testFailureFingerprint(tests);
        return {
          ...budget,
          reviewFingerprints: reviewPrint
            ? pushBounded(budget.reviewFingerprints, reviewPrint)
            : budget.reviewFingerprints,
          testFailureFingerprints: testPrint
            ? pushBounded(budget.testFailureFingerprints, testPrint)
            : budget.testFailureFingerprints,
        };
      }),
      `${promptFile.id}: assinaturas de revisão e de falha`,
    );
    if (!printsSaved.ok) return printsSaved;
    run = printsSaved.value;

    const approved = tests.passed && reviewIsApproval(review.value);

    writeAttemptSummary(ctx, run, promptFile, attempt, attemptStartedAt, {
      tests,
      review: review.value,
      changedFiles,
      approved,
      blocked: review.value.verdict === 'BLOCKED',
      notes: [],
    });

    if (approved) {
      /* A aprovação precede o commit e é escrita no Git: se ela não puder ser
         persistida, nada é commitado. */
      const approvalSaved = persistCheckpoint(
        ctx,
        transition(run, 'PROMPT_APPROVED', `Prompt ${promptFile.id} aprovado.`),
        `${promptFile.id}: aprovação`,
      );
      if (!approvalSaved.ok) return approvalSaved;
      run = approvalSaved.value;

      const committed = await commitPrompt(ctx, run, promptFile, changedFiles);
      if (!committed.ok) return committed;
      run = committed.value;
      return ok(run);
    }

    if (review.value.verdict === 'BLOCKED') {
      run = saveStop(ctx, updatePromptProgress(run, promptFile.id, {
        status: 'BLOCKED',
        lastVerdict: 'BLOCKED',
        blockingIssueCount: review.value.blockingIssues.length,
      }));
      run = saveStop(
        ctx,
        transition(run, 'BLOCKED', `Prompt ${promptFile.id} bloqueado pelo revisor.`),
      );
      return ok(run);
    }

    /* Nova volta do laço à frente: o pedido de correção é um checkpoint, não
       uma parada. Sem ele no disco, a tentativa seguinte partiria de um
       orçamento que o registro não conhece. */
    const changesSaved = persistCheckpoint(
      ctx,
      updatePromptProgress(run, promptFile.id, {
        status: 'CHANGES_REQUESTED',
        lastVerdict: review.value.verdict,
        blockingIssueCount: review.value.blockingIssues.length,
      }),
      `${promptFile.id}: progresso de correções solicitadas`,
    );
    if (!changesSaved.ok) return changesSaved;
    run = changesSaved.value;

    const changesStateSaved = persistCheckpoint(
      ctx,
      transition(
        run,
        'CHANGES_REQUESTED',
        `Correções solicitadas em ${promptFile.id} (tentativa ${attempt}).`,
      ),
      `${promptFile.id}: entrada em CHANGES_REQUESTED`,
    );
    if (!changesStateSaved.ok) return changesStateSaved;
    run = changesStateSaved.value;
  }

  /*
   * O laço esgotou. A saída também passa pelo Loop Guard, em vez de ir direto
   * para BLOCKED: assim o motivo real é nomeado (MAX_ATTEMPTS_REACHED, ou um
   * gatilho mais específico que já estivesse valendo), a parada entra na linha
   * do tempo como decisão consciente e o relatório LOOP-GUARD.md é gerado.
   * Sem isto, o limite de tentativas terminava como bloqueio genérico e sem
   * evidência — encontrado em execução real, não pelos dublês.
   */
  const exhausted = decideNextAttempt(ctx, run, promptFile.id, maxAttempts + 1, {
    previousReview,
    lastTests,
  });
  run = saveStop(ctx, applyLoopGuardStop(ctx, run, promptFile.id, exhausted));
  return ok(run);
}

async function commitPrompt(
  ctx: Context,
  input: RunRecord,
  promptFile: PromptFile,
  changedFiles: string[],
): Promise<Result<RunRecord>> {
  let run = input;

  /*
   * Commit já existente NUNCA é refeito.
   *
   * O caso real: a execução foi pausada ou caiu depois de commitar o prompt,
   * mas antes de o registro alcançar o estado seguinte. Ao retomar, a tentativa
   * recomeça — e sem esta guarda produziria um SEGUNDO commit para o mesmo
   * prompt, duplicando trabalho aprovado na branch que segue para o merge.
   * O registro persistido é a prova: se ele já lista um commit deste prompt, o
   * trabalho está feito.
   */
  const existingCommit = run.commits.find((entry) => entry.promptId === promptFile.id);
  if (existingCommit) {
    ctx.logger.info(
      `Prompt ${promptFile.id} já possui o commit ${existingCommit.sha.slice(0, 12)} no registro; ` +
        'nenhum commit novo será criado.',
    );
    return persistCheckpoint(
      ctx,
      updatePromptProgress(run, promptFile.id, {
        status: 'APPROVED',
        approvedAt: nowIso(),
        commitSha: existingCommit.sha,
        lastVerdict: 'APPROVED',
      }),
      `${promptFile.id}: adoção do commit já registrado`,
    );
  }

  if (!ctx.policy.git.commitAfterApproval) {
    return persistCheckpoint(
      ctx,
      updatePromptProgress(run, promptFile.id, {
        status: 'APPROVED',
        approvedAt: nowIso(),
        lastVerdict: 'APPROVED',
      }),
      `${promptFile.id}: aprovação sem commit (política do projeto)`,
    );
  }

  if (changedFiles.length === 0) {
    ctx.logger.warn(
      `Prompt ${promptFile.id} aprovado sem alteração de arquivo; nenhum commit criado.`,
    );
    return persistCheckpoint(
      ctx,
      updatePromptProgress(run, promptFile.id, {
        status: 'APPROVED',
        approvedAt: nowIso(),
        lastVerdict: 'APPROVED',
      }),
      `${promptFile.id}: aprovação sem alteração de arquivo`,
    );
  }

  /* Cancelamento aceito impede o commit: é uma escrita na branch que o
     usuário acabou de mandar parar. */
  const beforeCommit = haltIfRequested(ctx, run, `${promptFile.id}: commit`);
  if (beforeCommit) return ok(beforeCommit);

  const committingSaved = persistCheckpoint(
    ctx,
    transition(run, 'COMMITTING', `Criando commit de ${promptFile.id}.`),
    `${promptFile.id}: entrada em COMMITTING`,
  );
  if (!committingSaved.ok) return committingSaved;
  run = committingSaved.value;

  const message = `${ctx.policy.git.commitMessagePrefix} ${ctx.project.id}: concluir ${promptFile.id} — ${promptFile.name}`.trim();

  const committed = await commitWithJournal(ctx, run, {
    promptId: promptFile.id,
    attempt: run.currentAttempt,
    message,
    changedFiles,
  });
  if (!committed.ok) return committed;

  const sha = committed.value.sha;
  const withCommit = persistCheckpoint(
    ctx,
    {
      ...updatePromptProgress(committed.value.run, promptFile.id, {
        status: 'APPROVED',
        approvedAt: nowIso(),
        commitSha: sha,
        lastVerdict: 'APPROVED',
      }),
      commits: [
        ...committed.value.run.commits,
        { promptId: promptFile.id, sha, message, at: nowIso() },
      ],
    },
    `${promptFile.id}: registro do commit ${sha.slice(0, 12)}`,
  );

  /*
   * A conciliação do diário acontece DEPOIS da gravação do estado, e mesmo
   * quando ela falha. Se o estado não foi gravado, a entrada precisa continuar
   * PENDENTE: é ela que fará a retomada encontrar e adotar este commit em vez
   * de criar um segundo.
   */
  if (withCommit.ok) {
    const settled = settleCommitIntent(
      ctx.project.id,
      run.runId,
      committed.value.operationId,
      'COMMITTED',
      sha,
    );
    if (!settled.ok) {
      ctx.logger.warn(
        `O commit ${sha.slice(0, 12)} foi registrado no estado, mas o diário não pôde ser ` +
          `encerrado: ${settled.error.message}. A retomada reconhecerá o commit e não o repetirá.`,
      );
    }
    ctx.logger.info(`Commit ${sha.slice(0, 12)} criado para ${promptFile.id}.`);
  }

  return withCommit;
}

/**
 * Cria um commit com WRITE-AHEAD LOG.
 *
 * A ordem é a única coisa que importa aqui:
 *
 *   1. abrir a intenção no diário, com `fsync`, ANTES de tocar no Git;
 *   2. `git add`;
 *   3. `git commit`, carimbando o identificador da operação no rodapé;
 *   4. (fora daqui) gravar o SHA no estado e encerrar a entrada.
 *
 * Uma queda entre 3 e 4 deixa uma entrada pendente cujo carimbo está no commit
 * — e é assim que `reconcileCommitJournal` reencontra o commit na retomada em
 * vez de criar um segundo. Falhar no passo 1 impede o commit: commitar sem
 * diário reabriria exatamente a janela que o diário fecha.
 */
async function commitWithJournal(
  ctx: Context,
  run: RunRecord,
  input: { promptId: string; attempt: number; message: string; changedFiles: string[] },
): Promise<Result<{ run: RunRecord; sha: string; operationId: string }>> {
  const intent = openCommitIntent({
    projectId: ctx.project.id,
    runId: run.runId,
    promptId: input.promptId,
    attempt: input.attempt,
    message: input.message,
  });
  if (!intent.ok) {
    ctx.logger.error(
      `Diário de commits indisponível para ${input.promptId}: ${intent.error.message}. ` +
        'Nenhum commit será criado — sem diário, uma queda depois do commit duplicaria o trabalho.',
    );
    return intent;
  }

  const staged = await ctx.ports.git.addPaths(ctx.workingDir, input.changedFiles);
  if (!staged.ok) {
    settleCommitIntent(ctx.project.id, run.runId, intent.value.operationId, 'ABANDONED', null);
    return staged;
  }

  const commit = await ctx.ports.git.commit(
    ctx.workingDir,
    withCommitTrailers(input.message, intent.value),
  );
  if (!commit.ok) {
    settleCommitIntent(ctx.project.id, run.runId, intent.value.operationId, 'ABANDONED', null);
    return commit;
  }

  return ok({ run, sha: commit.value, operationId: intent.value.operationId });
}

/**
 * Reconcilia commits que existem no Git mas não no registro.
 *
 * O cenário: o processo caiu entre `git commit` e a gravação do estado. Sem
 * esta reconciliação, a guarda de duplicidade — que consulta `run.commits` —
 * não encontra nada e o prompt é reexecutado e commitado de novo.
 *
 * A adoção exige TRÊS provas, e a ausência de qualquer uma impede a adoção:
 *
 *   1. o commit carrega o `Operation-Id` daquela entrada do diário — um valor
 *      aleatório de 128 bits que só existe no disco local desta execução;
 *   2. o commit é ALCANÇÁVEL a partir do HEAD atual (a busca parte de
 *      `baseCommitSha..HEAD`) — um commit solto em outra branch não é o
 *      trabalho que segue para o merge;
 *   3. o commit ALTERA ao menos um arquivo — um commit vazio com o carimbo
 *      certo não é o commit de trabalho que se procurava.
 *
 * A mensagem humana nunca é usada como identidade: ela é derivada do prompt e
 * seria idêntica entre duas tentativas do mesmo trabalho.
 */
async function reconcileCommitJournal(
  ctx: Context,
  input: RunRecord,
): Promise<Result<RunRecord>> {
  let run = input;
  const pending = pendingCommitEntries(ctx.project.id, run.runId);
  if (pending.length === 0) return ok(run);

  const baseRef = run.baseCommitSha;
  if (!baseRef) {
    ctx.logger.warn(
      `Há ${String(pending.length)} intenção(ões) de commit pendente(s), mas a execução não tem ` +
        'SHA de base para delimitar a busca. Nenhuma adoção será feita.',
    );
    return ok(run);
  }

  const listed = await ctx.ports.git.listCommitsSince(ctx.workingDir, baseRef);
  if (!listed.ok) {
    ctx.logger.warn(
      `Não foi possível listar os commits da branch para conciliar o diário: ${listed.error.message}.`,
    );
    return ok(run);
  }

  for (const entry of pending) {
    const match = listed.value.find(
      (candidate) => readTrailer(candidate.message, TRAILER_OPERATION_ID) === entry.operationId,
    );

    if (!match) {
      /* O commit não chegou a existir: a queda foi ANTES do `git commit`. A
         entrada é encerrada como abandonada e o prompt roda normalmente. */
      settleCommitIntent(ctx.project.id, run.runId, entry.operationId, 'ABANDONED', null);
      ctx.logger.info(
        `Intenção de commit ${entry.operationId.slice(0, 8)} (${entry.promptId}) não produziu ` +
          'commit algum; o prompt será executado normalmente.',
      );
      continue;
    }

    const touched = await ctx.ports.git.commitChangedFiles(ctx.workingDir, match.sha);
    if (!touched.ok || touched.value.length === 0) {
      ctx.logger.warn(
        `O commit ${match.sha.slice(0, 12)} carrega o carimbo de ${entry.promptId} mas não altera ` +
          'arquivo algum. Adoção recusada: um commit vazio não é o trabalho procurado.',
      );
      continue;
    }

    if (run.commits.some((committed) => committed.sha === match.sha)) {
      settleCommitIntent(ctx.project.id, run.runId, entry.operationId, 'COMMITTED', match.sha);
      continue;
    }

    ctx.logger.warn(
      `Commit órfão reconciliado: ${match.sha.slice(0, 12)} pertence a ${entry.promptId} e existe ` +
        'na branch, mas não estava no estado. Ele será adotado; o prompt NÃO será refeito.',
    );

    const adopted = persistCheckpoint(
      ctx,
      {
        ...updatePromptProgress(run, entry.promptId, {
          status: 'APPROVED',
          approvedAt: nowIso(),
          commitSha: match.sha,
          lastVerdict: 'APPROVED',
        }),
        commits: [
          ...run.commits,
          {
            promptId: entry.promptId,
            sha: match.sha,
            message: entry.message,
            at: nowIso(),
          },
        ],
      },
      `conciliação do commit órfão ${match.sha.slice(0, 12)}`,
    );
    if (!adopted.ok) return adopted;
    run = adopted.value;

    const settled = settleCommitIntent(
      ctx.project.id,
      run.runId,
      entry.operationId,
      'ADOPTED',
      match.sha,
    );
    if (!settled.ok) {
      ctx.logger.warn(`Diário não pôde ser encerrado após a adoção: ${settled.error.message}`);
    }
  }

  return ok(run);
}

/* ------------------------------------------------------------------------- */
/* Etapa 3 — suíte completa, push, PR e CI                                    */
/* ------------------------------------------------------------------------- */

async function publish(ctx: Context, input: RunRecord): Promise<Result<RunRecord>> {
  let run = input;
  const { project, ports, logger } = ctx;

  const finalTestsStateSaved = persistCheckpoint(
    ctx,
    transition(run, 'RUNNING_TESTS', 'Executando a suíte completa.'),
    'entrada na suíte completa',
  );
  if (!finalTestsStateSaved.ok) return finalTestsStateSaved;
  run = finalTestsStateSaved.value;

  ctx.control.setStep('suíte completa antes da publicação');
  const finalTests = await ports.tests.run({
    commands: ctx.policy.commands.tests,
    cwd: ctx.workingDir,
    timeoutSeconds: ctx.policy.commands.timeoutSeconds,
    signal: ctx.signal,
    onCommandStart: (command) => logger.info(`  → ${command}`),
  });
  const finalTestsSaved = persistCheckpoint(
    ctx,
    { ...run, finalTests },
    'resultado da suíte completa',
  );
  if (!finalTestsSaved.ok) return finalTestsSaved;
  run = finalTestsSaved.value;

  const afterFinalTests = haltIfRequested(ctx, run, 'após a suíte completa');
  if (afterFinalTests) return ok(afterFinalTests);

  if (!finalTests.passed) {
    run = saveStop(
      ctx,
      transition(run, 'BLOCKED', 'Suíte completa falhou; push e PR não foram executados.'),
    );
    return ok(run);
  }

  if (!ctx.policy.git.pushAfterRun) {
    run = saveStop(ctx, transition(run, 'COMPLETED', 'Execução concluída sem push (política do projeto).'));
    return ok(run);
  }

  const beforePush = haltIfRequested(ctx, run, 'push da branch');
  if (beforePush) return ok(beforePush);

  const pushingSaved = persistCheckpoint(
    ctx,
    transition(run, 'PUSHING', 'Enviando a branch ao remoto.'),
    'entrada em PUSHING',
  );
  if (!pushingSaved.ok) return pushingSaved;
  run = pushingSaved.value;

  const branch = run.branchName;
  if (!branch) return fail('INTERNAL', 'Branch da execução não definida.');

  const pushed = await ports.git.push(ctx.workingDir, project.remote, branch, true);
  if (!pushed.ok) {
    saveStop(ctx, transition(run, 'FAILED', 'Falha no push.'));
    return pushed;
  }
  const pushedSaved = persistCheckpoint(
    ctx,
    { ...run, pushedAt: nowIso(), pushedRemote: ctx.policy.repository.remote },
    'registro do push',
  );
  if (!pushedSaved.ok) return pushedSaved;
  run = pushedSaved.value;

  if (!ctx.policy.pullRequest.enabled) {
    run = saveStop(ctx, transition(run, 'COMPLETED', 'Execução concluída sem PR (política do projeto).'));
    return ok(run);
  }

  const beforePr = haltIfRequested(ctx, run, 'criação da pull request');
  if (beforePr) return ok(beforePr);

  const creatingPrSaved = persistCheckpoint(
    ctx,
    transition(run, 'CREATING_PR', 'Criando pull request.'),
    'entrada em CREATING_PR',
  );
  if (!creatingPrSaved.ok) return creatingPrSaved;
  run = creatingPrSaved.value;

  const existing = await ports.github.findPullRequestForBranch({
    cwd: ctx.workingDir,
    repo: project.githubRepository,
    head: branch,
  });

  let pr = existing.ok ? existing.value : null;
  if (!pr) {
    const body = renderPullRequestBody({ project, run });
    const created = await ports.github.createDraftPullRequest({
      cwd: ctx.workingDir,
      repo: ctx.policy.repository.githubRepository,
      base: ctx.policy.repository.baseBranch,
      head: branch,
      title: `${ctx.policy.git.commitMessagePrefix} ${project.name} — ${run.runId}`.trim(),
      body,
      draft: ctx.policy.pullRequest.draftDuringExecution,
    });
    if (!created.ok) {
      saveStop(ctx, transition(run, 'FAILED', 'Falha ao criar a pull request.'));
      return created;
    }
    pr = created.value;
  } else {
    await ports.github.updatePullRequestBody({
      cwd: ctx.workingDir,
      repo: project.githubRepository,
      prNumber: pr.number,
      body: renderPullRequestBody({ project, run }),
    });
  }

  const prSaved = persistCheckpoint(ctx, { ...run, pullRequest: pr }, 'registro da pull request');
  if (!prSaved.ok) return prSaved;
  run = prSaved.value;

  logger.info(`Pull request #${pr.number}: ${pr.url}`);

  if (!ctx.policy.pullRequest.waitForChecks) return ok(run);

  return runCiLoop(ctx, run, pr.number);
}

/**
 * Laço do CI, governado por orçamento.
 *
 * Substitui a espera de teto fixo que existia antes. Três diferenças que
 * importam: o timeout é HISTÓRICO (persistido, não reinicia com o processo),
 * o polling tem backoff limitado, e uma falha reprovada só é corrigida
 * enquanto o orçamento permitir. Nenhuma chamada de IA acontece enquanto os
 * checks estiverem apenas pendentes.
 */
async function runCiLoop(
  ctx: Context,
  input: RunRecord,
  prNumber: number,
): Promise<Result<RunRecord>> {
  let run = input;
  const policy = ctx.policy.ci;

  /* Entrar em WAITING_CI antes da primeira consulta: a máquina de estados só
     admite o reparo a partir daqui, e é também o estado que o painel espera
     ver enquanto o CI roda. */
  const waitingSaved = persistCheckpoint(
    ctx,
    transition(run, 'WAITING_CI', 'Aguardando o CI do GitHub Actions.'),
    'entrada em WAITING_CI',
  );
  if (!waitingSaved.ok) return waitingSaved;
  run = waitingSaved.value;

  for (;;) {
    /* A espera do CI é o trecho mais longo da execução; honrar a intenção aqui
       distingue "pausado pelo usuário" de "abortado sem motivo declarado". */
    const halted = haltIfRequested(ctx, run, 'espera do CI');
    if (halted) return ok(halted);

    const current = await ctx.ports.github.getChecks({
      cwd: ctx.workingDir,
      repo: ctx.policy.repository.githubRepository,
      prNumber,
    });
    if (!current.ok) {
      run = saveStop(ctx, {
        ...transition(run, 'CI_FAILED', 'Não foi possível obter o status do CI.'),
        lastError: current.error,
      });
      return ok(run);
    }

    const checks = current.value;
    const at = nowIso();

    /* A espera é ancorada no head SHA: commit novo é CI novo e merece relógio
       novo, mas o contador de reparos atravessa o laço inteiro. */
    const wait = rebaseCiWaitOnHead(run.ciWait, checks.headSha, policy, at);
    const checksSaved = persistCheckpoint(ctx, { ...run, checks, ciWait: wait }, 'estado do CI');
    if (!checksSaved.ok) return checksSaved;
    run = checksSaved.value;

    const decision = decideCi({
      run,
      policy,
      checks,
      failureSignals: failureSignalsFrom(checks),
      nowMs: Date.now(),
    });

    if (decision.action === 'PROCEED') {
      ctx.logger.info('CI aprovou todos os checks obrigatórios.');
      return ok(run);
    }

    if (decision.action === 'STOP') {
      run = saveStop(ctx, applyCiStop(ctx, run, decision.trigger, decision.reason, decision.evidence));
      return ok(run);
    }

    if (decision.action === 'WAIT') {
      const waitAdvanced = persistCheckpoint(
        ctx,
        { ...transition(run, 'WAITING_CI', decision.reason), ciWait: advanceCiWait(wait, policy, at) },
        'avanço do orçamento de espera do CI',
      );
      if (!waitAdvanced.ok) return waitAdvanced;
      run = waitAdvanced.value;
      try {
        await sleep(decision.waitSeconds * 1000, ctx.signal);
      } catch {
        const stopped = haltIfRequested(ctx, run, 'espera do CI interrompida');
        return ok(stopped ?? saveStop(ctx, transition(run, 'INTERRUPTED', 'Espera do CI cancelada.')));
      }
      continue;
    }

    /* REPAIR — a única ramificação que gasta assinatura. */
    const repaired = await repairCi(ctx, run, decision.cycle, decision.fingerprint, decision.failedChecks);
    if (!repaired.ok) return repaired;
    run = repaired.value;

    /* O reparo pode ter parado a execução por conta própria (testes locais
       reprovados, agente falhou). Sair do laço evita nova espera de CI sobre
       um commit que não chegou a existir. `CI_FAILED` entra explicitamente
       porque não é um estado de parada genérico do produto. */
    if (run.state === 'CI_FAILED' || isStopState(run.state)) return ok(run);

    /* Commit novo enviado: volta a esperar, e a máquina de estados exige que
       o retorno passe por WAITING_CI antes de qualquer novo reparo. */
    const waitingAgain = persistCheckpoint(
      ctx,
      transition(run, 'WAITING_CI', 'Aguardando o CI do commit de reparo.'),
      'nova espera do CI após o reparo',
    );
    if (!waitingAgain.ok) return waitingAgain;
    run = waitingAgain.value;
  }
}

/** Registra a parada de CI com gatilho nomeado, nunca com CI_FAILED genérico. */
function applyCiStop(
  ctx: Context,
  run: RunRecord,
  trigger: LoopGuardTrigger,
  reason: string,
  evidence: Record<string, unknown>,
): RunRecord {
  ctx.logger.warn(`CI parou: ${trigger} — ${reason}`);

  const decision: LoopGuardDecision = {
    allowed: false,
    severity: severityOf(trigger),
    trigger,
    reason,
    evidence,
    nextActions: ['OPEN_REPORT', 'MARK_FOR_MANUAL_REVIEW'],
  };

  /* O trabalho é preservado: branch, PR e worktree continuam intactos. */
  return {
    ...transition(run, 'CI_FAILED', `${trigger}: ${reason}`, { trigger }),
    lastLoopGuard: decision,
  };
}

/**
 * Um ciclo de reparo de CI.
 *
 * É um laço próprio da execução, com artefatos próprios: não reabre prompts já
 * aprovados nem os devolve ao estado pendente. O que ele produz é um commit
 * adicional sobre a mesma branch.
 */
async function repairCi(
  ctx: Context,
  input: RunRecord,
  cycle: number,
  fingerprint: string,
  failedChecks: string[],
): Promise<Result<RunRecord>> {
  let run = input;
  const headShaBefore = run.checks?.headSha ?? '';
  const startedAt = nowIso();

  /* O reparo de CI escreve código na mesma branch que segue para o merge, e
     por isso é governado pelas mesmas Skills. A conferência vem antes de
     abrir o diretório do ciclo: parar aqui não deixa artefato de um ciclo que
     não aconteceu. */
  const skillsForRepair = verifyRunSkills(run);
  if (!skillsForRepair.ok) {
    run = saveStop(ctx, stopRunBySkillMutation(run, skillsForRepair.error.message));
    return ok(run);
  }

  const dirResult = createExclusiveDirSync(
    path.join(
      projectArtifactsDir(ctx.project.id),
      run.runId,
      'ci-repairs',
      `cycle-${String(cycle).padStart(3, '0')}`,
    ),
  );
  if (!dirResult.ok) {
    run = saveStop(ctx, transition(run, 'FAILED', dirResult.error.message));
    return dirResult;
  }
  const dir = dirResult.value;

  writeExclusiveSync(
    path.join(dir, 'checks-before.json'),
    `${JSON.stringify(run.checks, null, 2)}\n`,
  );
  writeExclusiveSync(path.join(dir, 'failure-fingerprint.txt'), `${fingerprint}\n`);

  const repairStarted = persistCheckpoint(
    ctx,
    {
      ...transition(run, 'RUNNING_CLAUDE', `Reparo de CI ${String(cycle)}: corrigindo ${failedChecks.join(', ')}.`),
      ciRepairCycles: cycle,
      ciFailureFingerprints: pushBounded(run.ciFailureFingerprints, fingerprint),
      ciRepairs: [
        ...run.ciRepairs,
        {
          cycle,
          headShaBefore,
          fingerprint,
          failedChecks,
          startedAt,
          finishedAt: null,
          outcome: 'AGENT_FAILED',
          headShaAfter: null,
        },
      ],
    },
    `abertura do reparo de CI ${String(cycle)}`,
  );
  if (!repairStarted.ok) return repairStarted;
  run = repairStarted.value;

  const instruction = withSkills(
    buildCiRepairInstruction({
      projectName: ctx.project.name,
      cycle,
      maxCycles: ctx.policy.ci.maxRepairCycles,
      failedChecks,
      checksSummary: describeChecks(run),
      testCommands: ctx.policy.commands.tests,
    }),
    skillsForRepair.value.claude,
  );
  writeExclusiveSync(path.join(dir, 'claude-instruction.md'), instruction);

  const beforeRepair = haltIfRequested(ctx, run, `reparo de CI ${String(cycle)}`);
  if (beforeRepair) return ok(beforeRepair);

  ctx.control.setStep(`reparo de CI ${String(cycle)}: Claude corrigindo`);
  const claude = await ctx.ports.agents.runClaude({
    role: 'corrector',
    config: ctx.config,
    cwd: ctx.workingDir,
    instruction,
    timeoutMs: ctx.config.agents.claudeTimeoutSeconds * 1000,
    model: ctx.policy.agents.claudeModel,
    artifactDir: dir,
    readOnly: false,
    signal: ctx.signal,
  });

  const afterRepairAgent = haltIfRequested(ctx, run, `após o reparo de CI ${String(cycle)}`);
  if (afterRepairAgent) return ok(afterRepairAgent);

  if (!claude.ok) {
    run = saveStop(ctx, {
      ...finishCiRepair(run, cycle, 'AGENT_FAILED', null),
      ...transition(run, 'CI_FAILED', `O executor falhou durante o reparo de CI ${String(cycle)}.`),
      lastError: claude.error,
    });
    return ok(run);
  }

  const changed = await ctx.ports.git.changedFiles(ctx.workingDir);
  if (!changed.ok) return changed;
  if (changed.value.length === 0) {
    /* O encerramento do ciclo entra como BASE da parada, não espalhado depois:
       espalhar sobrescreveria `ciRepairs` com a versão anterior do registro. */
    run = saveStop(
      ctx,
      applyCiStop(
        ctx,
        finishCiRepair(run, cycle, 'NO_CHANGES', null),
        'NO_PROGRESS',
        `O reparo de CI ${String(cycle)} não alterou nenhum arquivo. Sem mudança não há o que reenviar, e repetir produziria o mesmo nada.`,
        { cycle, fingerprint },
      ),
    );
    return ok(run);
  }

  /* Testes locais antes do push: reenviar sem verificar transformaria o CI em
     ferramenta de depuração remota, gastando minutos de runner por tentativa. */
  const repairTestsSaved = persistCheckpoint(
    ctx,
    transition(run, 'RUNNING_TESTS', 'Validando o reparo de CI localmente.'),
    `reparo de CI ${String(cycle)}: entrada nos testes`,
  );
  if (!repairTestsSaved.ok) return repairTestsSaved;
  run = repairTestsSaved.value;

  ctx.control.setStep(`reparo de CI ${String(cycle)}: testes locais`);
  const tests = await ctx.ports.tests.run({
    commands: ctx.policy.commands.tests,
    cwd: ctx.workingDir,
    timeoutSeconds: ctx.policy.commands.timeoutSeconds,
    signal: ctx.signal,
  });
  writeExclusiveSync(path.join(dir, 'tests.json'), `${JSON.stringify(tests, null, 2)}\n`);

  const afterRepairTests = haltIfRequested(ctx, run, `reparo de CI ${String(cycle)}: após os testes`);
  if (afterRepairTests) return ok(afterRepairTests);

  if (!tests.passed) {
    run = saveStop(
      ctx,
      applyCiStop(
        ctx,
        finishCiRepair(run, cycle, 'TESTS_FAILED', null),
        'REPEATED_TEST_FAILURE',
        `O reparo de CI ${String(cycle)} não passou nos testes locais. Enviá-lo faria o CI reprovar de novo.`,
        { cycle, failedCommands: tests.failedCommands },
      ),
    );
    return ok(run);
  }

  const patch = await ctx.ports.git.diffPatch(ctx.workingDir);
  if (patch.ok) writeExclusiveSync(path.join(dir, 'diff.patch'), patch.value);

  const beforeRepairCommit = haltIfRequested(ctx, run, `reparo de CI ${String(cycle)}: commit`);
  if (beforeRepairCommit) return ok(beforeRepairCommit);

  const message = `${ctx.policy.git.commitMessagePrefix} ${ctx.project.id}: reparo de CI ${String(cycle)}`.trim();
  const repairKey = `ci-repair-${String(cycle)}`;

  /* O reparo de CI escreve na MESMA branch que segue para o merge, então a
     janela entre `git commit` e a gravação do estado é a mesma — e o diário
     que a fecha também. */
  const commit = await commitWithJournal(ctx, run, {
    promptId: repairKey,
    attempt: cycle,
    message,
    changedFiles: changed.value,
  });
  if (!commit.ok) return commit;

  const repairCommitSaved = persistCheckpoint(
    ctx,
    {
      ...run,
      commits: [
        ...run.commits,
        { promptId: repairKey, sha: commit.value.sha, message, at: nowIso() },
      ],
    },
    `reparo de CI ${String(cycle)}: registro do commit`,
  );
  if (!repairCommitSaved.ok) return repairCommitSaved;
  run = repairCommitSaved.value;
  settleCommitIntent(ctx.project.id, run.runId, commit.value.operationId, 'COMMITTED', commit.value.sha);

  const repairPushSaved = persistCheckpoint(
    ctx,
    transition(run, 'PUSHING', 'Enviando o reparo de CI.'),
    `reparo de CI ${String(cycle)}: entrada em PUSHING`,
  );
  if (!repairPushSaved.ok) return repairPushSaved;
  run = repairPushSaved.value;
  const pushed = await ctx.ports.git.push(
    ctx.workingDir,
    ctx.policy.repository.remote,
    run.branchName ?? '',
    false,
  );
  if (!pushed.ok) {
    run = saveStop(ctx, {
      ...finishCiRepair(run, cycle, 'AGENT_FAILED', commit.value.sha),
      ...transition(run, 'CI_FAILED', 'Falha ao enviar o reparo de CI.'),
      lastError: pushed.error,
    });
    return ok(run);
  }

  const repairDone = persistCheckpoint(
    ctx,
    finishCiRepair(run, cycle, 'REPAIRED', commit.value.sha),
    `reparo de CI ${String(cycle)}: conclusão`,
  );
  if (!repairDone.ok) return repairDone;
  run = repairDone.value;

  ctx.logger.info(`Reparo de CI ${String(cycle)} enviado (${commit.value.sha.slice(0, 12)}).`);
  return ok(run);
}

function finishCiRepair(
  run: RunRecord,
  cycle: number,
  outcome: CiRepairRecord['outcome'],
  headShaAfter: string | null,
): RunRecord {
  return {
    ...run,
    ciRepairs: run.ciRepairs.map((entry) =>
      entry.cycle === cycle
        ? { ...entry, outcome, headShaAfter, finishedAt: nowIso() }
        : entry,
    ),
  };
}

/* ------------------------------------------------------------------------- */
/* Etapa 4 — auditorias finais, consenso, gates e merge                       */
/* ------------------------------------------------------------------------- */

/**
 * Auditorias finais com orçamento de correção.
 *
 * Quando os auditores pedem mudanças, corrigir é legítimo — mas não
 * indefinidamente. Cada correção muda o head SHA, e mudar o head invalida
 * TODA a evidência anterior: as duas aprovações, o consenso, os gates e a
 * confiança foram emitidos sobre um código que já não existe. Sem teto, o par
 * "auditor pede / executor corrige" gira sem convergir, gastando duas
 * auditorias de IA por volta.
 */
async function auditAndMerge(ctx: Context, input: RunRecord): Promise<Result<RunRecord>> {
  let run = input;

  for (;;) {
    const round = await auditRound(ctx, run);
    if (!round.ok) return round;
    run = round.value.run;

    if (round.value.outcome !== 'CHANGES_REQUESTED') return ok(run);

    const limit = Math.max(0, ctx.policy.mergeAudit.maxCorrectionCycles);
    if (run.mergeCorrectionCycles >= limit) {
      run = saveStop(
        ctx,
        applyMergeCorrectionStop(ctx, run, limit, round.value.requestedBy, round.value.reasons),
      );
      return ok(run);
    }

    const corrected = await correctAfterAudit(
      ctx,
      run,
      run.mergeCorrectionCycles + 1,
      round.value.requestedBy,
      round.value.reasons,
    );
    if (!corrected.ok) return corrected;
    run = corrected.value;

    /* A correção pode ter parado por conta própria (testes locais, agente,
       push). Só voltamos a auditar se ela realmente produziu um head novo. */
    if (run.state === 'CI_FAILED' || isStopState(run.state)) return ok(run);
  }
}

interface AuditRoundResult {
  run: RunRecord;
  outcome: 'DONE' | 'CHANGES_REQUESTED';
  requestedBy: Array<'claude' | 'codex'>;
  reasons: string[];
}

async function auditRound(
  ctx: Context,
  input: RunRecord,
): Promise<Result<AuditRoundResult>> {
  let run = input;
  const { project, config, ports, logger } = ctx;
  const done = (r: RunRecord): Result<AuditRoundResult> =>
    ok({ run: r, outcome: 'DONE', requestedBy: [], reasons: [] });

  if (!ctx.policy.merge.enabled || ctx.policy.merge.mode !== 'dual_ai_consensus') {
    run = saveStop(
      ctx,
      transition(run, 'COMPLETED', 'Merge automático desabilitado para este projeto.'),
    );
    return done(run);
  }

  const pr = run.pullRequest;
  if (!pr) {
    run = saveStop(ctx, transition(run, 'BLOCKED', 'Sem pull request: auditoria final não se aplica.'));
    return done(run);
  }

  // Releitura da PR: o head SHA precisa ser o valor atual, não o do momento da
  // criação. Toda auditoria é amarrada a este SHA.
  const fresh = await ports.github.getPullRequest({
    cwd: ctx.workingDir,
    repo: project.githubRepository,
    prNumber: pr.number,
  });
  if (!fresh.ok) return fresh;
  const currentPr = fresh.value;
  const freshPrSaved = persistCheckpoint(ctx, { ...run, pullRequest: currentPr }, 'releitura da PR');
  if (!freshPrSaved.ok) return freshPrSaved;
  run = freshPrSaved.value;

  if (currentPr.headSha !== pr.headSha) {
    const invalidated = persistCheckpoint(
      ctx,
      invalidateMergeApprovals(run, 'O head SHA mudou antes da auditoria.'),
      'invalidação das aprovações por mudança de head',
    );
    if (!invalidated.ok) return invalidated;
    run = invalidated.value;
  }

  if (ctx.policy.pullRequest.markReadyBeforeMerge && currentPr.isDraft) {
    await ports.github.markReadyForReview({
      cwd: ctx.workingDir,
      repo: project.githubRepository,
      prNumber: currentPr.number,
    });
  }

  const commitLog = await ports.git.commitLog(ctx.workingDir, project.baseBranch);
  const diffStat = await ports.git.diffStat(ctx.workingDir, run.baseCommitSha ?? undefined);
  const diffPatch = await ports.git.diffPatch(ctx.workingDir, run.baseCommitSha ?? undefined);

  // Os auditores precisam do TEXTO dos prompts para julgar aderência ao escopo:
  // `run.prompts` guarda só metadados. Sem isto, ambos bloqueiam — corretamente.
  const promptContents = collectPromptContents(ctx);

  const auditPackage = buildMergeAuditPackage({
    project,
    run,
    pr: currentPr,
    checks: run.checks,
    finalTests: run.finalTests,
    commitLog: commitLog.ok ? commitLog.value : '',
    diffStat: diffStat.ok ? diffStat.value : '',
    diffPatch: diffPatch.ok ? diffPatch.value : '',
    promptContents,
  });

  const headSha = currentPr.headSha;
  const reviews: MergeReviewRecord[] = [];

  const auditChanged = await ports.git.changedFiles(ctx.workingDir);
  const auditCommon = {
    projectName: project.name,
    repositoryPath: project.repositoryPath,
    workingDirectory: ctx.workingDir,
    baseBranch: project.baseBranch,
    branchName: run.branchName ?? '',
    headSha,
    pullRequestNumber: currentPr.number,
    pullRequestUrl: currentPr.url,
    changedFiles: auditChanged.ok ? auditChanged.value : [],
    diffSummary: diffStat.ok ? diffStat.value : '',
    testsSummary: run.finalTests ? summarizeTestSuite(run.finalTests) : 'Suíte final não executada.',
    ciSummary: describeChecks(run),
    promptsSummary: describePrompts(run),
    minimumConfidence: ctx.policy.merge.minimumConfidence,
  };

  /* --- Auditoria independente do Claude ------------------------------- */
  run = saveStop(
    ctx,
    transition(run, 'RUNNING_CLAUDE_MERGE_AUDIT', 'Auditoria final independente do Claude.'),
  );
  const claudeSchema = loadSchema('claude-merge-review.schema.json');
  if (!claudeSchema.ok) return claudeSchema;

  const beforeClaudeAudit = haltIfRequested(ctx, run, 'auditoria final do Claude');
  if (beforeClaudeAudit) return ok({ run: beforeClaudeAudit, outcome: 'DONE', requestedBy: [], reasons: [] });

  const claudeDir = ensureDir(mergeAuditArtifactDir(project.id, run.runId, 'claude', headSha));
  ctx.control.setStep('auditoria final do Claude');
  const claudeAudit = await ports.agents.runClaude({
    role: 'merge-auditor',
    config,
    cwd: ctx.workingDir,
    instruction: `${buildClaudeMergeAuditInstruction({
      ...auditCommon,
      responseSchema: JSON.stringify(claudeSchema.value, null, 2),
    })}\n\n${auditPackage}`,
    timeoutMs: config.agents.claudeTimeoutSeconds * 1000,
    model: ctx.policy.agents.claudeModel,
    artifactDir: claudeDir,
    readOnly: true,
    signal: ctx.signal,
  });

  const claudeRecord = claudeAudit.ok
    ? toRecord('claude', parseMergeReview(claudeAudit.value.output, claudeSchema.value, headSha), headSha, path.join(claudeDir, 'claude-output.log'))
    : null;
  if (claudeRecord) reviews.push(claudeRecord);
  else logger.warn(`Auditoria do Claude indisponível: ${claudeAudit.ok ? 'JSON inválido' : claudeAudit.error.message}`);

  /* --- Auditoria independente do Codex -------------------------------- */
  run = saveStop(
    ctx,
    transition(run, 'RUNNING_CODEX_MERGE_AUDIT', 'Auditoria final independente do Codex.'),
  );
  const codexSchema = loadSchema('codex-merge-review.schema.json');
  if (!codexSchema.ok) return codexSchema;

  const beforeCodexAudit = haltIfRequested(ctx, run, 'auditoria final do Codex');
  if (beforeCodexAudit) return ok({ run: beforeCodexAudit, outcome: 'DONE', requestedBy: [], reasons: [] });

  const codexDir = ensureDir(mergeAuditArtifactDir(project.id, run.runId, 'codex', headSha));
  ctx.control.setStep('auditoria final do Codex');
  const codexAudit = await ports.agents.runCodex({
    role: 'merge-auditor',
    config,
    cwd: ctx.workingDir,
    instruction: `${buildCodexMergeAuditInstruction({
      ...auditCommon,
      responseSchema: JSON.stringify(codexSchema.value, null, 2),
    })}\n\n${auditPackage}`,
    timeoutMs: config.agents.codexTimeoutSeconds * 1000,
    model: ctx.policy.agents.codexModel,
    artifactDir: codexDir,
    readOnly: true,
    signal: ctx.signal,
  });

  const codexRecord = codexAudit.ok
    ? toRecord('codex', parseMergeReview(codexAudit.value.output, codexSchema.value, headSha), headSha, path.join(codexDir, 'codex-output.log'))
    : null;
  if (codexRecord) reviews.push(codexRecord);
  else logger.warn(`Auditoria do Codex indisponível: ${codexAudit.ok ? 'JSON inválido' : codexAudit.error.message}`);

  const reviewsSaved = persistCheckpoint(
    ctx,
    { ...run, mergeReviews: reviews },
    'registro das auditorias de merge',
  );
  if (!reviewsSaved.ok) return reviewsSaved;
  run = reviewsSaved.value;

  /* --- Consenso e gates ------------------------------------------------ */
  const consensusStateSaved = persistCheckpoint(
    ctx,
    transition(run, 'MERGE_CONSENSUS_PENDING', 'Avaliando consenso e gates.'),
    'entrada em MERGE_CONSENSUS_PENDING',
  );
  if (!consensusStateSaved.ok) return consensusStateSaved;
  run = consensusStateSaved.value;

  const latestPr = await ports.github.getPullRequest({
    cwd: ctx.workingDir,
    repo: project.githubRepository,
    prNumber: currentPr.number,
  });
  const prForGates = latestPr.ok ? latestPr.value : currentPr;
  const latestChecks = await ports.github.getChecks({
    cwd: ctx.workingDir,
    repo: project.githubRepository,
    prNumber: currentPr.number,
  });
  if (latestChecks.ok) {
    const checksSaved = persistCheckpoint(
      ctx,
      { ...run, checks: latestChecks.value },
      'releitura dos checks antes dos gates',
    );
    if (!checksSaved.ok) return checksSaved;
    run = checksSaved.value;
  }

  const claudeFinal = reviews.find((r) => r.auditor === 'claude') ?? null;
  const codexFinal = reviews.find((r) => r.auditor === 'codex') ?? null;

  const consensus = computeConsensus({
    project,
    currentHeadSha: prForGates.headSha,
    claude: claudeFinal,
    codex: codexFinal,
  });

  const gateReport = evaluateGates({
    project,
    run,
    pr: prForGates,
    checks: run.checks,
    finalTests: run.finalTests,
    currentHeadSha: prForGates.headSha,
    currentBaseSha: prForGates.baseSha,
    claudeReview: claudeFinal,
    codexReview: codexFinal,
  });

  const gatesSaved = persistCheckpoint(
    ctx,
    { ...run, consensus, gateReport, pullRequest: prForGates },
    'registro do consenso e dos gates',
  );
  if (!gatesSaved.ok) return gatesSaved;
  run = gatesSaved.value;

  if (!consensus.reached || !gateReport.allPassed) {
    const reasons = [
      ...consensus.reasons,
      ...gateReport.failedGates.map((id) => `gate reprovado: ${id}`),
    ];

    /*
     * Distinguir "auditor pediu mudanças" de "bloqueio estrutural".
     *
     * Um pedido de mudança é corrigível pelo executor e merece um ciclo do
     * orçamento. Um gate de CI vermelho, conflito de merge ou thread não
     * resolvida não se resolve editando código aqui — insistir gastaria duas
     * auditorias por volta para chegar ao mesmo lugar.
     */
    const requestedBy = auditorsRequestingChanges(claudeFinal, codexFinal);
    if (requestedBy.length > 0) {
      logger.warn(
        `Auditoria pediu mudanças (${requestedBy.join(', ')}). ${reasons.slice(0, 3).join(' | ')}`,
      );
      return ok({ run, outcome: 'CHANGES_REQUESTED', requestedBy, reasons });
    }

    logger.warn(`Merge NÃO autorizado. ${reasons.join(' | ')}`);
    run = saveStop(
      ctx,
      transition(run, 'BLOCKED', `Merge não autorizado: ${reasons.slice(0, 5).join(' | ')}`),
    );
    return done(run);
  }

  /* --- Merge ----------------------------------------------------------- */
  const approvedSaved = persistCheckpoint(
    ctx,
    transition(run, 'MERGE_APPROVED', 'Todos os gates aprovados; merge autorizado.'),
    'autorização de merge',
  );
  if (!approvedSaved.ok) return approvedSaved;
  run = approvedSaved.value;

  /*
   * ÚLTIMO portão antes da única ação irreversível do produto.
   *
   * A partir de `MERGING` não há mais volta: o merge é a fronteira em que um
   * cancelamento tardio deixaria de ser cancelamento. Aqui a intenção ainda é
   * honrada; depois daqui, não seria honesto prometer que seria.
   */
  const beforeMerge = haltIfRequested(ctx, run, 'execução do merge');
  if (beforeMerge) return ok({ run: beforeMerge, outcome: 'DONE', requestedBy: [], reasons: [] });

  const persistedBeforeMerge = assertPersistence(ctx, 'execução do merge');
  if (!persistedBeforeMerge.ok) return persistedBeforeMerge;

  /* O ÚLTIMO checkpoint antes da única ação irreversível do produto. Se ele
     não chegar ao disco, o merge não acontece: um merge sem rastro é a pior
     combinação possível entre efeito e ausência de registro. */
  const mergingSaved = persistCheckpoint(
    ctx,
    transition(run, 'MERGING', 'Executando squash merge protegido por SHA.'),
    'entrada em MERGING',
  );
  if (!mergingSaved.ok) return mergingSaved;
  run = mergingSaved.value;

  ctx.control.setStep('executando o merge');
  const merged = await ctx.ports.merge.execute({
    project,
    run,
    pr: prForGates,
    gateReport,
    consensus,
    cwd: ctx.workingDir,
    logger,
  });

  if (!merged.ok) {
    run = saveStop(ctx, {
      ...transition(run, 'BLOCKED', `Merge não executado: ${merged.error.message}`),
      lastError: merged.error,
    });
    return done(run);
  }

  const mergedSaved = persistCheckpoint(
    ctx,
    { ...transition(run, 'MERGED', 'Pull request mergeada com sucesso.'), mergeOutcome: merged.value },
    'registro do merge concluído',
  );
  if (!mergedSaved.ok) return mergedSaved;
  run = mergedSaved.value;
  logger.info(`Merge concluído. SHA: ${merged.value.mergeSha ?? 'desconhecido'}`);
  return done(run);
}

/** Auditores que pediram mudanças corrigíveis, com ação concreta declarada. */
function auditorsRequestingChanges(
  claude: MergeReviewRecord | null,
  codex: MergeReviewRecord | null,
): Array<'claude' | 'codex'> {
  const out: Array<'claude' | 'codex'> = [];
  for (const record of [claude, codex]) {
    if (!record || record.invalidated) continue;
    const review = record.review;
    if (!review) continue;
    if (review.verdict === 'APPROVED_FOR_MERGE') continue;
    /* Sem ação concreta não há o que corrigir: encaminhar um "não aprovo" vago
       produziria correção às cegas, exatamente o que o Loop Guard recusa na
       revisão de prompt. */
    const hasAction =
      review.requiredActions.length > 0 || review.blockingIssues.length > 0;
    if (hasAction) out.push(record.auditor);
  }
  return out;
}

/** Parada nomeada do orçamento de auditoria. Não mergeia, preserva tudo. */
function applyMergeCorrectionStop(
  ctx: Context,
  run: RunRecord,
  limit: number,
  requestedBy: Array<'claude' | 'codex'>,
  reasons: string[],
): RunRecord {
  const reason =
    `O orçamento de ${String(limit)} ciclo(s) de correção após auditoria foi consumido e os ` +
    'auditores continuam pedindo mudanças. A PR, a branch e o worktree foram preservados para revisão humana.';
  ctx.logger.warn(`MERGE_CORRECTION_BUDGET_EXHAUSTED — ${reason}`);

  const decision: LoopGuardDecision = {
    allowed: false,
    severity: severityOf('MERGE_CORRECTION_BUDGET_EXHAUSTED'),
    trigger: 'MERGE_CORRECTION_BUDGET_EXHAUSTED',
    reason,
    evidence: { limit, cycles: run.mergeCorrectionCycles, requestedBy, reasons: reasons.slice(0, 5) },
    nextActions: ['OPEN_REPORT', 'MARK_FOR_MANUAL_REVIEW'],
  };

  return {
    ...transition(run, 'BLOCKED', `MERGE_CORRECTION_BUDGET_EXHAUSTED: ${reason}`, {
      trigger: 'MERGE_CORRECTION_BUDGET_EXHAUSTED',
    }),
    lastLoopGuard: decision,
  };
}

/**
 * Um ciclo de correção pedido pelas auditorias finais.
 *
 * Produz um commit novo sobre a mesma branch e, com ele, um head SHA novo —
 * o que obriga a invalidar toda a evidência anterior antes de auditar de novo.
 */
async function correctAfterAudit(
  ctx: Context,
  input: RunRecord,
  cycle: number,
  requestedBy: Array<'claude' | 'codex'>,
  reasons: string[],
): Promise<Result<RunRecord>> {
  let run = input;
  const headShaBefore = run.pullRequest?.headSha ?? '';
  const startedAt = nowIso();
  const issueFingerprint = stableHash(reasons.map((r) => r.toLowerCase().trim()).sort());

  const dirResult = createExclusiveDirSync(
    path.join(
      projectArtifactsDir(ctx.project.id),
      run.runId,
      'merge-corrections',
      `cycle-${String(cycle).padStart(3, '0')}`,
    ),
  );
  if (!dirResult.ok) {
    run = saveStop(ctx, transition(run, 'FAILED', dirResult.error.message));
    return dirResult;
  }
  const dir = dirResult.value;
  writeExclusiveSync(
    path.join(dir, 'requested-changes.json'),
    `${JSON.stringify({ cycle, requestedBy, reasons, headShaBefore, startedAt }, null, 2)}\n`,
  );

  const correctionOpened = persistCheckpoint(
    ctx,
    {
      ...run,
      mergeCorrectionCycles: cycle,
      mergeCorrections: [
        ...run.mergeCorrections,
        {
          cycle,
          headShaBefore,
          requestedBy,
          issueFingerprint,
          startedAt,
          finishedAt: null,
          outcome: 'AGENT_FAILED',
          headShaAfter: null,
        },
      ],
    },
    `abertura da correção pós-auditoria ${String(cycle)}`,
  );
  if (!correctionOpened.ok) return correctionOpened;
  run = correctionOpened.value;

  /* A evidência antiga morre ANTES da correção começar: se o processo cair no
     meio, o que fica no disco não pode continuar afirmando que o código está
     aprovado. Por isso é um checkpoint: sem a invalidação no disco, a correção
     não começa. */
  const invalidated = persistCheckpoint(
    ctx,
    invalidateMergeApprovals(
      run,
      `Ciclo de correção ${String(cycle)} solicitado por ${requestedBy.join(', ')}.`,
    ),
    `invalidação das aprovações no ciclo ${String(cycle)}`,
  );
  if (!invalidated.ok) return invalidated;
  run = invalidated.value;

  const correctionRunning = persistCheckpoint(
    ctx,
    transition(run, 'RUNNING_CLAUDE', `Correção pós-auditoria ${String(cycle)}.`),
    `correção pós-auditoria ${String(cycle)}: entrada em RUNNING_CLAUDE`,
  );
  if (!correctionRunning.ok) return correctionRunning;
  run = correctionRunning.value;

  /* Mesma razão do reparo de CI: este corretor produz um commit novo sobre a
     branch que vai para o merge, então as Skills da rodada valem aqui também. */
  const skillsForCorrection = verifyRunSkills(run);
  if (!skillsForCorrection.ok) {
    run = saveStop(ctx, stopRunBySkillMutation(run, skillsForCorrection.error.message));
    return ok(run);
  }

  const instruction = withSkills(
    buildMergeCorrectionInstruction({
      projectName: ctx.project.name,
      cycle,
      maxCycles: ctx.policy.mergeAudit.maxCorrectionCycles,
      requestedBy,
      reasons,
      testCommands: ctx.policy.commands.tests,
    }),
    skillsForCorrection.value.claude,
  );
  writeExclusiveSync(path.join(dir, 'claude-instruction.md'), instruction);

  const beforeCorrection = haltIfRequested(ctx, run, `correção pós-auditoria ${String(cycle)}`);
  if (beforeCorrection) return ok(beforeCorrection);

  ctx.control.setStep(`correção pós-auditoria ${String(cycle)}: Claude corrigindo`);
  const claude = await ctx.ports.agents.runClaude({
    role: 'corrector',
    config: ctx.config,
    cwd: ctx.workingDir,
    instruction,
    timeoutMs: ctx.config.agents.claudeTimeoutSeconds * 1000,
    model: ctx.policy.agents.claudeModel,
    artifactDir: dir,
    readOnly: false,
    signal: ctx.signal,
  });

  const afterCorrectionAgent = haltIfRequested(
    ctx,
    run,
    `após a correção pós-auditoria ${String(cycle)}`,
  );
  if (afterCorrectionAgent) return ok(afterCorrectionAgent);

  if (!claude.ok) {
    run = saveStop(ctx, {
      ...finishMergeCorrection(run, cycle, 'AGENT_FAILED', null),
      ...transition(run, 'BLOCKED', `O executor falhou na correção pós-auditoria ${String(cycle)}.`),
      lastError: claude.error,
    });
    return ok(run);
  }

  const changed = await ctx.ports.git.changedFiles(ctx.workingDir);
  if (!changed.ok) return changed;
  if (changed.value.length === 0) {
    run = saveStop(
      ctx,
      transition(
        finishMergeCorrection(run, cycle, 'NO_CHANGES', null),
        'BLOCKED',
        `A correção pós-auditoria ${String(cycle)} não alterou nenhum arquivo: não há o que reauditar.`,
      ),
    );
    return ok(run);
  }

  const correctionTests = persistCheckpoint(
    ctx,
    transition(run, 'RUNNING_TESTS', 'Validando a correção pós-auditoria.'),
    `correção pós-auditoria ${String(cycle)}: entrada nos testes`,
  );
  if (!correctionTests.ok) return correctionTests;
  run = correctionTests.value;

  ctx.control.setStep(`correção pós-auditoria ${String(cycle)}: testes locais`);
  const tests = await ctx.ports.tests.run({
    commands: ctx.policy.commands.tests,
    cwd: ctx.workingDir,
    timeoutSeconds: ctx.policy.commands.timeoutSeconds,
    signal: ctx.signal,
  });
  writeExclusiveSync(path.join(dir, 'tests.json'), `${JSON.stringify(tests, null, 2)}\n`);
  const correctionTestsSaved = persistCheckpoint(
    ctx,
    { ...run, finalTests: tests },
    `correção pós-auditoria ${String(cycle)}: resultado dos testes`,
  );
  if (!correctionTestsSaved.ok) return correctionTestsSaved;
  run = correctionTestsSaved.value;

  const afterCorrectionTests = haltIfRequested(
    ctx,
    run,
    `correção pós-auditoria ${String(cycle)}: após os testes`,
  );
  if (afterCorrectionTests) return ok(afterCorrectionTests);

  if (!tests.passed) {
    run = saveStop(
      ctx,
      transition(
        finishMergeCorrection(run, cycle, 'TESTS_FAILED', null),
        'BLOCKED',
        `A correção pós-auditoria ${String(cycle)} reprovou nos testes locais.`,
      ),
    );
    return ok(run);
  }

  const patch = await ctx.ports.git.diffPatch(ctx.workingDir);
  if (patch.ok) writeExclusiveSync(path.join(dir, 'diff.patch'), patch.value);

  const beforeCorrectionCommit = haltIfRequested(
    ctx,
    run,
    `correção pós-auditoria ${String(cycle)}: commit`,
  );
  if (beforeCorrectionCommit) return ok(beforeCorrectionCommit);

  const message =
    `${ctx.policy.git.commitMessagePrefix} ${ctx.project.id}: correção pós-auditoria ${String(cycle)}`.trim();
  const correctionKey = `merge-correction-${String(cycle)}`;

  /* Mesmo write-ahead log do commit de prompt: a correção também escreve na
     branch que segue para o merge. */
  const commit = await commitWithJournal(ctx, run, {
    promptId: correctionKey,
    attempt: cycle,
    message,
    changedFiles: changed.value,
  });
  if (!commit.ok) return commit;

  const correctionCommitSaved = persistCheckpoint(
    ctx,
    {
      ...run,
      commits: [
        ...run.commits,
        { promptId: correctionKey, sha: commit.value.sha, message, at: nowIso() },
      ],
    },
    `correção pós-auditoria ${String(cycle)}: registro do commit`,
  );
  if (!correctionCommitSaved.ok) return correctionCommitSaved;
  run = correctionCommitSaved.value;
  settleCommitIntent(ctx.project.id, run.runId, commit.value.operationId, 'COMMITTED', commit.value.sha);

  const correctionPush = persistCheckpoint(
    ctx,
    transition(run, 'PUSHING', 'Enviando a correção pós-auditoria.'),
    `correção pós-auditoria ${String(cycle)}: entrada em PUSHING`,
  );
  if (!correctionPush.ok) return correctionPush;
  run = correctionPush.value;
  const pushed = await ctx.ports.git.push(
    ctx.workingDir,
    ctx.policy.repository.remote,
    run.branchName ?? '',
    false,
  );
  if (!pushed.ok) {
    run = saveStop(ctx, {
      ...finishMergeCorrection(run, cycle, 'AGENT_FAILED', commit.value.sha),
      ...transition(run, 'BLOCKED', 'Falha ao enviar a correção pós-auditoria.'),
      lastError: pushed.error,
    });
    return ok(run);
  }

  const correctionDone = persistCheckpoint(
    ctx,
    finishMergeCorrection(run, cycle, 'CORRECTED', commit.value.sha),
    `correção pós-auditoria ${String(cycle)}: conclusão`,
  );
  if (!correctionDone.ok) return correctionDone;
  run = correctionDone.value;

  /* Head novo exige CI novo: auditar sobre um commit cujo CI não rodou seria
     aprovar sem a evidência que o próprio gate exige. */
  if (ctx.policy.pullRequest.waitForChecks && run.pullRequest) {
    const ci = await runCiLoop(ctx, run, run.pullRequest.number);
    if (!ci.ok) return ci;
    run = ci.value;
  }

  return ok(run);
}

function finishMergeCorrection(
  run: RunRecord,
  cycle: number,
  outcome: MergeCorrectionRecord['outcome'],
  headShaAfter: string | null,
): RunRecord {
  return {
    ...run,
    mergeCorrections: run.mergeCorrections.map((entry) =>
      entry.cycle === cycle ? { ...entry, outcome, headShaAfter, finishedAt: nowIso() } : entry,
    ),
  };
}

function toRecord(
  auditor: 'claude' | 'codex',
  parsed: Result<MergeReview>,
  observedHeadSha: string,
  rawOutputPath: string,
): MergeReviewRecord | null {
  if (!parsed.ok) return null;
  return {
    auditor,
    review: parsed.value,
    producedAt: nowIso(),
    observedHeadSha,
    rawOutputPath,
    invalidated: false,
    invalidationReason: null,
  };
}

/* ------------------------------------------------------------------------- */
/* Auxiliares                                                                 */
/* ------------------------------------------------------------------------- */

/* ------------------------------------------------------------------------- */
/* Loop Guard — integração                                                    */
/* ------------------------------------------------------------------------- */

/**
 * Congela o conteúdo de cada prompt no início da execução.
 *
 * Toda tentativa posterior é comparada com este instantâneo: editar o arquivo
 * no meio do caminho invalida a execução em vez de misturar requisitos novos
 * com tentativas feitas sob requisitos antigos.
 */
/**
 * Confronta os arquivos alterados com as áreas declaradas no prompt.
 *
 * Regra de leitura: área proibida é sempre violação. Área permitida só é
 * cobrada quando o prompt declara alguma — um prompt sem `# Áreas permitidas`
 * declara escopo global, e nesse caso não há do que reclamar. O contrário
 * transformaria todo prompt sem essa seção em violação permanente.
 */
function classifyScope(
  prompt: ParsedPrompt,
  changedFiles: readonly string[],
): { outsideAllowed: string[]; forbidden: string[] } {
  const normalize = (value: string): string => value.replace(/\\/g, '/').replace(/^\.\//, '');
  const areas = (list: readonly string[]): string[] =>
    list.map(normalize).map((area) => area.replace(/\/+$/, '')).filter((area) => area.length > 0);

  const allowed = areas(prompt.allowedAreas);
  const forbiddenAreas = areas(prompt.forbiddenAreas);

  const matches = (file: string, area: string): boolean =>
    file === area || file.startsWith(`${area}/`);

  const forbidden: string[] = [];
  const outsideAllowed: string[] = [];

  for (const raw of changedFiles) {
    const file = normalize(raw);
    if (forbiddenAreas.some((area) => matches(file, area))) {
      forbidden.push(file);
      continue;
    }
    if (allowed.length > 0 && !allowed.some((area) => matches(file, area))) {
      outsideAllowed.push(file);
    }
  }

  return { outsideAllowed, forbidden };
}

function snapshotPrompts(prompts: readonly PromptFile[]): Map<string, string> {
  const snapshots = new Map<string, string>();
  for (const prompt of prompts) {
    const raw = readTextSync(prompt.absolutePath);
    snapshots.set(prompt.id, raw.ok ? contentHash(raw.value) : '');
  }
  return snapshots;
}

/**
 * Congela as fontes no instante da criação da execução.
 *
 * Os hashes de prompt viviam só em memória, recalculados no início de cada
 * processo. Numa retomada isso significava fotografar o prompt JÁ editado e
 * compará-lo consigo mesmo: `PROMPT_CHANGED_DURING_RUN` não podia disparar.
 * Persistindo aqui, a comparação passa a ser contra o conteúdo original.
 */
function captureSourceSnapshots(
  project: ProjectConfig,
  prompts: readonly PromptFile[],
  roundConfigHash: string | null,
): RunSourceSnapshots {
  const promptHashes: Record<string, string> = {};
  for (const [id, hash] of snapshotPrompts(prompts)) promptHashes[id] = hash;

  const contextRaw = readTextSync(path.join(projectDir(project.id), 'PROJECT-CONTEXT.md'));

  return {
    promptHashes,
    /* Cobre inclusão e remoção de prompts, que a comparação por prompt não
       enxerga: um prompt novo simplesmente não teria par para comparar. */
    promptSetHash: stableHash(
      [...prompts].map((prompt) => prompt.id).sort(),
    ),
    projectContextHash: contextRaw.ok ? contentHash(contextRaw.value) : '',
    projectConfigHash: executionRelevantProjectConfigHash(project),
    roundConfigHash,
  };
}

/* ------------------------------------------------------------------------- */
/* Skills da rodada                                                           */
/* ------------------------------------------------------------------------- */

/**
 * Resolve e congela as Skills declaradas, antes de a execução existir.
 *
 * Falha — nunca degrada. Skill ausente, versão divergente, status não aprovado
 * ou agente incompatível interrompem aqui, com a lista inteira de problemas de
 * uma vez: corrigir um por vez, descobrindo o próximo a cada tentativa, gasta
 * a paciência de quem opera sem nenhuma vantagem.
 */
function freezeDeclaredSkills(
  declaration: RoundSkillDeclaration | null,
): Result<SkillSnapshot | null> {
  if (declaration === null) return ok(null);

  const catalog = loadSkillCatalog();
  const resolved = resolveDeclaredSkills({ declaration, catalog: catalog.skills });
  if (!resolved.ok) {
    /* Manifesto malformado é reportado junto: sem isso, a mensagem diria
       "Skill ausente" enquanto o problema real é um `skill.json` quebrado, e a
       pessoa procuraria no lugar errado. */
    const detail =
      catalog.problems.length > 0
        ? `${resolved.error.message}\n\nSkills inválidas no catálogo:\n- ${catalog.problems.join('\n- ')}`
        : resolved.error.message;
    return fail('VALIDATION_FAILED', detail, {
      problems: resolved.error.details?.['problems'] ?? [],
      catalogProblems: catalog.problems,
    });
  }

  return ok(snapshotSkills(resolved.value));
}

/** Resumo legível do congelamento, para o log de criação da execução. */
function describeFrozenSkills(snapshot: SkillSnapshot | null): string {
  if (snapshot === null) return 'sem Skills declaradas';
  const total = snapshot.claude.length + snapshot.codex.length;
  if (total === 0) return 'sem Skills declaradas';
  return (
    `${String(total)} Skill(s) congelada(s) ` +
    `(claude: ${String(snapshot.claude.length)}, codex: ${String(snapshot.codex.length)})`
  );
}

/**
 * Confere as Skills contra o congelado e DEVOLVE as que passaram.
 *
 * Chamada antes de cada invocação que PRODUZ ou JULGA o código da branch — o
 * executor, os três corretores (laço de prompt, reparo de CI e pós-auditoria)
 * e o revisor —, e não só na retomada: editar uma Skill entre uma tentativa e
 * a seguinte muda as regras no meio da execução, exatamente como editar um
 * prompt, e a tentativa anterior já rodou sob as regras antigas.
 *
 * As duas auditorias finais de merge ficam de fora de propósito. Elas julgam
 * o resultado em sessão limpa e independente; injetar nelas o mesmo documento
 * que orientou quem escreveu o código enfraqueceria justamente a independência
 * que torna o consenso das duas uma evidência.
 *
 * Devolve o que verificou, em vez de só aprovar, porque quem renderiza precisa
 * usar ESTES objetos. Enquanto a conferência lia o catálogo e o render lia de
 * novo, havia uma janela entre as duas leituras em que o texto entregue ao
 * agente podia não ser o texto que passou na conferência.
 */
function verifyRunSkills(run: RunRecord): Result<ResolvedSkills> {
  const empty: ResolvedSkills = { claude: [], codex: [] };
  if (!run.skills) return ok(empty);
  return verifySkillsAgainstSnapshot(run.skills, loadSkillCatalog().skills);
}

/**
 * Junta o bloco de Skills à instrução, sem deixar linha em branco sobrando.
 *
 * O snapshot guarda hashes, não o texto: o conteúdo é relido do catálogo e
 * conferido antes de chegar aqui. Isso mantém o `RunRecord` sem cópias de
 * documento e ainda assim prova que o agente recebeu o que foi congelado.
 */
function withSkills(instruction: string, skills: readonly LoadedSkill[]): string {
  const block = renderSkillsForAgent(skills);
  return block === '' ? instruction : `${instruction}\n\n${block}`;
}

/**
 * Parada por Skill alterada, registrada como qualquer outra decisão do guard.
 *
 * Passa por `applyLoopGuardStop` de propósito: assim a parada grava artefato,
 * marca o prompt como bloqueado e aparece no relatório pelo mesmo caminho das
 * demais. Uma parada com tratamento próprio seria uma parada que o relatório
 * conta de um jeito diferente.
 */
/**
 * Parada por Skill alterada FORA do laço de prompt.
 *
 * O reparo de CI e a correção pós-auditoria não são escopados por prompt: não
 * reabrem prompt aprovado nem consomem orçamento de tentativa. A parada aqui é
 * da execução, e por isso não passa por `applyLoopGuardStop`, que faria a
 * escrituração de um prompt que não está em jogo.
 */
function stopRunBySkillMutation(run: RunRecord, reason: string): RunRecord {
  const decision: LoopGuardDecision = {
    allowed: false,
    severity: severityOf('SKILL_CHANGED_DURING_RUN'),
    trigger: 'SKILL_CHANGED_DURING_RUN',
    reason,
    evidence: { frozenSkills: run.skills },
    nextActions: ['OPEN_REPORT', 'START_NEW_RUN'],
  };

  /* O trabalho é preservado: branch, PR e worktree continuam intactos. */
  return {
    ...transition(run, 'LOOP_GUARD_TRIGGERED', `SKILL_CHANGED_DURING_RUN: ${reason}`, {
      trigger: 'SKILL_CHANGED_DURING_RUN',
    }),
    lastLoopGuard: decision,
  };
}

function stopBySkillMutation(
  ctx: Context,
  run: RunRecord,
  promptId: string,
  reason: string,
): RunRecord {
  return applyLoopGuardStop(ctx, run, promptId, {
    allowed: false,
    severity: severityOf('SKILL_CHANGED_DURING_RUN'),
    trigger: 'SKILL_CHANGED_DURING_RUN',
    reason,
    evidence: { frozenSkills: run.skills },
    nextActions: ['OPEN_REPORT', 'START_NEW_RUN'],
  });
}

/** Hashes originais dos prompts: do registro quando houver, do disco na criação. */
function promptSnapshotsOf(
  run: RunRecord,
  prompts: readonly PromptFile[],
): Map<string, string> {
  const persisted = run.sourceSnapshots?.promptHashes;
  if (!persisted) return snapshotPrompts(prompts);
  return new Map(Object.entries(persisted));
}

/** Estados que já representam uma parada nomeada e não devem ser sobrescritos. */
function isStopState(state: RunState): boolean {
  const stops: ReadonlySet<RunState> = new Set<RunState>([
    'LOOP_GUARD_TRIGGERED',
    'BLOCKED',
    'AUTH_REQUIRED',
    'USAGE_LIMIT_REACHED',
    'INTERRUPTED',
    'CANCELLED',
    'FAILED',
  ]);
  return stops.has(state);
}

function budgetOf(run: RunRecord, promptId: string): PromptBudget {
  return (
    run.budgets.find((entry) => entry.promptId === promptId) ?? createPromptBudget(promptId)
  );
}

function withBudget(
  run: RunRecord,
  promptId: string,
  update: (budget: PromptBudget) => PromptBudget,
): RunRecord {
  const existing = run.budgets.find((entry) => entry.promptId === promptId);
  const next = update(existing ?? createPromptBudget(promptId));
  const budgets = existing
    ? run.budgets.map((entry) => (entry.promptId === promptId ? next : entry))
    : [...run.budgets, next];
  return { ...run, budgets };
}

/** Marca o início do relógio do prompt sem zerar o tempo já consumido. */
function startPromptClock(run: RunRecord, promptId: string, at: string): RunRecord {
  return withBudget(run, promptId, (budget) => ({
    ...budget,
    attempts: budget.attempts + 1,
    startedAt: budget.startedAt ?? at,
  }));
}

/** Contabiliza uma chamada de IA. Chamado imediatamente após cada invocação. */
export function recordAgentCall(
  run: RunRecord,
  promptId: string,
  agent: 'claude' | 'codex',
): RunRecord {
  return withBudget(run, promptId, (budget) => ({
    ...budget,
    claudeCalls: budget.claudeCalls + (agent === 'claude' ? 1 : 0),
    codexCalls: budget.codexCalls + (agent === 'codex' ? 1 : 0),
  }));
}

/**
 * Reúne a evidência da tentativa anterior e consulta o Loop Guard.
 *
 * Os hashes de prompt, contexto e configuração são recalculados a cada volta:
 * é assim que uma edição feita no meio da execução é detectada em vez de
 * silenciosamente misturada às tentativas já realizadas.
 */
function decideNextAttempt(
  ctx: Context,
  run: RunRecord,
  promptId: string,
  nextAttempt: number,
  evidence: { previousReview: PromptReview | null; lastTests: TestSuiteResult | null },
): LoopGuardDecision {
  const budget = budgetOf(run, promptId);
  /* Limites SEMPRE da política congelada. Nunca de `ctx.project`. */
  const loopConfig = ctx.policy.loopGuard;

  const promptFile = ctx.prompts.find((p) => p.id === promptId);
  const currentPromptRaw = promptFile ? readTextSync(promptFile.absolutePath) : null;
  const promptHashNow =
    currentPromptRaw && currentPromptRaw.ok ? contentHash(currentPromptRaw.value) : '';

  const contextRaw = readTextSync(
    path.join(projectDir(ctx.project.id), 'PROJECT-CONTEXT.md'),
  );
  const contextHashNow = contextRaw.ok ? contentHash(contextRaw.value) : '';

  /*
   * O hash "de agora" precisa vir do DISCO.
   *
   * Antes ele era calculado sobre `ctx.project` — o mesmo objeto em memória
   * que originou o snapshot, carregado uma única vez no início. A comparação
   * era do objeto contra si mesmo e nunca podia falhar. Reler o cadastro é o
   * que torna a Regra 2 (mutação interrompe) efetiva sem violar a Regra 1 (a
   * política congelada continua valendo).
   */
  const onDisk = getProject(ctx.project.id);
  const configHashNow = onDisk.ok
    ? executionRelevantProjectConfigHash(onDisk.value)
    : /* Projeto removido durante a execução conta como mutação, não como
         "sem alteração": string vazia desligaria a detecção. */
      'absent';

  const diffs = budget.diffFingerprints;
  const previousDiff = diffs.length >= 2 ? diffs[diffs.length - 2] ?? null : null;
  const currentDiff = diffs.length >= 1 ? diffs[diffs.length - 1] ?? null : null;

  return evaluateLoopGuard({
    config: loopConfig,
    budget,
    maxAttemptsPerPrompt: ctx.policy.loopGuard.maxAttemptsPerPrompt,
    nextAttempt,
    nowMs: Date.now(),
    runStartedAtMs: Date.parse(run.createdAt) || Date.now(),

    pauseRequested: run.pauseRequested,
    cancelRequested: run.cancelRequested,
    aborted: ctx.signal?.aborted === true,

    lastAgentErrorCode: run.lastError ? run.lastError.code : null,

    promptHashNow,
    promptHashSnapshot: ctx.promptSnapshots.get(promptId) ?? '',
    contextHashNow,
    contextHashSnapshot: run.sourceSnapshots?.projectContextHash ?? '',
    configHashNow,
    configHashSnapshot: run.sourceSnapshots?.projectConfigHash ?? '',

    previousDiffFingerprint: previousDiff,
    currentDiffFingerprint: currentDiff,
    reviewFingerprint: reviewFingerprint(evidence.previousReview),
    testFailureFingerprint: testFailureFingerprint(evidence.lastTests),
    lastReview: evidence.previousReview,

    scopeViolations: ctx.lastScopeViolations,
    forbiddenViolations: ctx.lastForbiddenViolations,
    changedFileCount: ctx.lastChangedFileCount,
    changedLineCount: ctx.lastChangedLineCount,

    reviewEvidenceComplete: ctx.lastReviewEvidenceComplete,

    overrideAvailable: hasUnconsumedOverride(run, promptId),
  });
}

function hasUnconsumedOverride(run: RunRecord, promptId: string): boolean {
  return hasPendingOverride(run, promptId);
}

/**
 * Aplica a parada: registra a decisão, bloqueia o prompt e leva a execução ao
 * estado `LOOP_GUARD_TRIGGERED`. O trabalho não é desfeito — worktree, branch,
 * arquivos e artefatos permanecem intactos para inspeção humana.
 */
function applyLoopGuardStop(
  ctx: Context,
  run: RunRecord,
  promptId: string,
  decision: LoopGuardDecision,
): RunRecord {
  ctx.logger.warn(describeDecision(decision));

  const withRecord = withBudget(run, promptId, (budget) => ({
    ...budget,
    lastTrigger: decision.trigger,
    lastDecisionAt: nowIso(),
  }));

  const marked = updatePromptProgress(withRecord, promptId, { status: 'BLOCKED' });

  const nextState: RunState =
    decision.trigger === 'USER_CANCELLED'
      ? 'CANCELLED'
      : decision.trigger === 'USER_PAUSED'
        ? 'INTERRUPTED'
        : decision.trigger === 'AUTH_REQUIRED'
          ? 'AUTH_REQUIRED'
          : decision.trigger === 'USAGE_LIMIT_REACHED'
            ? 'USAGE_LIMIT_REACHED'
            : 'LOOP_GUARD_TRIGGERED';

  const message = `Prompt ${promptId}: ${decision.trigger ?? 'parada'} — ${decision.reason}`;

  writeLoopGuardArtifacts(ctx, run, promptId, decision);

  return {
    ...transition(marked, nextState, message, { trigger: decision.trigger }),
    lastLoopGuard: decision,
  };
}

/**
 * Grava a evidência da parada em um diretório NOVO, nunca reaproveitado.
 *
 * Antes, `loop-guard.json` e `LOOP-GUARD.md` moravam em um caminho fixo por
 * prompt e eram truncados a cada parada. O caso que isso destruía é justamente
 * o mais importante: a pessoa autoriza um override lendo a decisão da parada
 * anterior, a tentativa extra roda, para de novo — e a decisão que fundamentou
 * a autorização já não existe para conferência.
 *
 * A numeração vem do que está PERSISTIDO, e o diretório é criado com
 * exclusividade: colisão vira `STATE_CORRUPT` em vez de sobrescrita silenciosa.
 */
function writeLoopGuardArtifacts(
  ctx: Context,
  run: RunRecord,
  promptId: string,
  decision: LoopGuardDecision,
): void {
  const budget = budgetOf(run, promptId);
  const stopsDir = path.join(
    projectArtifactsDir(ctx.project.id),
    run.runId,
    promptId,
    'stops',
  );

  const index = readStopIndex(stopsDir);
  const stopSequence = index.length + 1;
  const previous = index[index.length - 1] ?? null;
  const createdAt = nowIso();

  const payload = {
    stopSequence,
    attempt: budget.attempts,
    trigger: decision.trigger,
    decision,
    budget,
    policyEffectiveHash: ctx.policy.effectiveHash,
    previousStopHash: previous ? previous.decisionHash : null,
    createdAt,
  };
  const decisionHash = stableHash(payload);

  const dir = createExclusiveDirSync(
    path.join(stopsDir, `stop-${String(stopSequence).padStart(3, '0')}`),
  );
  if (!dir.ok) {
    /* Não sobrescreve e não silencia: o operador precisa saber que a numeração
       divergiu do disco antes de confiar no que vai ler. */
    ctx.logger.error(dir.error.message);
    return;
  }

  writeExclusiveSync(
    path.join(dir.value, 'loop-guard.json'),
    `${JSON.stringify({ ...payload, decisionHash }, null, 2)}\n`,
  );
  writeExclusiveSync(
    path.join(dir.value, 'LOOP-GUARD.md'),
    renderLoopGuardReport({
      project: ctx.project,
      run,
      promptId,
      decision,
      budget,
      policy: ctx.policy.loopGuard,
    }),
  );

  /* O índice é o único arquivo reescrito, e é derivado: perdê-lo não perde
     evidência, porque cada parada carrega sua própria cópia dos campos. */
  const entry: StopIndexEntry = {
    stopSequence,
    attempt: budget.attempts,
    trigger: decision.trigger,
    previousStopHash: previous ? previous.decisionHash : null,
    decisionHash,
    createdAt,
  };
  writeArtifactSync(
    path.join(stopsDir, 'index.json'),
    `${JSON.stringify([...index, entry], null, 2)}\n`,
  );
}

interface StopIndexEntry {
  stopSequence: number;
  attempt: number;
  trigger: LoopGuardTrigger | null;
  previousStopHash: string | null;
  decisionHash: string;
  createdAt: string;
}

/**
 * Sequência da próxima parada, derivada do disco.
 *
 * Deriva de `max(paradas persistidas)` e não de um contador em memória: um
 * contador local reinicia junto com o processo, e reiniciar a numeração é
 * exatamente o que reintroduz a sobrescrita. O índice é conferido contra os
 * diretórios reais para que um índice truncado não faça a contagem recuar.
 */
function readStopIndex(stopsDir: string): StopIndexEntry[] {
  const fromIndex = readJsonSync<StopIndexEntry[]>(path.join(stopsDir, 'index.json'));
  const entries = fromIndex.ok && Array.isArray(fromIndex.value) ? fromIndex.value : [];

  const onDisk = listDirectoriesSync(stopsDir).filter((name) => /^stop-\d+$/.test(name));
  if (onDisk.length <= entries.length) return entries;

  /* Diretórios sem entrada no índice significam índice perdido ou truncado.
     A contagem segue o disco, que é a evidência; o índice é só o atalho. */
  const highest = onDisk.reduce((max, name) => {
    const parsed = Number.parseInt(name.slice('stop-'.length), 10);
    return Number.isFinite(parsed) && parsed > max ? parsed : max;
  }, 0);
  const padded = [...entries];
  while (padded.length < highest) {
    padded.push({
      stopSequence: padded.length + 1,
      attempt: 0,
      trigger: null,
      previousStopHash: null,
      decisionHash: 'desconhecido',
      createdAt: 'desconhecido',
    });
  }
  return padded;
}

/**
 * A auditoria final só faz sentido quando a publicação chegou até o fim com
 * sucesso: PR aberta e CI aprovado. Qualquer estado de parada interrompe aqui.
 */
function canProceedToAudit(run: RunRecord): boolean {
  const blocking: ReadonlySet<RunState> = new Set<RunState>([
    'CI_FAILED',
    'BLOCKED',
    'FAILED',
    'INTERRUPTED',
    'CANCELLED',
    'COMPLETED',
    'AUTH_REQUIRED',
    'USAGE_LIMIT_REACHED',
  ]);
  if (blocking.has(run.state)) return false;
  return run.pullRequest !== null;
}

/**
 * Persiste e devolve o registro REALMENTE gravado.
 *
 * Devolver o resultado da gravação não é detalhe: `saveRun` reconcilia a
 * intenção com o disco, então é por este retorno que o orquestrador enxerga uma
 * pausa pedida pelo painel entre uma etapa e a seguinte. Continuar com o objeto
 * de entrada reintroduziria o defeito.
 *
 * A falha de escrita não é descartada: fica em `ctx.persistError` e vira parada
 * explícita no próximo portão crítico (`assertPersistence`).
 */
/**
 * Persiste e devolve o registro gravado, SEM interromper o fluxo em caso de
 * falha.
 *
 * Reservado a um único uso: gravar um estado de PARADA (interrupção,
 * cancelamento, bloqueio, falha), quando não há mais nenhuma etapa depois. Não
 * existe efeito colateral a impedir, e lançar aqui trocaria a causa real da
 * parada por um erro de escrita. A falha ainda é registrada e logada.
 *
 * Para qualquer gravação seguida de trabalho — chamada de IA, teste, Git,
 * publicação, merge — use `persistCheckpoint`, que devolve `Result` e obriga o
 * chamador a decidir.
 */
function saveStop(ctx: Context, run: RunRecord, mode: IntentWriteMode = 'MERGE'): RunRecord {
  const saved = saveRun(run, mode);
  if (!saved.ok) {
    if (ctx.persistError === null) ctx.persistError = saved.error;
    ctx.logger.error(
      `Falha ao persistir o estado de parada da execução ${run.runId}: ${saved.error.message}`,
      { code: saved.error.code },
    );
    ctx.onUpdate?.(run);
    return run;
  }
  ctx.onUpdate?.(saved.value);
  return saved.value;
}

/**
 * Checkpoint FAIL-CLOSED: grava o estado e devolve `Result`.
 *
 * Esta é a única forma legítima de gravar antes de qualquer coisa que produza
 * efeito. O defeito que ela substitui: a versão anterior guardava o erro num
 * campo do contexto e devolvia o objeto NÃO persistido, deixando a tentativa
 * seguir — chamando testes, montando o pacote, chamando o Codex e commitando
 * com o disco parado numa versão antiga. Um commit podia nascer sem que o
 * estado persistido soubesse dele, que é exatamente o cenário que esta missão
 * existe para eliminar.
 *
 * Quem chama é obrigado pelo tipo a tratar a falha, e a falha significa PARAR.
 */
function persistCheckpoint(
  ctx: Context,
  run: RunRecord,
  step: string,
  mode: IntentWriteMode = 'MERGE',
): Result<RunRecord> {
  const saved = saveRun(run, mode);
  if (!saved.ok) {
    if (ctx.persistError === null) ctx.persistError = saved.error;
    ctx.logger.error(
      `Estado não pôde ser persistido em "${step}" (${run.runId}): ${saved.error.message}. ` +
        'A execução para aqui; nenhuma etapa posterior começa.',
      { code: saved.error.code, step },
    );
    ctx.onUpdate?.(run);
    return fail(
      saved.error.code,
      `Execução interrompida em "${step}": o estado não pôde ser persistido (${saved.error.message}). ` +
        'Avançar sem registro deixaria trabalho sem rastro e retomada impossível.',
      { ...(saved.error.details ?? {}), step, runId: run.runId },
    );
  }
  ctx.onUpdate?.(saved.value);
  return ok(saved.value);
}

/**
 * Portão de persistência para pontos que não acabaram de gravar nada, mas estão
 * prestes a produzir efeito. Recusa avançar se ALGUMA gravação anterior falhou.
 */
function assertPersistence(ctx: Context, step: string): Result<void> {
  const error = ctx.persistError;
  if (error === null) return ok(undefined);
  return fail(
    error.code,
    `Execução interrompida em "${step}": o estado não pôde ser persistido (${error.message}). ` +
      'Avançar sem registro deixaria trabalho sem rastro e retomada impossível.',
    { ...(error.details ?? {}), step },
  );
}

/** Descrição de uma parada pedida de fora da execução. */
interface ExternalStop {
  state: 'CANCELLED' | 'INTERRUPTED';
  trigger: 'USER_CANCELLED' | 'USER_PAUSED';
  reason: string;
}

/**
 * Lê a intenção externa a partir das DUAS fontes, nesta ordem de precedência:
 * cancelamento vence pausa, e qualquer das duas vence um aborto sem intenção
 * declarada (desligamento do painel, sinal do chamador).
 *
 * As duas fontes existem porque cobrem casos diferentes: o controlador vivo
 * atende o painel no mesmo processo, e o registro persistido atende a CLI, que
 * roda em outro. Nenhuma delas sozinha cobre o produto inteiro.
 */
function externalStop(ctx: Context, run: RunRecord): ExternalStop | null {
  if (run.cancelRequested || ctx.control.cancelRequested) {
    return {
      state: 'CANCELLED',
      trigger: 'USER_CANCELLED',
      reason: 'Cancelamento solicitado pelo usuário.',
    };
  }
  if (run.pauseRequested || ctx.control.pauseRequested) {
    return {
      state: 'INTERRUPTED',
      trigger: 'USER_PAUSED',
      reason:
        ctx.control.intent === 'SHUTDOWN'
          ? 'Execução interrompida pelo desligamento do processo hospedeiro.'
          : 'Pausa solicitada pelo usuário.',
    };
  }
  if (ctx.signal.aborted) {
    return {
      state: 'INTERRUPTED',
      trigger: 'USER_PAUSED',
      reason: 'Execução abortada por sinal externo.',
    };
  }
  return null;
}

/**
 * Aplica a parada externa preservando TUDO: branch, worktree, commits,
 * artefatos, tentativas consumidas e aprovações já emitidas.
 *
 * O único ajuste no progresso é devolver a `PENDING` o prompt que estava em
 * `RUNNING`: a tentativa foi abortada, não concluída, e deixá-la como "em
 * execução" descreveria um trabalho que não está acontecendo. O contador de
 * tentativas continua onde estava — a tentativa custou assinatura e a retomada
 * não pode fingir que ela não existiu.
 */
function applyExternalStop(
  ctx: Context,
  run: RunRecord,
  stop: ExternalStop,
  step: string,
): RunRecord {
  /* Idempotência: pedir de novo o que já foi feito não produz nova transição
     nem novo estado final. */
  if (run.state === stop.state) return run;

  const decision: LoopGuardDecision = {
    allowed: false,
    severity: severityOf(stop.trigger),
    trigger: stop.trigger,
    reason: stop.reason,
    evidence: {
      step,
      intent: ctx.control.intent,
      intentSource: ctx.control.intentSource,
      pauseRequested: run.pauseRequested,
      cancelRequested: run.cancelRequested,
      aborted: ctx.signal.aborted,
    },
    nextActions:
      stop.state === 'CANCELLED'
        ? ['OPEN_REPORT', 'START_NEW_RUN']
        : ['OPEN_REPORT', 'MARK_FOR_MANUAL_REVIEW'],
  };

  ctx.logger.warn(`${stop.trigger}: ${stop.reason} Etapa interrompida: ${step}.`);

  /*
   * A intenção do controlador é espelhada NO REGISTRO.
   *
   * Quando o pedido chega pelo arquivo de estado, a marca já está lá; quando
   * chega pelo controlador vivo (painel no mesmo processo), ela precisa ser
   * gravada aqui, senão o estado persistido diria "interrompido" sem dizer por
   * quem. `SHUTDOWN` de propósito não marca nada: queda do processo hospedeiro
   * não é decisão do usuário, e confundi-las apagaria a distinção que o
   * operador usa para saber o que fazer em seguida.
   */
  const intent = ctx.control.intent;

  return {
    ...transition(rewindInFlightPrompt(run), stop.state, `${stop.trigger}: ${stop.reason}`, {
      trigger: stop.trigger,
      step,
    }),
    pauseRequested: run.pauseRequested || intent === 'PAUSE',
    cancelRequested: run.cancelRequested || intent === 'CANCEL',
    lastLoopGuard: decision,
  };
}

/** Devolve a `PENDING` o prompt cuja tentativa foi abortada no meio. */
function rewindInFlightPrompt(run: RunRecord): RunRecord {
  const running = run.prompts.find((prompt) => prompt.status === 'RUNNING');
  if (!running) return run;
  return updatePromptProgress(run, running.promptId, { status: 'PENDING' });
}

/**
 * Portão de interrupção, consultado ENTRE ETAPAS INTERNAS — não apenas entre
 * prompts.
 *
 * Devolve `null` quando é seguro prosseguir; caso contrário devolve o registro
 * já persistido no estado de parada. Quem chamar deve retornar imediatamente:
 * nenhuma etapa posterior pode começar depois que a intenção foi aceita.
 */
function haltIfRequested(ctx: Context, run: RunRecord, step: string): RunRecord | null {
  ctx.control.setStep(step);
  const stop = externalStop(ctx, run);
  if (stop === null) return null;
  return saveStop(ctx, applyExternalStop(ctx, run, stop, step));
}

function mapAgentErrorState(code: string): RunState {
  switch (code) {
    case 'USAGE_LIMIT_REACHED':
      return 'USAGE_LIMIT_REACHED';
    case 'AUTH_REQUIRED':
      return 'AUTH_REQUIRED';
    case 'TOOL_MISSING':
      return 'BLOCKED';
    case 'PROCESS_INTERRUPTED':
      return 'INTERRUPTED';
    default:
      return 'BLOCKED';
  }
}

/**
 * Lê do disco o texto de cada prompt da execução, para o pacote de auditoria.
 *
 * Um prompt ilegível não interrompe a auditoria: ele é omitido da lista, e a
 * própria seção do pacote declara a lacuna ao auditor.
 */
function collectPromptContents(ctx: Context): AuditedPromptContent[] {
  const contents: AuditedPromptContent[] = [];
  for (const promptFile of ctx.prompts) {
    const parsed = readPrompt(promptFile);
    if (!parsed.ok) {
      ctx.logger.warn(
        `Não foi possível ler o prompt ${promptFile.id} para o pacote de auditoria: ${parsed.error.message}`,
      );
      continue;
    }
    contents.push({
      id: parsed.value.id,
      name: parsed.value.name,
      body: parsed.value.rawBody,
      scope: parsed.value.scope,
      outOfScope: parsed.value.outOfScope,
      allowedAreas: parsed.value.allowedAreas,
      forbiddenAreas: parsed.value.forbiddenAreas,
      acceptanceCriteria: parsed.value.acceptanceCriteria,
    });
  }
  return contents;
}

function describeChecks(run: RunRecord): string {
  const checks = run.checks;
  if (!checks) return 'Nenhum dado de CI disponível.';
  return [
    `Total: ${checks.total} · aprovados: ${checks.passed} · falhos: ${checks.failed} · pendentes: ${checks.pending} · ignorados: ${checks.skipped}`,
    `Todos os obrigatórios passaram: ${checks.allRequiredPassed ? 'sim' : 'não'}`,
    ...checks.runs.map(
      (check) =>
        `  - ${check.name}: ${check.conclusion}${check.required ? ' (obrigatório)' : ''}`,
    ),
  ].join('\n');
}

function describePrompts(run: RunRecord): string {
  return run.prompts
    .map(
      (prompt) =>
        `- ${prompt.promptId}: ${prompt.status} (tentativas: ${prompt.attempts}, commit: ${prompt.commitSha ?? '—'})`,
    )
    .join('\n');
}

function renderTestsLog(tests: TestSuiteResult): string {
  const parts: string[] = [];
  for (const command of tests.commands) {
    parts.push('='.repeat(78));
    parts.push(`COMANDO: ${command.command}`);
    parts.push(`STATUS : ${command.status} (exit ${command.exitCode ?? '—'})`);
    parts.push(`INÍCIO : ${command.startedAt}`);
    parts.push(`FIM    : ${command.finishedAt}`);
    parts.push('-'.repeat(78));
    parts.push(command.stdout);
    if (command.stderr.trim().length > 0) {
      parts.push('--- stderr ---');
      parts.push(command.stderr);
    }
    parts.push('');
  }
  return parts.join('\n');
}

function writeAttemptSummary(
  ctx: Context,
  run: RunRecord,
  promptFile: PromptFile,
  attempt: number,
  startedAt: string,
  data: {
    tests: TestSuiteResult | null;
    review: PromptReview | null;
    changedFiles: string[];
    approved: boolean;
    blocked: boolean;
    notes: string[];
  },
): void {
  const finishedAt = nowIso();
  const summary: AttemptSummary = {
    runId: run.runId,
    projectId: ctx.project.id,
    promptId: promptFile.id,
    attempt,
    startedAt,
    finishedAt,
    durationMs: Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt)),
    claude: null,
    tests: data.tests,
    codex: null,
    review: data.review,
    changedFiles: data.changedFiles,
    approved: data.approved,
    blocked: data.blocked,
    notes: data.notes,
  };
  writeArtifactSync(
    path.join(
      attemptArtifactDir(ctx.project.id, run.runId, promptFile.id, attempt),
      'attempt-summary.json',
    ),
    `${JSON.stringify(summary, null, 2)}\n`,
  );
}

/** Exposto para o comando `status` e para o painel. */
export function describeRunState(state: RunState): string {
  const labels: Record<RunState, string> = {
    IDLE: 'ocioso',
    VALIDATING: 'validando',
    PREPARING_WORKTREE: 'preparando worktree',
    RUNNING_CLAUDE: 'Claude implementando',
    RUNNING_TESTS: 'executando testes',
    BUILDING_REVIEW_PACKAGE: 'montando pacote de revisão',
    RUNNING_CODEX: 'Codex revisando',
    CHANGES_REQUESTED: 'correções solicitadas',
    PROMPT_APPROVED: 'prompt aprovado',
    COMMITTING: 'criando commit',
    PUSHING: 'enviando ao remoto',
    CREATING_PR: 'criando pull request',
    WAITING_CI: 'aguardando CI',
    CI_FAILED: 'CI reprovado',
    RUNNING_CLAUDE_MERGE_AUDIT: 'auditoria final do Claude',
    RUNNING_CODEX_MERGE_AUDIT: 'auditoria final do Codex',
    MERGE_CONSENSUS_PENDING: 'avaliando consenso',
    MERGE_APPROVED: 'merge autorizado',
    MERGING: 'executando merge',
    MERGED: 'mergeado',
    BLOCKED: 'bloqueado',
    AUTH_REQUIRED: 'autenticação necessária',
    USAGE_LIMIT_REACHED: 'limite de uso atingido',
    INTERRUPTED: 'interrompido',
    FAILED: 'falhou',
    COMPLETED: 'concluído',
    LOOP_GUARD_TRIGGERED: 'interrompido pela proteção contra looping',
    CANCELLED: 'cancelado',
  };
  return labels[state];
}

export { compactStamp };
