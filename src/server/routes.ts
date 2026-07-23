import * as http from 'node:http';
import * as path from 'node:path';
import type {
  GlobalConfig,
  Logger,
  PanelHomeData,
  PanelProjectSummary,
  ProjectConfig,
  Result,
  RunRecord,
} from '../types';
import { ok } from '../utils/errors';
import { sendJson } from './http-server';
import type { EventHub } from './events';
import { detectAllTools } from '../agents/agent-detect';
import { inspectApiEnvironment } from '../security/api-guard';
import { validateIdentifier } from '../security/path-guard';
import {
  createProject,
  getProject,
  listProjects,
  removeProjectRegistration,
  updateProject,
} from '../projects/project-store';
import { normalizeProjectConfig, validateProjectConfig } from '../projects/project-validator';
import { discoverPrompts, readPrompt } from '../prompts/prompt-store';
import {
  findActiveRun,
  latestRun,
  listRuns,
  loadRun,
  recordRunIntent,
  saveRun,
} from '../state/run-state';
import { runDiagnostics } from '../cli/diagnostics';
import { buildDryRunPlan } from '../execution/dry-run';
import { buildRunReport } from '../reports/report-generator';
import { readTextSync } from '../utils/fs-atomic';
import { nowIso } from '../utils/time';
import {
  TERMINATION_CONFIRM_MS,
  cancelRun,
  confirmTermination,
  isRunning,
  liveRunId,
  pauseRun,
  startRunInBackground,
} from './run-manager';
import { openTarget } from './open-target';
import { describeOverrides, grantManualOverride } from '../execution/override';
import type { GrantOverrideOutput } from '../execution/override';
import {
  executionRelevantProjectConfigHash,
  materializeLegacyPolicySnapshot,
  parseRoundPolicyOverrides,
  requireEffectivePolicy,
} from '../execution/effective-policy';
import { withLock } from '../state/locks';
import { readCuratedPackage } from '../packages/package-reader';
import {
  getImportedPackage,
  getImportedRound,
  importCuratedPackage,
} from '../packages/package-store';
import { loadSkillCatalog, skillsRoot } from '../skills/skill-catalog';

/**
 * Roteador da API do painel.
 *
 * Todo identificador vindo da URL passa por `validateIdentifier` antes de
 * compor qualquer caminho. Nenhuma rota devolve segredo, token ou valor de
 * variável de ambiente.
 */

export interface RouterDeps {
  config: GlobalConfig;
  logger: Logger;
  events: EventHub;
}

interface Route {
  method: string;
  pattern: RegExp;
  handle: (ctx: RouteContext) => Promise<void>;
}

interface RouteContext {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  url: URL;
  params: string[];
  deps: RouterDeps;
}

export function createApiRouter(deps: RouterDeps): {
  handle(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void>;
} {
  const routes: Route[] = [
    { method: 'GET', pattern: /^\/api\/home$/, handle: handleHome },
    { method: 'GET', pattern: /^\/api\/diagnostics$/, handle: handleDiagnostics },
    { method: 'GET', pattern: /^\/api\/projects$/, handle: handleListProjects },
    { method: 'POST', pattern: /^\/api\/projects$/, handle: handleCreateProject },
    { method: 'GET', pattern: /^\/api\/projects\/([^/]+)$/, handle: handleGetProject },
    { method: 'PUT', pattern: /^\/api\/projects\/([^/]+)$/, handle: handleUpdateProject },
    { method: 'DELETE', pattern: /^\/api\/projects\/([^/]+)$/, handle: handleDeleteProject },
    { method: 'GET', pattern: /^\/api\/projects\/([^/]+)\/prompts$/, handle: handleListPrompts },
    {
      method: 'GET',
      pattern: /^\/api\/projects\/([^/]+)\/prompts\/([^/]+)$/,
      handle: handleGetPrompt,
    },
    { method: 'GET', pattern: /^\/api\/projects\/([^/]+)\/runs$/, handle: handleListRuns },
    { method: 'GET', pattern: /^\/api\/projects\/([^/]+)\/runs\/([^/]+)$/, handle: handleGetRun },
    {
      method: 'GET',
      pattern: /^\/api\/projects\/([^/]+)\/runs\/([^/]+)\/consensus$/,
      handle: handleConsensus,
    },
    {
      method: 'POST',
      pattern: /^\/api\/projects\/([^/]+)\/runs\/([^/]+)\/audit$/,
      handle: handleTriggerAudit,
    },
    {
      method: 'POST',
      pattern: /^\/api\/projects\/([^/]+)\/runs\/([^/]+)\/override$/,
      handle: handleGrantOverride,
    },
    {
      method: 'POST',
      pattern: /^\/api\/projects\/([^/]+)\/runs\/([^/]+)\/materialize-policy$/,
      handle: handleMaterializePolicy,
    },
    {
      method: 'GET',
      pattern: /^\/api\/projects\/([^/]+)\/runs\/([^/]+)\/report$/,
      handle: handleReport,
    },
    { method: 'GET', pattern: /^\/api\/skills$/, handle: handleListSkills },
    { method: 'GET', pattern: /^\/api\/projects\/([^/]+)\/package$/, handle: handleGetPackage },
    {
      method: 'POST',
      pattern: /^\/api\/projects\/([^/]+)\/package\/import$/,
      handle: handleImportPackage,
    },
    {
      method: 'POST',
      pattern: /^\/api\/projects\/([^/]+)\/package\/preview$/,
      handle: handlePreviewPackage,
    },
    { method: 'GET', pattern: /^\/api\/projects\/([^/]+)\/dry-run$/, handle: handleDryRun },
    { method: 'POST', pattern: /^\/api\/projects\/([^/]+)\/run$/, handle: handleStartRun },
    { method: 'POST', pattern: /^\/api\/projects\/([^/]+)\/pause$/, handle: handlePause },
    { method: 'POST', pattern: /^\/api\/projects\/([^/]+)\/resume$/, handle: handleResume },
    { method: 'POST', pattern: /^\/api\/projects\/([^/]+)\/cancel$/, handle: handleCancel },
    { method: 'POST', pattern: /^\/api\/open$/, handle: handleOpen },
  ];

  return {
    async handle(req, res, url) {
      const pathname = url.pathname;
      const method = (req.method ?? 'GET').toUpperCase();

      for (const route of routes) {
        const match = route.pattern.exec(pathname);
        if (!match) continue;
        if (route.method !== method) continue;

        const params = match.slice(1).map((value) => decodeURIComponent(value));
        try {
          await route.handle({ req, res, url, params, deps });
        } catch (error) {
          deps.logger.error('Erro na rota da API.', {
            pathname,
            message: error instanceof Error ? error.message : String(error),
          });
          if (!res.headersSent) {
            sendJson(res, 500, { error: 'Erro interno ao processar a requisição.' });
          }
        }
        return;
      }

      sendJson(res, 404, { error: `Rota não encontrada: ${method} ${pathname}` });
    },
  };
}

/* ------------------------------------------------------------------------- */
/* Handlers                                                                   */
/* ------------------------------------------------------------------------- */

async function handleHome(ctx: RouteContext): Promise<void> {
  const { config } = ctx.deps;
  const tools = await detectAllTools(config);
  const apiGuard = inspectApiEnvironment({ config });

  const projectsResult = listProjects();
  const projects = projectsResult.ok ? projectsResult.value : [];

  const summaries: PanelProjectSummary[] = [];
  const recentActivity: PanelHomeData['recentActivity'] = [];
  const recentMerges: PanelHomeData['recentMerges'] = [];

  let active = 0;
  let paused = 0;
  let blocked = 0;

  for (const project of projects) {
    const runsResult = listRuns(project.id);
    const runs = runsResult.ok ? runsResult.value : [];
    const activeResult = findActiveRun(project.id);
    const activeRun = activeResult.ok ? activeResult.value : null;
    const latest = runs[0] ?? null;
    const reference = activeRun ?? latest;

    const prompts = discoverPrompts(project.id);
    const promptTotal = prompts.ok ? prompts.value.length : 0;
    const approved = reference
      ? reference.prompts.filter((p) => p.status === 'APPROVED').length
      : 0;

    if (activeRun) {
      if (activeRun.pauseRequested || activeRun.state === 'INTERRUPTED') paused += 1;
      else if (
        activeRun.state === 'BLOCKED' ||
        activeRun.state === 'AUTH_REQUIRED' ||
        activeRun.state === 'USAGE_LIMIT_REACHED' ||
        activeRun.state === 'CI_FAILED'
      ) {
        blocked += 1;
      } else active += 1;
    }

    summaries.push({
      id: project.id,
      name: project.name,
      repositoryPath: project.repositoryPath,
      githubRepository: project.githubRepository,
      baseBranch: project.baseBranch,
      worktreeEnabled: project.worktree.enabled,
      promptTotal,
      promptApproved: approved,
      promptPending: Math.max(0, promptTotal - approved),
      activeRunId: activeRun?.runId ?? null,
      activeState: reference?.state ?? null,
      pullRequestNumber: reference?.pullRequest?.number ?? null,
      pullRequestUrl: reference?.pullRequest?.url ?? null,
      ciStatus: describeCi(reference),
      consensusReached: reference?.consensus?.reached ?? null,
      merged: reference?.mergeOutcome?.merged ?? false,
      lastError: reference?.lastError ? reference.lastError.message : null,
    });

    for (const run of runs.slice(0, 3)) {
      for (const event of run.events.slice(-5)) recentActivity.push(event);
      if (run.mergeOutcome?.merged) {
        recentMerges.push({
          projectId: project.id,
          runId: run.runId,
          prNumber: run.pullRequest?.number ?? null,
          mergeSha: run.mergeOutcome.mergeSha,
          at: run.mergeOutcome.performedAt,
        });
      }
    }
  }

  recentActivity.sort((a, b) => (a.at < b.at ? 1 : -1));

  const payload: PanelHomeData = {
    product: 'OrqPEG',
    version: readVersion(),
    generatedAt: nowIso(),
    tools,
    apiGuard,
    projects: summaries,
    activeRuns: active,
    pausedRuns: paused,
    blockedRuns: blocked,
    recentActivity: recentActivity.slice(0, 25),
    recentMerges: recentMerges.slice(0, 10),
  };

  sendJson(ctx.res, 200, payload);
}

async function handleDiagnostics(ctx: RouteContext): Promise<void> {
  sendJson(ctx.res, 200, await runDiagnostics());
}

async function handleListProjects(ctx: RouteContext): Promise<void> {
  const result = listProjects();
  if (!result.ok) {
    sendJson(ctx.res, 500, { error: result.error.message });
    return;
  }
  sendJson(ctx.res, 200, { projects: result.value });
}

async function handleCreateProject(ctx: RouteContext): Promise<void> {
  const body = await readJsonBody<Partial<ProjectConfig>>(ctx.req);
  if (!body.ok) {
    sendJson(ctx.res, 400, { error: body.error.message });
    return;
  }
  const draft = body.value;
  if (!draft.id || !draft.name || !draft.repositoryPath || !draft.githubRepository) {
    sendJson(ctx.res, 400, {
      error: 'Campos obrigatórios: id, name, repositoryPath, githubRepository.',
    });
    return;
  }

  const normalized = normalizeProjectConfig({
    ...draft,
    id: draft.id,
    name: draft.name,
    repositoryPath: draft.repositoryPath,
    githubRepository: draft.githubRepository,
  });

  const validated = validateProjectConfig(normalized);
  if (!validated.ok) {
    sendJson(ctx.res, 400, { error: validated.error.message, details: validated.error.details });
    return;
  }

  const created = createProject(validated.value);
  if (!created.ok) {
    sendJson(ctx.res, 400, { error: created.error.message });
    return;
  }
  sendJson(ctx.res, 201, { project: created.value });
}

async function handleGetProject(ctx: RouteContext): Promise<void> {
  const id = requireId(ctx, 0);
  if (id === null) return;

  const project = getProject(id);
  if (!project.ok) {
    sendJson(ctx.res, 404, { error: project.error.message });
    return;
  }
  const prompts = discoverPrompts(id);
  const runs = listRuns(id);

  sendJson(ctx.res, 200, {
    project: project.value,
    prompts: prompts.ok ? prompts.value : [],
    runs: runs.ok ? runs.value : [],
  });
}

async function handleUpdateProject(ctx: RouteContext): Promise<void> {
  const id = requireId(ctx, 0);
  if (id === null) return;

  const body = await readJsonBody<Partial<ProjectConfig>>(ctx.req);
  if (!body.ok) {
    sendJson(ctx.res, 400, { error: body.error.message });
    return;
  }
  const updated = updateProject(id, body.value);
  if (!updated.ok) {
    sendJson(ctx.res, 400, { error: updated.error.message });
    return;
  }
  sendJson(ctx.res, 200, { project: updated.value });
}

async function handleDeleteProject(ctx: RouteContext): Promise<void> {
  const id = requireId(ctx, 0);
  if (id === null) return;

  const removed = removeProjectRegistration(id);
  if (!removed.ok) {
    sendJson(ctx.res, 400, { error: removed.error.message });
    return;
  }
  sendJson(ctx.res, 200, {
    removed: true,
    note: 'Apenas o cadastro foi removido. O repositório real do projeto não foi tocado.',
  });
}

async function handleListPrompts(ctx: RouteContext): Promise<void> {
  const id = requireId(ctx, 0);
  if (id === null) return;
  const prompts = discoverPrompts(id);
  if (!prompts.ok) {
    sendJson(ctx.res, 404, { error: prompts.error.message });
    return;
  }
  sendJson(ctx.res, 200, { prompts: prompts.value });
}

async function handleGetPrompt(ctx: RouteContext): Promise<void> {
  const id = requireId(ctx, 0);
  const promptId = requireId(ctx, 1);
  if (id === null || promptId === null) return;

  const prompts = discoverPrompts(id);
  if (!prompts.ok) {
    sendJson(ctx.res, 404, { error: prompts.error.message });
    return;
  }
  const found = prompts.value.find((p) => p.id === promptId);
  if (!found) {
    sendJson(ctx.res, 404, { error: `Prompt não encontrado: ${promptId}` });
    return;
  }
  const parsed = readPrompt(found);
  const raw = readTextSync(found.absolutePath);
  sendJson(ctx.res, 200, {
    prompt: parsed.ok ? parsed.value : null,
    raw: raw.ok ? raw.value : '',
    file: found,
  });
}

async function handleListRuns(ctx: RouteContext): Promise<void> {
  const id = requireId(ctx, 0);
  if (id === null) return;
  const runs = listRuns(id);
  if (!runs.ok) {
    sendJson(ctx.res, 404, { error: runs.error.message });
    return;
  }
  sendJson(ctx.res, 200, { runs: runs.value });
}

async function handleGetRun(ctx: RouteContext): Promise<void> {
  const projectId = requireId(ctx, 0);
  if (projectId === null) return;
  const run = loadRunFromParams(ctx);
  if (!run) return;

  /*
   * Os limites vêm da POLÍTICA CONGELADA da execução, nunca do cadastro atual.
   *
   * O painel mostra "consumido / limite". Os numeradores são históricos — saem
   * de `run.budgets` — então um denominador lido do projeto de hoje produz
   * pares incoerentes: uma execução que rodou com teto 3 aparecia como "3 / 5"
   * depois de alguém editar o projeto. Número errado na tela é pior que número
   * nenhum, e é por isso que a ausência de snapshot vira uma declaração
   * explícita em vez de um denominador inventado.
   */
  const policy = requireEffectivePolicy(run);
  const budget = run.currentPromptId
    ? run.budgets.find((entry) => entry.promptId === run.currentPromptId)
    : undefined;

  if (!policy.ok) {
    sendJson(ctx.res, 200, {
      run,
      loopGuard: null,
      override: null,
      policyUnavailable: {
        code: policy.error.code,
        title: 'POLÍTICA HISTÓRICA NÃO DISPONÍVEL',
        message: 'Execução criada antes do snapshot de política.',
        detail: policy.error.message,
      },
    });
    return;
  }

  /*
   * Divergência entre o cadastro de hoje e o snapshot é informação para o
   * operador, não motivo para trocar os limites exibidos. O painel avisa que a
   * configuração mudou; os números continuam sendo os da execução.
   */
  const project = getProject(projectId);
  const currentHash = project.ok
    ? executionRelevantProjectConfigHash(project.value)
    : null;
  const drifted =
    currentHash !== null && currentHash !== policy.value.sources.projectConfigHash;

  sendJson(ctx.res, 200, {
    run,
    loopGuard: policy.value.loopGuard,
    policy: {
      capturedAt: policy.value.capturedAt,
      effectiveHash: policy.value.effectiveHash,
      sources: policy.value.sources,
      materializedFromLegacyRun:
        policy.value.sourceMetadata.materializedFromLegacyRun === true,
    },
    projectConfigDrift: drifted
      ? {
          changed: true,
          message:
            'O cadastro do projeto mudou desde o início desta execução. Os limites exibidos são os que a execução realmente usou; a configuração nova só vale para execuções novas.',
        }
      : { changed: false },
    override: describeOverrides(
      run,
      run.currentPromptId ?? run.budgets[0]?.promptId ?? '',
      budget ?? run.budgets[0],
      policy.value.loopGuard,
    ),
  });
}

async function handleConsensus(ctx: RouteContext): Promise<void> {
  const run = loadRunFromParams(ctx);
  if (!run) return;
  sendJson(ctx.res, 200, {
    consensus: run.consensus,
    gateReport: run.gateReport,
    reviews: run.mergeReviews,
    pullRequest: run.pullRequest,
    checks: run.checks,
    finalTests: run.finalTests,
    mergeOutcome: run.mergeOutcome,
  });
}

/**
 * Dispara as auditorias finais de merge para uma execução já publicada.
 *
 * O painel oferece este botão quando a PR existe e o CI terminou. A execução
 * roda em segundo plano e o resultado chega pelo barramento SSE; a resposta é
 * 202 justamente porque as duas auditorias levam minutos.
 */
async function handleTriggerAudit(ctx: RouteContext): Promise<void> {
  const projectId = requireId(ctx, 0);
  if (projectId === null) return;
  const runId = requireId(ctx, 1);
  if (runId === null) return;

  const loaded = loadRun(projectId, runId);
  if (!loaded.ok) {
    sendJson(ctx.res, 404, { error: loaded.error.message });
    return;
  }
  const run = loaded.value;

  if (!run.pullRequest) {
    sendJson(ctx.res, 409, {
      error:
        'Esta execução ainda não possui pull request. As auditorias finais só fazem sentido sobre uma PR publicada.',
    });
    return;
  }

  const started = startRunInBackground({
    projectId,
    dryRun: false,
    resumeRunId: runId,
    config: ctx.deps.config,
    logger: ctx.deps.logger,
    events: ctx.deps.events,
  });
  if (!started.ok) {
    sendJson(ctx.res, 409, { error: started.error.message });
    return;
  }

  ctx.deps.events.publishRun(run, 'Auditorias finais solicitadas pelo painel.');
  sendJson(ctx.res, 202, {
    started: true,
    runId,
    headSha: run.pullRequest.headSha,
    note: 'As duas auditorias independentes foram disparadas. O merge só ocorre se os 20 gates passarem.',
  });
}

/**
 * Executa uma mutação de execução sob lock, entregando o registro JÁ RELIDO.
 *
 * A ordem correta é adquirir o lock, RECARREGAR do disco, revalidar e só então
 * gravar. Como convenção isso é frágil: um `loadRun` colocado antes do lock
 * continua compilando, continua parecendo certo na revisão, e a suíte não
 * consegue flagrá-lo — com lock que falha rápido, o rival sempre segura o lock
 * durante a tentativa, o handler nem entra no callback, e ler-antes e
 * reler-depois se tornam indistinguíveis de fora.
 *
 * Por isso a garantia é estrutural em vez de convencional: o callback não
 * captura registro nenhum, ele RECEBE o que foi lido dentro do lock. Reintroduzir
 * uma leitura obsoleta exige adicionar um `loadRun` que o callback não usa — não
 * acontece por descuido.
 */
async function withRunLocked<T>(
  input: { projectId: string; runId: string; operation: string },
  fn: (run: RunRecord) => Promise<Result<T>>,
): Promise<Result<Result<T>>> {
  return withLock(
    {
      scope: 'run',
      key: input.runId,
      projectId: input.projectId,
      runId: input.runId,
      operation: input.operation,
    },
    async (): Promise<Result<T>> => {
      const current = loadRun(input.projectId, input.runId);
      if (!current.ok) return current;
      return fn(current.value);
    },
  );
}

/**
 * Autoriza uma única tentativa adicional após uma parada branda.
 *
 * A validação inteira vive no backend de propósito. A interface esconde o botão
 * quando o gatilho não admite override, mas esconder não é impedir: uma
 * requisição forjada para `FORBIDDEN_AREA_CHANGED` precisa falhar aqui, com
 * motivo explícito, e falha.
 */
async function handleGrantOverride(ctx: RouteContext): Promise<void> {
  const projectId = requireId(ctx, 0);
  if (projectId === null) return;
  const runId = requireId(ctx, 1);
  if (runId === null) return;

  const body = await readJsonBody<{ promptId?: string; justification?: string; authorizedBy?: string }>(
    ctx.req,
  );
  if (!body.ok) {
    sendJson(ctx.res, 400, { error: body.error.message });
    return;
  }

  const promptIdRaw = (body.value.promptId ?? '').trim();
  const promptId = validateIdentifier(promptIdRaw, 'prompt');
  if (!promptId.ok) {
    sendJson(ctx.res, 400, { error: promptId.error.message });
    return;
  }

  /* O projeto é carregado para provar identidade e existência. Nenhum limite
     sai daqui: os limites vêm da política congelada no `RunRecord`. */
  const project = getProject(projectId);
  if (!project.ok) {
    sendJson(ctx.res, 404, { error: project.error.message });
    return;
  }

  /*
   * Concessão sob lock persistente. O `RunRecord` chega como PARÂMETRO, lido
   * por `withRunLocked` já dentro do lock.
   *
   * A serialização do event loop do Node já impedia duas concessões dentro de
   * um mesmo processo, mas isso era acidente e não desenho: bastava um `await`
   * novo neste handler para reabrir a janela, e entre processos distintos
   * (painel e CLI) o resultado era last-write-wins — uma autorização que
   * respondeu 201 desaparecia do arquivo.
   */
  const outcome = await withRunLocked(
    { projectId, runId, operation: 'manual-override' },
    async (current): Promise<Result<GrantOverrideOutput>> => {
      const policy = requireEffectivePolicy(current);
      if (!policy.ok) return policy;

      const granted = grantManualOverride({
        run: current,
        promptId: promptId.value,
        justification: body.value.justification ?? '',
        authorizedBy: body.value.authorizedBy ?? '',
        policy: policy.value.loopGuard,
      });
      if (!granted.ok) return granted;

      const saved = saveRun(granted.value.run);
      if (!saved.ok) return saved;
      return ok(granted.value);
    },
  );

  if (!outcome.ok) {
    sendJson(ctx.res, outcome.error.code === 'LOCK_HELD' ? 423 : 500, {
      error: outcome.error.message,
      details: outcome.error.details ?? null,
    });
    return;
  }
  if (!outcome.value.ok) {
    const error = outcome.value.error;
    const status =
      error.code === 'CONFIG_NOT_FOUND'
        ? 404
        : error.code === 'POLICY_SNAPSHOT_MISSING'
          ? 409
          : error.code === 'VALIDATION_FAILED'
            ? 409
            : 500;
    sendJson(ctx.res, status, { error: error.message, details: error.details ?? null });
    return;
  }

  const result = outcome.value.value;
  ctx.deps.logger.warn(
    `Override manual autorizado para ${projectId}/${runId}/${promptId.value}: ` +
      `gatilho ${result.override.trigger}, por ${result.override.authorizedBy}.`,
  );
  ctx.deps.events.publishRun(result.run, 'Tentativa adicional autorizada manualmente.');

  sendJson(ctx.res, 201, {
    granted: true,
    override: result.override,
    note:
      'A autorização vale para UMA tentativa e será consumida ao ser usada. ' +
      'Retome a execução para exercê-la.',
  });
}

/**
 * Materializa uma política para uma execução criada antes do congelamento.
 *
 * Não é reconstrução histórica, e a resposta diz isso explicitamente: a
 * política original daquela execução se perdeu, e o que se congela aqui é o
 * cadastro de hoje. Existe para que trabalho preservado não fique inacessível
 * para sempre — exige confirmação escrita justamente porque o resultado é uma
 * aproximação declarada, não um registro recuperado.
 */
async function handleMaterializePolicy(ctx: RouteContext): Promise<void> {
  const projectId = requireId(ctx, 0);
  if (projectId === null) return;
  const runId = requireId(ctx, 1);
  if (runId === null) return;

  const body = await readJsonBody<{ confirm?: boolean; confirmedBy?: string }>(ctx.req);
  if (!body.ok) {
    sendJson(ctx.res, 400, { error: body.error.message });
    return;
  }
  if (body.value.confirm !== true) {
    sendJson(ctx.res, 400, {
      error:
        'É preciso confirmar explicitamente (confirm: true). O snapshot materializado é o cadastro de hoje, não a política sob a qual esta execução realmente rodou.',
    });
    return;
  }

  const project = getProject(projectId);
  if (!project.ok) {
    sendJson(ctx.res, 404, { error: project.error.message });
    return;
  }

  const outcome = await withRunLocked(
    { projectId, runId, operation: 'materialize-policy' },
    async (current): Promise<Result<RunRecord>> => {
      const materialized = materializeLegacyPolicySnapshot({
        run: current,
        globalConfig: ctx.deps.config,
        projectConfig: project.value,
        confirmedBy: body.value.confirmedBy ?? '',
      });
      if (!materialized.ok) return materialized;

      const updated: RunRecord = {
        ...current,
        effectivePolicy: materialized.value,
        sourceSnapshots: current.sourceSnapshots ?? {
          promptHashes: {},
          promptSetHash: '',
          /* Herda os hashes antigos quando existirem; ausência vira string
             vazia, que desliga a comparação em vez de inventar divergência. */
          projectContextHash: current.projectContextHash ?? '',
          projectConfigHash:
            current.projectConfigHash ?? materialized.value.sources.projectConfigHash,
          /* Execução legada não declarou rodada; o hash acompanha a política
             materializada em vez de repetir `null` numa segunda fonte. */
          roundConfigHash: materialized.value.sources.roundConfigHash,
        },
      };
      const saved = saveRun(updated);
      if (!saved.ok) return saved;
      return ok(updated);
    },
  );

  if (!outcome.ok) {
    sendJson(ctx.res, outcome.error.code === 'LOCK_HELD' ? 423 : 500, {
      error: outcome.error.message,
    });
    return;
  }
  if (!outcome.value.ok) {
    sendJson(ctx.res, outcome.value.error.code === 'CONFIG_NOT_FOUND' ? 404 : 409, {
      error: outcome.value.error.message,
    });
    return;
  }

  ctx.deps.logger.warn(
    `Política legada materializada para ${projectId}/${runId} por ` +
      `${outcome.value.value.effectivePolicy?.sourceMetadata.materializedBy ?? 'operador local'}.`,
  );
  ctx.deps.events.publishRun(outcome.value.value, 'Política legada materializada.');

  sendJson(ctx.res, 200, {
    materialized: true,
    warning:
      'Snapshot capturado APÓS o início da execução. Não representa necessariamente a política original desta execução.',
    policy: outcome.value.value.effectivePolicy,
  });
}

/**
 * Catálogo local de Skills.
 *
 * Devolve também os problemas: uma Skill malformada precisa aparecer como
 * defeito nomeado, senão a rodada falharia depois com "Skill ausente" e a
 * pessoa procuraria no lugar errado.
 */
async function handleListSkills(ctx: RouteContext): Promise<void> {
  const catalog = loadSkillCatalog();
  sendJson(ctx.res, 200, {
    root: skillsRoot(),
    skills: catalog.skills.map((skill) => ({
      id: skill.manifest.id,
      name: skill.manifest.name,
      version: skill.manifest.version,
      description: skill.manifest.description,
      status: skill.manifest.status,
      compatibleAgents: skill.manifest.compatibleAgents,
      roles: skill.manifest.roles,
      category: skill.category,
      contentHash: skill.contentHash,
    })),
    problems: catalog.problems,
  });
}

/** Pacote importado no projeto, com as rodadas e o que cada uma declara. */
async function handleGetPackage(ctx: RouteContext): Promise<void> {
  const projectId = requireId(ctx, 0);
  if (projectId === null) return;

  const record = getImportedPackage(projectId);
  if (!record.ok) {
    sendJson(ctx.res, 500, { error: record.error.message });
    return;
  }
  if (!record.value) {
    sendJson(ctx.res, 200, { imported: false, package: null, rounds: [] });
    return;
  }

  const rounds = record.value.roundIds
    .map((id) => getImportedRound(projectId, id))
    .filter((result) => result.ok)
    .map((result) => (result as { value: unknown }).value);

  sendJson(ctx.res, 200, { imported: true, package: record.value, rounds });
}

/**
 * Valida um pacote SEM importar.
 *
 * Existe para que o operador veja os problemas antes de mexer no projeto: a
 * importação é uma decisão, e decidir sem ver a lista de erros é decidir no
 * escuro.
 */
async function handlePreviewPackage(ctx: RouteContext): Promise<void> {
  const projectId = requireId(ctx, 0);
  if (projectId === null) return;

  const body = await readJsonBody<{ sourcePath?: string }>(ctx.req);
  if (!body.ok) {
    sendJson(ctx.res, 400, { error: body.error.message });
    return;
  }

  const parsed = readCuratedPackage((body.value.sourcePath ?? '').trim());
  if (!parsed.ok) {
    sendJson(ctx.res, 422, {
      valid: false,
      error: parsed.error.message,
      problems: parsed.error.details?.['problems'] ?? [],
    });
    return;
  }

  sendJson(ctx.res, 200, {
    valid: true,
    plan: parsed.value.plan,
    rounds: parsed.value.rounds,
    packageHash: parsed.value.packageHash,
  });
}

async function handleImportPackage(ctx: RouteContext): Promise<void> {
  const projectId = requireId(ctx, 0);
  if (projectId === null) return;

  const body = await readJsonBody<{
    sourcePath?: string;
    version?: string;
    replaceExisting?: boolean;
  }>(ctx.req);
  if (!body.ok) {
    sendJson(ctx.res, 400, { error: body.error.message });
    return;
  }

  const imported = importCuratedPackage({
    projectId,
    sourcePath: (body.value.sourcePath ?? '').trim(),
    version: (body.value.version ?? '').trim(),
    ...(body.value.replaceExisting === true ? { replaceExisting: true } : {}),
  });

  if (!imported.ok) {
    /* 422 quando o pacote é inválido: o pedido está bem formado, o conteúdo
       apontado é que não serve. */
    const status = imported.error.code === 'VALIDATION_FAILED' ? 422 : 400;
    sendJson(ctx.res, status, {
      error: imported.error.message,
      problems: imported.error.details?.['problems'] ?? [],
    });
    return;
  }

  ctx.deps.logger.info(
    `Pacote "${imported.value.record.packageId}" versão ${imported.value.record.version} importado em ${projectId}.`,
  );
  sendJson(ctx.res, 201, {
    imported: true,
    package: imported.value.record,
    rounds: imported.value.package.rounds,
  });
}

async function handleReport(ctx: RouteContext): Promise<void> {
  const id = requireId(ctx, 0);
  if (id === null) return;
  const run = loadRunFromParams(ctx);
  if (!run) return;

  const project = getProject(id);
  if (!project.ok) {
    sendJson(ctx.res, 404, { error: project.error.message });
    return;
  }

  const format = (ctx.url.searchParams.get('format') ?? 'html').toLowerCase();
  const bundle = buildRunReport({ project: project.value, run });

  if (format === 'json') {
    ctx.res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    ctx.res.end(bundle.json);
    return;
  }
  if (format === 'md' || format === 'markdown') {
    ctx.res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8' });
    ctx.res.end(bundle.markdown);
    return;
  }
  ctx.res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  ctx.res.end(bundle.html);
}

async function handleDryRun(ctx: RouteContext): Promise<void> {
  const id = requireId(ctx, 0);
  if (id === null) return;
  const plan = buildDryRunPlan(id, ctx.deps.config);
  if (!plan.ok) {
    sendJson(ctx.res, 400, { error: plan.error.message });
    return;
  }
  sendJson(ctx.res, 200, { plan: plan.value });
}

async function handleStartRun(ctx: RouteContext): Promise<void> {
  const id = requireId(ctx, 0);
  if (id === null) return;

  const body = await readJsonBody<{
    dryRun?: boolean;
    resumeRunId?: string;
    roundConfig?: unknown;
  }>(ctx.req);
  if (!body.ok) {
    sendJson(ctx.res, 400, { error: body.error.message });
    return;
  }
  const dryRun = body.value.dryRun === true;
  const resumeRunId = body.value.resumeRunId ?? null;

  const roundConfig = parseRoundPolicyOverrides(body.value.roundConfig);
  if (!roundConfig.ok) {
    sendJson(ctx.res, 400, { error: roundConfig.error.message, details: roundConfig.error.details });
    return;
  }
  /* Retomada usa a política congelada da execução original. Aceitar uma rodada
     aqui prometeria um efeito que não acontece; recusar diz onde está o
     conflito em vez de deixar o operador descobrir pelo relatório. */
  if (roundConfig.value !== null && resumeRunId !== null) {
    sendJson(ctx.res, 409, {
      error:
        'Não é possível declarar "roundConfig" ao retomar: a execução retomada roda sob a política congelada quando ela começou. Inicie uma nova execução para aplicar outra rodada.',
    });
    return;
  }

  const started = startRunInBackground({
    projectId: id,
    dryRun,
    resumeRunId,
    roundConfig: roundConfig.value,
    config: ctx.deps.config,
    logger: ctx.deps.logger,
    events: ctx.deps.events,
  });

  if (!started.ok) {
    sendJson(ctx.res, 409, { error: started.error.message });
    return;
  }
  sendJson(ctx.res, 202, {
    started: true,
    dryRun,
    projectId: id,
    roundId: roundConfig.value?.roundId ?? null,
  });
}

/**
 * Aplica pausa ou cancelamento, dizendo exatamente o que aconteceu.
 *
 * Três defeitos que esta função existe para não repetir:
 *
 *  1. **Janela antes do `RunRecord`.** O controlador vivo é publicado antes de
 *     qualquer `await`, mas o registro em disco só existe depois da validação.
 *     Procurar o registro PRIMEIRO devolvia `404` para um pedido que tinha
 *     quem atender. Agora o controlador é consultado antes, e a intenção
 *     aceita nesse intervalo é honrada e persistida pelo próprio orquestrador
 *     assim que o registro nasce.
 *  2. **Sucesso falso na falha de escrita.** O `Result` de `saveRun` era
 *     descartado. Agora uma falha de persistência é `500` e nada é
 *     interrompido: uma intenção que não chega ao disco não sobrevive à
 *     retomada.
 *  3. **"Processo interrompido" no instante do `abort()`.** `abort()` envia o
 *     sinal; a árvore leva um tempo real para morrer. A resposta só afirma
 *     encerramento depois de confirmá-lo, e distingue os estados intermediários.
 */
async function applyRunIntent(
  ctx: RouteContext,
  projectId: string,
  intent: 'PAUSE' | 'CANCEL',
): Promise<void> {
  const verb = intent === 'PAUSE' ? 'pausa' : 'cancelamento';
  const doneKey = intent === 'PAUSE' ? 'paused' : 'cancelled';

  /* O controlador é consultado ANTES do registro: ele existe primeiro. */
  const liveId = liveRunId(projectId);
  const active = findActiveRun(projectId);
  const activeRun = active.ok ? active.value : null;

  if (activeRun === null && liveId === null && !isRunning(projectId)) {
    if (intent === 'CANCEL') {
      const previous = latestRun(projectId);
      const last = previous.ok ? previous.value : null;
      if (last && (last.state === 'CANCELLED' || last.cancelRequested)) {
        sendJson(ctx.res, 200, {
          cancelled: true,
          accepted: false,
          alreadyCancelled: true,
          runId: last.runId,
          state: last.state,
          intentPersisted: true,
          terminated: true,
          note: 'A execução já estava cancelada. Nada foi alterado.',
        });
        return;
      }
    }
    sendJson(ctx.res, 404, { error: `Nenhuma execução ativa para ${verb}.` });
    return;
  }

  /*
   * Persistir a intenção vem primeiro, e por um caminho SERIALIZADO:
   * `recordRunIntent` relê o registro e grava dentro do mesmo lock de estado.
   * Ler aqui e gravar depois reabriria a corrida com o orquestrador.
   */
  const targetRunId = activeRun?.runId ?? liveId;
  let intentPersisted = false;
  let persistedRunId: string | null = null;

  if (targetRunId !== null) {
    const recorded = recordRunIntent(projectId, targetRunId, intent);
    if (recorded.ok) {
      intentPersisted = true;
      persistedRunId = recorded.value.runId;
      ctx.deps.events.publishRun(recorded.value, `${capitalize(verb)} solicitada.`);
    } else if (recorded.error.code === 'CONFIG_NOT_FOUND') {
      /* O registro ainda não existe no disco — a execução acabou de nascer. O
         controlador vivo abaixo atende, e o orquestrador persiste a intenção
         ao criar o registro. Não é falha de escrita. */
      intentPersisted = false;
    } else {
      sendJson(ctx.res, 500, {
        [doneKey]: false,
        error: `A ${verb} NÃO foi registrada: ${recorded.error.message}`,
        code: recorded.error.code,
        intentPersisted: false,
      });
      return;
    }
  }

  const accepted = intent === 'PAUSE' ? pauseRun(projectId) : cancelRun(projectId);

  if (accepted === null) {
    /* Sem controlador vivo aqui: a intenção está no disco e a execução, em
       outro processo, vai lê-la. Não há como afirmar encerramento daqui. */
    sendJson(ctx.res, 202, {
      [doneKey]: true,
      accepted: false,
      intentPersisted,
      terminated: false,
      runId: persistedRunId ?? targetRunId,
      note:
        `Intenção de ${verb} registrada. Nenhuma execução viva neste processo do painel: ` +
        'se a rodada estiver na CLI, ela lerá a intenção e interromperá a etapa em curso.',
    });
    return;
  }

  /* O sinal foi enviado. Agora confirmamos — com teto — se a árvore de fato
     morreu, em vez de afirmar que sim. */
  const termination = await confirmTermination(projectId);
  const runId = persistedRunId ?? accepted.runId ?? targetRunId;

  if (termination === 'PENDING') {
    sendJson(ctx.res, 202, {
      [doneKey]: true,
      accepted: true,
      intentPersisted,
      terminated: false,
      runId,
      step: accepted.step,
      alreadyRequested: accepted.alreadyRequested,
      note:
        `Pedido de ${verb} aceito e sinal enviado. O encerramento da árvore de processos ainda ` +
        `está em andamento após ${String(TERMINATION_CONFIRM_MS)} ms; consulte o estado da execução.`,
    });
    return;
  }

  sendJson(ctx.res, 200, {
    [doneKey]: true,
    accepted: true,
    intentPersisted,
    terminated: true,
    runId,
    step: accepted.step,
    alreadyRequested: accepted.alreadyRequested,
    note:
      'Árvore de processos da etapa em curso encerrada e estado gravado. ' +
      'Código, branch, worktree e artefatos preservados.',
  });
}

function capitalize(value: string): string {
  return value.length === 0 ? value : `${value[0]?.toUpperCase() ?? ''}${value.slice(1)}`;
}

async function handlePause(ctx: RouteContext): Promise<void> {
  const id = requireId(ctx, 0);
  if (id === null) return;
  await applyRunIntent(ctx, id, 'PAUSE');
}

async function handleResume(ctx: RouteContext): Promise<void> {
  const id = requireId(ctx, 0);
  if (id === null) return;
  const runs = listRuns(id);
  if (!runs.ok) {
    sendJson(ctx.res, 404, { error: runs.error.message });
    return;
  }
  const resumable = runs.value.find(
    (run) =>
      run.state === 'INTERRUPTED' ||
      run.state === 'BLOCKED' ||
      run.state === 'CI_FAILED' ||
      run.state === 'AUTH_REQUIRED' ||
      run.state === 'USAGE_LIMIT_REACHED' ||
      run.state === 'LOOP_GUARD_TRIGGERED',
  );
  if (!resumable) {
    sendJson(ctx.res, 404, { error: 'Nenhuma execução retomável encontrada.' });
    return;
  }

  const started = startRunInBackground({
    projectId: id,
    dryRun: false,
    resumeRunId: resumable.runId,
    config: ctx.deps.config,
    logger: ctx.deps.logger,
    events: ctx.deps.events,
  });
  if (!started.ok) {
    sendJson(ctx.res, 409, { error: started.error.message });
    return;
  }
  sendJson(ctx.res, 202, { resumed: true, runId: resumable.runId });
}

/**
 * Cancelamento: idempotente por contrato.
 *
 * Cancelar duas vezes precisa responder sucesso nas duas. Como a primeira
 * chamada leva a execução a um estado TERMINAL, a segunda não encontraria mais
 * "execução ativa" e a rota respondia 404 — o operador leria "não havia nada
 * para cancelar" logo depois de cancelar. A execução mais recente é consultada
 * justamente para distinguir "nunca houve" de "já foi cancelada".
 */
async function handleCancel(ctx: RouteContext): Promise<void> {
  const id = requireId(ctx, 0);
  if (id === null) return;
  await applyRunIntent(ctx, id, 'CANCEL');
}

async function handleOpen(ctx: RouteContext): Promise<void> {
  const body = await readJsonBody<{
    target: string;
    projectId: string;
    runId?: string;
  }>(ctx.req);
  if (!body.ok) {
    sendJson(ctx.res, 400, { error: body.error.message });
    return;
  }
  const opened = await openTarget(body.value);
  if (!opened.ok) {
    sendJson(ctx.res, 400, { error: opened.error.message });
    return;
  }
  sendJson(ctx.res, 200, { opened: true });
}

/* ------------------------------------------------------------------------- */
/* Auxiliares                                                                 */
/* ------------------------------------------------------------------------- */

function requireId(ctx: RouteContext, index: number): string | null {
  const raw = ctx.params[index];
  if (raw === undefined) {
    sendJson(ctx.res, 400, { error: 'Identificador ausente na URL.' });
    return null;
  }
  const validated = validateIdentifier(raw, 'identificador');
  if (!validated.ok) {
    sendJson(ctx.res, 400, { error: validated.error.message });
    return null;
  }
  return validated.value;
}

function loadRunFromParams(ctx: RouteContext): RunRecord | null {
  const projectId = requireId(ctx, 0);
  if (projectId === null) return null;
  const runId = requireId(ctx, 1);
  if (runId === null) return null;

  const run = loadRun(projectId, runId);
  if (!run.ok) {
    sendJson(ctx.res, 404, { error: run.error.message });
    return null;
  }
  return run.value;
}

function describeCi(run: RunRecord | null): string | null {
  if (!run?.checks) return null;
  const checks = run.checks;
  if (checks.anyRequiredFailed) return 'falha';
  if (checks.anyRequiredPending) return 'pendente';
  if (checks.allRequiredPassed) return 'aprovado';
  return 'indefinido';
}

const MAX_BODY_BYTES = 2 * 1024 * 1024;

/**
 * Corpo presente exige `Content-Type: application/json`.
 *
 * É a terceira barreira contra CSRF, e a que fecha a forma sem preflight:
 * `text/plain`, `application/x-www-form-urlencoded` e `multipart/form-data`
 * fazem da requisição uma "simple request", que o navegador entrega direto e
 * sem perguntar. Com JSON exigido sobra o preflight, que falha porque o painel
 * não responde CORS nenhum.
 *
 * Corpo ausente continua válido: várias rotas (`/pause`, `/cancel`) não têm o
 * que receber, e exigir cabeçalho de tipo para um corpo que não existe
 * recusaria chamada legítima sem fechar nenhuma porta.
 */
function bodyContentTypeIsAcceptable(req: http.IncomingMessage): boolean {
  const declared = (req.headers['content-length'] ?? '').toString().trim();
  const hasBody = req.headers['transfer-encoding'] !== undefined || (declared !== '' && declared !== '0');
  if (!hasBody) return true;

  const contentType = (req.headers['content-type'] ?? '').toString().toLowerCase();
  return contentType.split(';')[0]?.trim() === 'application/json';
}

async function readJsonBody<T>(
  req: http.IncomingMessage,
): Promise<{ ok: true; value: T } | { ok: false; error: { message: string } }> {
  if (!bodyContentTypeIsAcceptable(req)) {
    req.resume();
    return {
      ok: false,
      error: { message: 'Corpo da requisição exige Content-Type: application/json.' },
    };
  }

  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;

    req.on('data', (chunk: Buffer) => {
      if (settled) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        settled = true;
        resolve({ ok: false, error: { message: 'Corpo da requisição excede 2 MB.' } });
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      if (settled) return;
      settled = true;
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (raw.length === 0) {
        resolve({ ok: true, value: {} as T });
        return;
      }
      try {
        resolve({ ok: true, value: JSON.parse(raw) as T });
      } catch {
        resolve({ ok: false, error: { message: 'Corpo da requisição não é JSON válido.' } });
      }
    });

    req.on('error', () => {
      if (settled) return;
      settled = true;
      resolve({ ok: false, error: { message: 'Falha ao ler o corpo da requisição.' } });
    });
  });
}

function readVersion(): string {
  const file = readTextSync(path.join(__dirname, '..', '..', 'VERSION'));
  return file.ok ? file.value.trim() : '1.0.0';
}
