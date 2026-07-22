import * as path from 'node:path';
import type {
  AttemptSummary,
  GlobalConfig,
  Logger,
  MergeReview,
  MergeReviewRecord,
  ProjectConfig,
  PromptFile,
  PromptReview,
  Result,
  RunRecord,
  RunState,
  TestSuiteResult,
} from '../types';
import { fail, ok } from '../utils/errors';
import { writeArtifactSync } from '../utils/fs-atomic';
import { attemptArtifactDir, ensureDir, mergeAuditArtifactDir } from '../utils/paths';
import { compactStamp, nowIso } from '../utils/time';
import { buildRunBranchName } from '../security/branch-name';
import { inspectApiEnvironment } from '../security/api-guard';
import { getProject } from '../projects/project-store';
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
import { withLock } from '../state/locks';
import { buildMergeAuditPackage, buildReviewPackage } from '../review/review-package';
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
  buildClaudeMergeAuditInstruction,
  buildCodexMergeAuditInstruction,
  buildCodexPromptReviewInstruction,
} from '../agents/instruction-builder';
import { evaluateGates } from '../merge/gates';
import { computeConsensus } from '../merge/consensus';
import { defaultWorktreePath } from '../git/worktree';
import { remoteMatchesRepository } from '../git/git';
import { writeRunReport } from '../reports/report-generator';
import { renderPullRequestBody } from './pr-body';
import type { OrchestratorPorts } from './ports';

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
  signal: AbortSignal | undefined;
  onUpdate: ((run: RunRecord) => void) | undefined;
  prompts: PromptFile[];
  workingDir: string;
}

/* ------------------------------------------------------------------------- */
/* Entrada pública                                                            */
/* ------------------------------------------------------------------------- */

export async function runProject(options: RunOptions): Promise<Result<RunRecord>> {
  const locked = await withLock(
    {
      scope: 'project',
      key: options.projectId,
      projectId: options.projectId,
      operation: options.dryRun ? 'dry-run' : 'execução',
    },
    async () => executeWithinLock(options),
  );
  if (!locked.ok) return locked;
  return locked.value;
}

async function executeWithinLock(options: RunOptions): Promise<Result<RunRecord>> {
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
  if (options.resumeRunId) {
    const loaded = loadRun(project.id, options.resumeRunId);
    if (!loaded.ok) return loaded;
    run = loaded.value;
    run = { ...run, pauseRequested: false, cancelRequested: false };
    logger.info(`Retomando execução ${run.runId} no estado ${run.state}.`);
  } else {
    run = createRun({ projectId: project.id, dryRun: options.dryRun, prompts });
    logger.info(`Nova execução ${run.runId} com ${prompts.length} prompt(s).`);
  }

  const ctx: Context = {
    project,
    config,
    logger,
    ports,
    signal: options.signal,
    onUpdate: options.onUpdate,
    prompts,
    workingDir: run.workingDirectory ?? project.repositoryPath,
  };

  try {
    return await pipeline(ctx, run);
  } catch (error) {
    const failedRun: RunRecord = {
      ...transition(run, 'FAILED', 'Falha inesperada na execução.'),
      lastError: {
        code: 'INTERNAL',
        message: error instanceof Error ? error.message : String(error),
      },
    };
    saveRun(failedRun);
    ctx.onUpdate?.(failedRun);
    return fail('INTERNAL', 'Falha inesperada na execução.', { runId: run.runId }, error);
  }
}

/* ------------------------------------------------------------------------- */
/* Pipeline                                                                   */
/* ------------------------------------------------------------------------- */

async function pipeline(ctx: Context, initial: RunRecord): Promise<Result<RunRecord>> {
  let run = initial;

  const prepared = await prepare(ctx, run);
  if (!prepared.ok) return prepared;
  run = prepared.value;
  ctx.workingDir = run.workingDirectory ?? ctx.project.repositoryPath;

  if (run.dryRun) {
    run = save(ctx, transition(run, 'COMPLETED', 'Dry-run concluído: nenhuma alteração real.'));
    writeRunReport({ project: ctx.project, run });
    return ok(run);
  }

  const executed = await executePromptLoop(ctx, run);
  if (!executed.ok) return executed;
  run = executed.value;

  if (!allPromptsApproved(run)) {
    run = save(
      ctx,
      transition(run, 'BLOCKED', 'Nem todos os prompts foram aprovados; publicação interrompida.'),
    );
    writeRunReport({ project: ctx.project, run });
    return ok(run);
  }

  const published = await publish(ctx, run);
  if (!published.ok) return published;
  run = published.value;

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
  let run = save(ctx, transition(input, 'VALIDATING', 'Validando configuração e ferramentas.'));

  const { project, ports, config, logger } = ctx;

  const claudeOk = await ports.agents.claudeAvailable(config);
  if (!claudeOk) {
    run = save(
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
    run = save(ctx, transition(run, 'FAILED', 'Remoto do projeto não confere.'));
    return fail(
      'REMOTE_MISMATCH',
      `O remoto "${project.remote}" não aponta para ${project.githubRepository}. Push e merge foram impedidos por segurança.`,
      { expected: project.githubRepository },
    );
  }

  const baseSha = await ports.git.headSha(project.repositoryPath);
  if (!baseSha.ok) return baseSha;

  const branchResult = buildRunBranchName(project.id, run.runId.replace(/^run-/, ''));
  if (!branchResult.ok) return branchResult;
  const branchName = branchResult.value;

  if (run.dryRun) {
    const worktreePath = resolveWorktreePath(project, run.runId);
    run = save(ctx, {
      ...transition(run, 'PREPARING_WORKTREE', 'Dry-run: worktree apenas simulado.'),
      baseCommitSha: baseSha.value,
      branchName,
      worktreePath,
      workingDirectory: project.repositoryPath,
    });
    return ok(run);
  }

  run = save(ctx, {
    ...transition(run, 'PREPARING_WORKTREE', 'Preparando branch e worktree.'),
    baseCommitSha: baseSha.value,
    branchName,
  });

  if (!project.worktree.enabled) {
    run = save(ctx, { ...run, workingDirectory: project.repositoryPath, worktreePath: null });
    return ok(run);
  }

  const worktreePath = resolveWorktreePath(project, run.runId);
  const prepared = await ports.worktree.prepare({
    repoDir: project.repositoryPath,
    worktreePath,
    branch: branchName,
    baseRef: baseSha.value,
    reuseWhenSafe: project.worktree.reuseWhenSafe,
  });
  if (!prepared.ok) {
    save(ctx, transition(run, 'FAILED', 'Falha ao preparar o worktree.'));
    return prepared;
  }

  run = save(ctx, {
    ...run,
    worktreePath: prepared.value.path,
    workingDirectory: prepared.value.path,
  });
  return ok(run);
}

function resolveWorktreePath(project: ProjectConfig, runId: string): string {
  const root = project.worktree.rootPath ?? path.join(project.repositoryPath, '..', 'AI-Worktrees');
  return defaultWorktreePath(root, project.id, runId);
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

    const interrupted = checkInterrupt(ctx, run);
    if (interrupted) {
      run = save(ctx, transition(run, interrupted, 'Execução interrompida pelo usuário.'));
      return ok(run);
    }

    const parsed = readPrompt(promptFile);
    if (!parsed.ok) return parsed;

    const outcome = await executeSinglePrompt(ctx, run, promptFile, parsed.value);
    if (!outcome.ok) return outcome;
    run = outcome.value;

    const current = run.prompts.find((p) => p.promptId === promptFile.id);
    if (current?.status !== 'APPROVED') {
      if (ctx.project.execution.stopOnBlocked) {
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
  const maxAttempts = Math.max(1, project.execution.maxAttemptsPerPrompt);

  let previousReview: PromptReview | null = null;
  let lastTests: TestSuiteResult | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const artifactDir = ensureDir(
      attemptArtifactDir(project.id, run.runId, promptFile.id, attempt),
    );
    const attemptStartedAt = nowIso();

    writeArtifactSync(path.join(artifactDir, 'prompt-original.md'), parsed.rawBody);

    run = save(ctx, {
      ...transition(
        run,
        'RUNNING_CLAUDE',
        `Prompt ${promptFile.id}: tentativa ${attempt} de ${maxAttempts}.`,
      ),
      currentPromptId: promptFile.id,
      currentAttempt: attempt,
    });
    run = save(ctx, updatePromptProgress(run, promptFile.id, {
      status: 'RUNNING',
      attempts: attempt,
      lastAttemptAt: attemptStartedAt,
    }));

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
      testCommands: project.commands.tests,
    };

    const instruction =
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

    const claude = await ports.agents.runClaude({
      role: attempt === 1 ? 'executor' : 'corrector',
      config,
      cwd: ctx.workingDir,
      instruction,
      timeoutMs: config.agents.claudeTimeoutSeconds * 1000,
      model: project.agents.claudeModel ?? config.agents.defaultClaudeModel,
      artifactDir,
      readOnly: false,
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    });

    if (!claude.ok) {
      const state = mapAgentErrorState(claude.error.code);
      run = save(ctx, {
        ...transition(run, state, `Claude falhou no prompt ${promptFile.id}.`),
        lastError: claude.error,
      });
      return ok(run);
    }

    /* --- OrqPEG executa os testes oficiais ---------------------------- */
    run = save(ctx, transition(run, 'RUNNING_TESTS', 'Executando a suíte oficial de testes.'));
    const tests = await ports.tests.run({
      commands: project.commands.tests,
      cwd: ctx.workingDir,
      timeoutSeconds: project.commands.timeoutSeconds,
      ...(ctx.signal ? { signal: ctx.signal } : {}),
      onCommandStart: (command) => logger.info(`  → ${command}`),
    });
    lastTests = tests;
    writeArtifactSync(
      path.join(artifactDir, 'tests-summary.json'),
      `${JSON.stringify(tests, null, 2)}\n`,
    );
    writeArtifactSync(path.join(artifactDir, 'tests-full.log'), renderTestsLog(tests));

    /* --- Pacote de auditoria ------------------------------------------ */
    run = save(
      ctx,
      transition(run, 'BUILDING_REVIEW_PACKAGE', 'Montando o pacote de auditoria.'),
    );

    const changed = await ports.git.changedFiles(ctx.workingDir);
    const statusText = await ports.git.statusText(ctx.workingDir);
    const diffStat = await ports.git.diffStat(ctx.workingDir, run.baseCommitSha ?? undefined);
    const diffPatch = await ports.git.diffPatch(ctx.workingDir, run.baseCommitSha ?? undefined);

    const changedFiles = changed.ok ? changed.value : [];
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
    run = save(ctx, transition(run, 'RUNNING_CODEX', 'Codex revisando a implementação.'));

    const schema = loadSchema('prompt-review.schema.json');
    if (!schema.ok) return schema;

    const codex = await ports.agents.runCodex({
      role: 'prompt-reviewer',
      config,
      cwd: ctx.workingDir,
      // A instrução define as regras e o formato de resposta; o pacote de
      // auditoria (diff completo, testes, escopo) segue anexado como evidência.
      instruction: `${buildCodexPromptReviewInstruction({
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
      })}\n\n${reviewPackage}`,
      timeoutMs: config.agents.codexTimeoutSeconds * 1000,
      model: project.agents.codexModel ?? config.agents.defaultCodexModel,
      artifactDir,
      readOnly: true,
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    });

    if (!codex.ok) {
      // Sem revisor não há aprovação possível: o prompt fica bloqueado. Jamais
      // aprovamos por ausência do revisor.
      const state = mapAgentErrorState(codex.error.code);
      run = save(ctx, {
        ...transition(
          run,
          state,
          `Revisão do Codex indisponível para ${promptFile.id}: ${codex.error.message}`,
        ),
        lastError: codex.error,
      });
      run = save(ctx, updatePromptProgress(run, promptFile.id, { status: 'BLOCKED' }));
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
      run = save(ctx, transition(run, 'PROMPT_APPROVED', `Prompt ${promptFile.id} aprovado.`));
      const committed = await commitPrompt(ctx, run, promptFile, changedFiles);
      if (!committed.ok) return committed;
      run = committed.value;
      return ok(run);
    }

    if (review.value.verdict === 'BLOCKED') {
      run = save(ctx, updatePromptProgress(run, promptFile.id, {
        status: 'BLOCKED',
        lastVerdict: 'BLOCKED',
        blockingIssueCount: review.value.blockingIssues.length,
      }));
      run = save(
        ctx,
        transition(run, 'BLOCKED', `Prompt ${promptFile.id} bloqueado pelo revisor.`),
      );
      return ok(run);
    }

    run = save(ctx, updatePromptProgress(run, promptFile.id, {
      status: 'CHANGES_REQUESTED',
      lastVerdict: review.value.verdict,
      blockingIssueCount: review.value.blockingIssues.length,
    }));
    run = save(
      ctx,
      transition(
        run,
        'CHANGES_REQUESTED',
        `Correções solicitadas em ${promptFile.id} (tentativa ${attempt}).`,
      ),
    );
  }

  run = save(ctx, updatePromptProgress(run, promptFile.id, { status: 'FAILED' }));
  run = save(
    ctx,
    transition(
      run,
      'BLOCKED',
      `Prompt ${promptFile.id} não foi aprovado em ${maxAttempts} tentativa(s).`,
    ),
  );
  return ok(run);
}

async function commitPrompt(
  ctx: Context,
  input: RunRecord,
  promptFile: PromptFile,
  changedFiles: string[],
): Promise<Result<RunRecord>> {
  let run = input;
  if (!ctx.project.git.commitAfterApproval) {
    return ok(save(ctx, updatePromptProgress(run, promptFile.id, {
      status: 'APPROVED',
      approvedAt: nowIso(),
      lastVerdict: 'APPROVED',
    })));
  }

  if (changedFiles.length === 0) {
    ctx.logger.warn(
      `Prompt ${promptFile.id} aprovado sem alteração de arquivo; nenhum commit criado.`,
    );
    return ok(save(ctx, updatePromptProgress(run, promptFile.id, {
      status: 'APPROVED',
      approvedAt: nowIso(),
      lastVerdict: 'APPROVED',
    })));
  }

  run = save(ctx, transition(run, 'COMMITTING', `Criando commit de ${promptFile.id}.`));

  const staged = await ctx.ports.git.addPaths(ctx.workingDir, changedFiles);
  if (!staged.ok) return staged;

  const message = `${ctx.project.git.commitMessagePrefix} ${ctx.project.id}: concluir ${promptFile.id} — ${promptFile.name}`.trim();
  const commit = await ctx.ports.git.commit(ctx.workingDir, message);
  if (!commit.ok) return commit;

  run = save(ctx, {
    ...updatePromptProgress(run, promptFile.id, {
      status: 'APPROVED',
      approvedAt: nowIso(),
      commitSha: commit.value,
      lastVerdict: 'APPROVED',
    }),
    commits: [
      ...run.commits,
      { promptId: promptFile.id, sha: commit.value, message, at: nowIso() },
    ],
  });
  ctx.logger.info(`Commit ${commit.value.slice(0, 12)} criado para ${promptFile.id}.`);
  return ok(run);
}

/* ------------------------------------------------------------------------- */
/* Etapa 3 — suíte completa, push, PR e CI                                    */
/* ------------------------------------------------------------------------- */

async function publish(ctx: Context, input: RunRecord): Promise<Result<RunRecord>> {
  let run = input;
  const { project, ports, logger } = ctx;

  run = save(ctx, transition(run, 'RUNNING_TESTS', 'Executando a suíte completa.'));
  const finalTests = await ports.tests.run({
    commands: project.commands.tests,
    cwd: ctx.workingDir,
    timeoutSeconds: project.commands.timeoutSeconds,
    ...(ctx.signal ? { signal: ctx.signal } : {}),
    onCommandStart: (command) => logger.info(`  → ${command}`),
  });
  run = save(ctx, { ...run, finalTests });

  if (!finalTests.passed) {
    run = save(
      ctx,
      transition(run, 'BLOCKED', 'Suíte completa falhou; push e PR não foram executados.'),
    );
    return ok(run);
  }

  if (!project.git.pushAfterRun) {
    run = save(ctx, transition(run, 'COMPLETED', 'Execução concluída sem push (política do projeto).'));
    return ok(run);
  }

  run = save(ctx, transition(run, 'PUSHING', 'Enviando a branch ao remoto.'));
  const branch = run.branchName;
  if (!branch) return fail('INTERNAL', 'Branch da execução não definida.');

  const pushed = await ports.git.push(ctx.workingDir, project.remote, branch, true);
  if (!pushed.ok) {
    save(ctx, transition(run, 'FAILED', 'Falha no push.'));
    return pushed;
  }
  run = save(ctx, { ...run, pushedAt: nowIso(), pushedRemote: project.remote });

  if (!project.pullRequest.enabled) {
    run = save(ctx, transition(run, 'COMPLETED', 'Execução concluída sem PR (política do projeto).'));
    return ok(run);
  }

  run = save(ctx, transition(run, 'CREATING_PR', 'Criando pull request.'));

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
      repo: project.githubRepository,
      base: project.baseBranch,
      head: branch,
      title: `${project.git.commitMessagePrefix} ${project.name} — ${run.runId}`.trim(),
      body,
      draft: project.pullRequest.draftDuringExecution,
    });
    if (!created.ok) {
      save(ctx, transition(run, 'FAILED', 'Falha ao criar a pull request.'));
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

  run = save(ctx, { ...run, pullRequest: pr });
  logger.info(`Pull request #${pr.number}: ${pr.url}`);

  if (!project.pullRequest.waitForChecks) return ok(run);

  run = save(ctx, transition(run, 'WAITING_CI', 'Aguardando o CI do GitHub Actions.'));
  const checks = await ports.github.waitForChecks({
    cwd: ctx.workingDir,
    repo: project.githubRepository,
    prNumber: pr.number,
    timeoutMs: 45 * 60 * 1000,
    pollIntervalMs: 20 * 1000,
    ...(ctx.signal ? { signal: ctx.signal } : {}),
  });

  if (!checks.ok) {
    run = save(ctx, { ...transition(run, 'CI_FAILED', 'Não foi possível obter o status do CI.'), lastError: checks.error });
    return ok(run);
  }

  run = save(ctx, { ...run, checks: checks.value });

  if (!checks.value.allRequiredPassed) {
    run = save(
      ctx,
      transition(run, 'CI_FAILED', 'O CI não aprovou todos os checks obrigatórios.'),
    );
    return ok(run);
  }

  return ok(run);
}

/* ------------------------------------------------------------------------- */
/* Etapa 4 — auditorias finais, consenso, gates e merge                       */
/* ------------------------------------------------------------------------- */

async function auditAndMerge(ctx: Context, input: RunRecord): Promise<Result<RunRecord>> {
  let run = input;
  const { project, config, ports, logger } = ctx;

  if (!project.merge.enabled || project.merge.mode !== 'dual_ai_consensus') {
    run = save(
      ctx,
      transition(run, 'COMPLETED', 'Merge automático desabilitado para este projeto.'),
    );
    return ok(run);
  }

  const pr = run.pullRequest;
  if (!pr) {
    run = save(ctx, transition(run, 'BLOCKED', 'Sem pull request: auditoria final não se aplica.'));
    return ok(run);
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
  run = save(ctx, { ...run, pullRequest: currentPr });

  if (currentPr.headSha !== pr.headSha) {
    run = save(ctx, invalidateMergeApprovals(run, 'O head SHA mudou antes da auditoria.'));
  }

  if (project.pullRequest.markReadyBeforeMerge && currentPr.isDraft) {
    await ports.github.markReadyForReview({
      cwd: ctx.workingDir,
      repo: project.githubRepository,
      prNumber: currentPr.number,
    });
  }

  const commitLog = await ports.git.commitLog(ctx.workingDir, project.baseBranch);
  const diffStat = await ports.git.diffStat(ctx.workingDir, run.baseCommitSha ?? undefined);
  const diffPatch = await ports.git.diffPatch(ctx.workingDir, run.baseCommitSha ?? undefined);

  const auditPackage = buildMergeAuditPackage({
    project,
    run,
    pr: currentPr,
    checks: run.checks,
    finalTests: run.finalTests,
    commitLog: commitLog.ok ? commitLog.value : '',
    diffStat: diffStat.ok ? diffStat.value : '',
    diffPatch: diffPatch.ok ? diffPatch.value : '',
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
    minimumConfidence: project.merge.minimumConfidence,
  };

  /* --- Auditoria independente do Claude ------------------------------- */
  run = save(
    ctx,
    transition(run, 'RUNNING_CLAUDE_MERGE_AUDIT', 'Auditoria final independente do Claude.'),
  );
  const claudeSchema = loadSchema('claude-merge-review.schema.json');
  if (!claudeSchema.ok) return claudeSchema;

  const claudeDir = ensureDir(mergeAuditArtifactDir(project.id, run.runId, 'claude', headSha));
  const claudeAudit = await ports.agents.runClaude({
    role: 'merge-auditor',
    config,
    cwd: ctx.workingDir,
    instruction: `${buildClaudeMergeAuditInstruction({
      ...auditCommon,
      responseSchema: JSON.stringify(claudeSchema.value, null, 2),
    })}\n\n${auditPackage}`,
    timeoutMs: config.agents.claudeTimeoutSeconds * 1000,
    model: project.agents.claudeModel ?? config.agents.defaultClaudeModel,
    artifactDir: claudeDir,
    readOnly: true,
    ...(ctx.signal ? { signal: ctx.signal } : {}),
  });

  const claudeRecord = claudeAudit.ok
    ? toRecord('claude', parseMergeReview(claudeAudit.value.output, claudeSchema.value, headSha), headSha, path.join(claudeDir, 'claude-output.log'))
    : null;
  if (claudeRecord) reviews.push(claudeRecord);
  else logger.warn(`Auditoria do Claude indisponível: ${claudeAudit.ok ? 'JSON inválido' : claudeAudit.error.message}`);

  /* --- Auditoria independente do Codex -------------------------------- */
  run = save(
    ctx,
    transition(run, 'RUNNING_CODEX_MERGE_AUDIT', 'Auditoria final independente do Codex.'),
  );
  const codexSchema = loadSchema('codex-merge-review.schema.json');
  if (!codexSchema.ok) return codexSchema;

  const codexDir = ensureDir(mergeAuditArtifactDir(project.id, run.runId, 'codex', headSha));
  const codexAudit = await ports.agents.runCodex({
    role: 'merge-auditor',
    config,
    cwd: ctx.workingDir,
    instruction: `${buildCodexMergeAuditInstruction({
      ...auditCommon,
      responseSchema: JSON.stringify(codexSchema.value, null, 2),
    })}\n\n${auditPackage}`,
    timeoutMs: config.agents.codexTimeoutSeconds * 1000,
    model: project.agents.codexModel ?? config.agents.defaultCodexModel,
    artifactDir: codexDir,
    readOnly: true,
    ...(ctx.signal ? { signal: ctx.signal } : {}),
  });

  const codexRecord = codexAudit.ok
    ? toRecord('codex', parseMergeReview(codexAudit.value.output, codexSchema.value, headSha), headSha, path.join(codexDir, 'codex-output.log'))
    : null;
  if (codexRecord) reviews.push(codexRecord);
  else logger.warn(`Auditoria do Codex indisponível: ${codexAudit.ok ? 'JSON inválido' : codexAudit.error.message}`);

  run = save(ctx, { ...run, mergeReviews: reviews });

  /* --- Consenso e gates ------------------------------------------------ */
  run = save(ctx, transition(run, 'MERGE_CONSENSUS_PENDING', 'Avaliando consenso e gates.'));

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
  if (latestChecks.ok) run = save(ctx, { ...run, checks: latestChecks.value });

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

  run = save(ctx, { ...run, consensus, gateReport, pullRequest: prForGates });

  if (!consensus.reached || !gateReport.allPassed) {
    const reasons = [
      ...consensus.reasons,
      ...gateReport.failedGates.map((id) => `gate reprovado: ${id}`),
    ];
    logger.warn(`Merge NÃO autorizado. ${reasons.join(' | ')}`);
    run = save(
      ctx,
      transition(run, 'BLOCKED', `Merge não autorizado: ${reasons.slice(0, 5).join(' | ')}`),
    );
    return ok(run);
  }

  /* --- Merge ----------------------------------------------------------- */
  run = save(ctx, transition(run, 'MERGE_APPROVED', 'Todos os gates aprovados; merge autorizado.'));
  run = save(ctx, transition(run, 'MERGING', 'Executando squash merge protegido por SHA.'));

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
    run = save(ctx, {
      ...transition(run, 'BLOCKED', `Merge não executado: ${merged.error.message}`),
      lastError: merged.error,
    });
    return ok(run);
  }

  run = save(ctx, {
    ...transition(run, 'MERGED', 'Pull request mergeada com sucesso.'),
    mergeOutcome: merged.value,
  });
  logger.info(`Merge concluído. SHA: ${merged.value.mergeSha ?? 'desconhecido'}`);
  return ok(run);
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

function save(ctx: Context, run: RunRecord): RunRecord {
  saveRun(run);
  ctx.onUpdate?.(run);
  return run;
}

function checkInterrupt(ctx: Context, run: RunRecord): RunState | null {
  if (run.cancelRequested) return 'CANCELLED';
  if (run.pauseRequested) return 'INTERRUPTED';
  if (ctx.signal?.aborted) return 'INTERRUPTED';
  return null;
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
    CANCELLED: 'cancelado',
  };
  return labels[state];
}

export { compactStamp };
