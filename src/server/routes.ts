import * as http from 'node:http';
import * as path from 'node:path';
import type {
  GlobalConfig,
  Logger,
  PanelHomeData,
  PanelProjectSummary,
  ProjectConfig,
  RunRecord,
} from '../types';
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
import { findActiveRun, listRuns, loadRun, requestCancel, requestPause, saveRun } from '../state/run-state';
import { runDiagnostics } from '../cli/diagnostics';
import { buildDryRunPlan } from '../execution/dry-run';
import { buildRunReport } from '../reports/report-generator';
import { readTextSync } from '../utils/fs-atomic';
import { nowIso } from '../utils/time';
import { startRunInBackground } from './run-manager';
import { openTarget } from './open-target';
import { describeOverrides, grantManualOverride } from '../execution/override';

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
      method: 'GET',
      pattern: /^\/api\/projects\/([^/]+)\/runs\/([^/]+)\/report$/,
      handle: handleReport,
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
   * Os limites do Loop Guard acompanham a execução.
   *
   * O painel mostra "consumido / limite" e precisa do limite REAL do projeto:
   * exibir o padrão do produto quando o projeto configurou outro valor daria
   * um denominador errado, e um número errado na tela é pior que número
   * nenhum. A situação de override vem junto pelo mesmo motivo.
   */
  const project = getProject(projectId);
  const loopGuard = project.ok ? project.value.execution.loopGuard : null;
  const budget = run.currentPromptId
    ? run.budgets.find((entry) => entry.promptId === run.currentPromptId)
    : undefined;

  sendJson(ctx.res, 200, {
    run,
    loopGuard: loopGuard
      ? {
          ...loopGuard,
          maxAttemptsPerPrompt: project.ok
            ? project.value.execution.maxAttemptsPerPrompt
            : null,
        }
      : null,
    override:
      loopGuard && project.ok
        ? describeOverrides(
            run,
            run.currentPromptId ?? run.budgets[0]?.promptId ?? '',
            budget ?? run.budgets[0],
            loopGuard,
          )
        : null,
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

  const project = getProject(projectId);
  if (!project.ok) {
    sendJson(ctx.res, 404, { error: project.error.message });
    return;
  }

  const loaded = loadRun(projectId, runId);
  if (!loaded.ok) {
    sendJson(ctx.res, 404, { error: loaded.error.message });
    return;
  }

  const granted = grantManualOverride({
    run: loaded.value,
    promptId: promptId.value,
    justification: body.value.justification ?? '',
    authorizedBy: body.value.authorizedBy ?? '',
    loopGuard: project.value.execution.loopGuard,
  });

  if (!granted.ok) {
    // 409: o pedido é sintaticamente válido, mas o estado não o permite.
    sendJson(ctx.res, 409, {
      error: granted.error.message,
      details: granted.error.details ?? null,
    });
    return;
  }

  const saved = saveRun(granted.value.run);
  if (!saved.ok) {
    sendJson(ctx.res, 500, { error: saved.error.message });
    return;
  }

  ctx.deps.logger.warn(
    `Override manual autorizado para ${projectId}/${runId}/${promptId.value}: ` +
      `gatilho ${granted.value.override.trigger}, por ${granted.value.override.authorizedBy}.`,
  );
  ctx.deps.events.publishRun(granted.value.run, 'Tentativa adicional autorizada manualmente.');

  sendJson(ctx.res, 201, {
    granted: true,
    override: granted.value.override,
    note:
      'A autorização vale para UMA tentativa e será consumida ao ser usada. ' +
      'Retome a execução para exercê-la.',
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

  const body = await readJsonBody<{ dryRun?: boolean; resumeRunId?: string }>(ctx.req);
  const dryRun = body.ok ? body.value.dryRun === true : false;
  const resumeRunId = body.ok ? body.value.resumeRunId ?? null : null;

  const started = startRunInBackground({
    projectId: id,
    dryRun,
    resumeRunId,
    config: ctx.deps.config,
    logger: ctx.deps.logger,
    events: ctx.deps.events,
  });

  if (!started.ok) {
    sendJson(ctx.res, 409, { error: started.error.message });
    return;
  }
  sendJson(ctx.res, 202, { started: true, dryRun, projectId: id });
}

async function handlePause(ctx: RouteContext): Promise<void> {
  const id = requireId(ctx, 0);
  if (id === null) return;
  const active = findActiveRun(id);
  if (!active.ok || !active.value) {
    sendJson(ctx.res, 404, { error: 'Nenhuma execução ativa para pausar.' });
    return;
  }
  const paused = requestPause(active.value);
  saveRun(paused);
  ctx.deps.events.publishRun(paused, 'Pausa solicitada.');
  sendJson(ctx.res, 200, { paused: true, runId: paused.runId });
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

async function handleCancel(ctx: RouteContext): Promise<void> {
  const id = requireId(ctx, 0);
  if (id === null) return;
  const active = findActiveRun(id);
  if (!active.ok || !active.value) {
    sendJson(ctx.res, 404, { error: 'Nenhuma execução ativa para cancelar.' });
    return;
  }
  const cancelled = requestCancel(active.value);
  saveRun(cancelled);
  ctx.deps.events.publishRun(cancelled, 'Cancelamento solicitado.');
  sendJson(ctx.res, 200, {
    cancelled: true,
    runId: cancelled.runId,
    note: 'Cancelamento seguro: código, branch, worktree, logs e artefatos são preservados.',
  });
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

async function readJsonBody<T>(
  req: http.IncomingMessage,
): Promise<{ ok: true; value: T } | { ok: false; error: { message: string } }> {
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
