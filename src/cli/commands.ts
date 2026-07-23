import * as path from 'node:path';
import * as readline from 'node:readline';
import type { GlobalConfig, ProjectConfig, RunRecord } from '../types';
import { createLogger } from '../utils/logger';
import { ensureDataLayout, ORQPEG_DIRS, orqpegRoot } from '../utils/paths';
import { formatError } from '../utils/errors';
import { ensureGlobalConfig } from '../config/global-config';
import { inspectApiEnvironment, describeApiGuard } from '../security/api-guard';
import {
  createProject,
  getProject,
  listProjects,
  removeProjectRegistration,
  updateProject,
} from '../projects/project-store';
import { normalizeProjectConfig, validateProjectConfig } from '../projects/project-validator';
import { toSlug } from '../projects/slug';
import { discoverPrompts, ensurePromptsDir } from '../prompts/prompt-store';
import {
  findActiveRun,
  latestRun,
  listRuns,
  requestCancel,
  requestPause,
  saveRun,
} from '../state/run-state';
import { runProject, describeRunState } from '../execution/orchestrator';
import { createDefaultPorts } from '../execution/default-ports';
import { buildDryRunPlan, renderDryRunPlan } from '../execution/dry-run';
import { defaultLoopGuardConfig } from '../execution/loop-guard-config';
import { runDiagnostics, renderDiagnosticReport } from './diagnostics';
import { startPanelServer } from '../server/http-server';
import { cancelRun, pauseRun, shutdownRuns } from '../server/run-manager';
import { writeRunReport } from '../reports/report-generator';
import { runProcess } from '../agents/process-runner';
import { fileExists, readTextSync } from '../utils/fs-atomic';

/**
 * Implementação dos comandos da CLI.
 *
 * Convenção de código de saída: 0 sucesso, 1 falha, 2 uso incorreto.
 */

const EXIT_OK = 0;
const EXIT_FAIL = 1;
const EXIT_USAGE = 2;

export async function runCli(argv: string[]): Promise<number> {
  ensureDataLayout();

  const configResult = ensureGlobalConfig();
  if (!configResult.ok) {
    print(formatError(configResult.error));
    return EXIT_FAIL;
  }
  const config = configResult.value;

  const [command = 'menu', ...rest] = argv;

  switch (command) {
    case 'menu':
      return commandMenu(config);
    case 'panel':
      return commandPanel(rest, config);
    case 'project':
      return commandProject(rest);
    case 'run':
      return commandRun(rest, config);
    case 'pause':
      return commandPause(rest);
    case 'resume':
      return commandResume(rest, config);
    case 'cancel':
      return commandCancel(rest);
    case 'status':
      return commandStatus(rest);
    case 'doctor':
      return commandDoctor(rest);
    case 'docs':
      return commandDocs();
    case 'version':
    case '--version':
    case '-v':
      print(readVersion());
      return EXIT_OK;
    case 'help':
    case '--help':
    case '-h':
      printUsage();
      return EXIT_OK;
    default:
      print(`Comando desconhecido: ${command}`);
      printUsage();
      return EXIT_USAGE;
  }
}

/* ------------------------------------------------------------------------- */
/* Menu                                                                       */
/* ------------------------------------------------------------------------- */

async function commandMenu(config: GlobalConfig): Promise<number> {
  for (;;) {
    printBanner();
    print('  1. Abrir painel');
    print('  2. Cadastrar projeto');
    print('  3. Listar projetos');
    print('  4. Executar projeto');
    print('  5. Dry-run');
    print('  6. Status');
    print('  7. Pausar');
    print('  8. Retomar');
    print('  9. Diagnóstico');
    print(' 10. Abrir documentação');
    print('  0. Sair');
    print('');

    const choice = (await ask('  Escolha uma opção: ')).trim();
    print('');

    switch (choice) {
      case '1':
        await commandPanel(['open'], config);
        break;
      case '2':
        await interactiveAddProject();
        break;
      case '3':
        await commandProject(['list']);
        break;
      case '4': {
        const id = await pickProject();
        if (id) await commandRun([id], config);
        break;
      }
      case '5': {
        const id = await pickProject();
        if (id) await commandRun([id, '--dry-run'], config);
        break;
      }
      case '6':
        await commandStatus([]);
        break;
      case '7': {
        const id = await pickProject();
        if (id) await commandPause([id]);
        break;
      }
      case '8': {
        const id = await pickProject();
        if (id) await commandResume([id], config);
        break;
      }
      case '9':
        await commandDoctor([]);
        break;
      case '10':
        await commandDocs();
        break;
      case '0':
        return EXIT_OK;
      default:
        print('  Opção inválida.');
    }

    print('');
    await ask('  Pressione ENTER para voltar ao menu...');
  }
}

/* ------------------------------------------------------------------------- */
/* Painel                                                                     */
/* ------------------------------------------------------------------------- */

async function commandPanel(args: string[], config: GlobalConfig): Promise<number> {
  const action = args[0] ?? 'start';
  const url = `http://${config.panel.host}:${config.panel.port}`;

  if (action === 'open') {
    await openInBrowser(url);
    print(`  Painel aberto em ${url}`);
    print('  Se a página não carregar, inicie o servidor com INICIAR-PAINEL.cmd.');
    return EXIT_OK;
  }

  if (action === 'stop') {
    print('  Para encerrar o painel, feche a janela em que ele está rodando (Ctrl+C).');
    return EXIT_OK;
  }

  const logger = createLogger({ scope: 'panel' });
  const started = await startPanelServer({ config, logger });
  if (!started.ok) {
    print(formatError(started.error));
    return EXIT_FAIL;
  }

  print('');
  print(`  Painel do OrqPEG em ${started.value.url}`);
  print('  Pressione Ctrl+C para encerrar.');
  print('');

  if (config.panel.openBrowserOnStart) await openInBrowser(started.value.url);

  await new Promise<void>((resolve) => {
    let shuttingDown = false;
    const shutdown = (): void => {
      /* Ctrl+C repetido não dispara dois desligamentos concorrentes. */
      if (shuttingDown) return;
      shuttingDown = true;
      print('\n  Encerrando o painel com segurança...');
      /*
       * Interromper e AGUARDAR. Só sinalizar, como antes, deixava o painel
       * fechar com processos filhos (Claude, Codex, `npm test`) ainda vivos —
       * exatamente o processo órfão que o produto promete não deixar.
       */
      void shutdownRuns()
        .then((finished) => {
          if (!finished) {
            print('  AVISO: alguma execução não terminou dentro do prazo de espera.');
          }
        })
        .then(() => started.value.close())
        .then(() => resolve());
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  });

  return EXIT_OK;
}

/* ------------------------------------------------------------------------- */
/* Projetos                                                                   */
/* ------------------------------------------------------------------------- */

async function commandProject(args: string[]): Promise<number> {
  const action = args[0] ?? 'list';
  const id = args[1];

  switch (action) {
    case 'list': {
      const result = listProjects();
      if (!result.ok) {
        print(formatError(result.error));
        return EXIT_FAIL;
      }
      if (result.value.length === 0) {
        print('  Nenhum projeto cadastrado. Use CADASTRAR-PROJETO.cmd.');
        return EXIT_OK;
      }
      print('');
      print('  PROJETOS CADASTRADOS');
      print('  ' + '─'.repeat(70));
      for (const project of result.value) {
        const prompts = discoverPrompts(project.id);
        const count = prompts.ok ? prompts.value.length : 0;
        print(`  ${project.id.padEnd(20)} ${project.name}`);
        print(`  ${' '.repeat(20)} ${project.repositoryPath}`);
        print(
          `  ${' '.repeat(20)} ${project.githubRepository} · base ${project.baseBranch} · ${count} prompt(s)`,
        );
        print('');
      }
      return EXIT_OK;
    }

    case 'add':
      return interactiveAddProject();

    case 'edit': {
      const target = id ?? (await pickProject());
      if (!target) return EXIT_USAGE;
      return interactiveEditProject(target);
    }

    case 'remove': {
      const target = id ?? (await pickProject());
      if (!target) return EXIT_USAGE;
      const project = getProject(target);
      if (!project.ok) {
        print(formatError(project.error));
        return EXIT_FAIL;
      }
      print('');
      print(`  Remover o CADASTRO do projeto "${project.value.name}"?`);
      print(`  O repositório real em ${project.value.repositoryPath} NÃO será apagado.`);
      print('  Os dados operacionais (prompts, estado, logs, relatórios) serão removidos.');
      const answer = (await ask('  Digite REMOVER para confirmar: ')).trim();
      if (answer !== 'REMOVER') {
        print('  Cancelado.');
        return EXIT_OK;
      }
      const removed = removeProjectRegistration(target);
      if (!removed.ok) {
        print(formatError(removed.error));
        return EXIT_FAIL;
      }
      print('  Cadastro removido. O código do projeto permanece intacto.');
      return EXIT_OK;
    }

    default:
      print(`  Ação desconhecida: ${action}. Use list | add | edit | remove.`);
      return EXIT_USAGE;
  }
}

async function interactiveAddProject(): Promise<number> {
  printBanner();
  print('  CADASTRO DE PROJETO');
  print('  ' + '─'.repeat(70));
  print('  O projeto deve JÁ EXISTIR no computador como repositório Git.');
  print('  O OrqPEG não copia o código: ele apenas passa a orquestrá-lo.');
  print('');

  const name = (await ask('  Nome do projeto: ')).trim();
  if (name.length === 0) {
    print('  Nome é obrigatório.');
    return EXIT_USAGE;
  }

  const suggestedSlug = toSlug(name);
  const slugAnswer = (await ask(`  Identificador (slug) [${suggestedSlug}]: `)).trim();
  const id = slugAnswer.length > 0 ? toSlug(slugAnswer) : suggestedSlug;

  const repositoryPath = (await ask('  Caminho local (ex.: E:\\Projetos\\Screen): ')).trim();
  const githubRepository = (await ask('  Repositório GitHub (owner/repo): ')).trim();
  const remote = (await ask('  Remoto [origin]: ')).trim() || 'origin';
  const baseBranch = (await ask('  Branch base [main]: ')).trim() || 'main';

  const useWorktree = (await ask('  Usar worktree dedicado? [S/n]: ')).trim().toLowerCase();
  const worktreeEnabled = useWorktree !== 'n';
  const worktreeRoot = worktreeEnabled
    ? (await ask('  Pasta-base dos worktrees (ex.: E:\\AI-Worktrees): ')).trim()
    : '';

  print('');
  print('  Comandos de teste, um por linha. Linha vazia encerra.');
  print('  Padrão se vazio: npm test');
  const tests: string[] = [];
  for (;;) {
    const line = (await ask('    $ ')).trim();
    if (line.length === 0) break;
    tests.push(line);
  }

  const timeoutRaw = (await ask('  Timeout dos testes em segundos [1800]: ')).trim();
  const timeoutSeconds = Number.parseInt(timeoutRaw, 10);

  const attemptsRaw = (await ask('  Máximo de tentativas por prompt [3]: ')).trim();
  const maxAttempts = Number.parseInt(attemptsRaw, 10);

  const editor = (await ask('  Editor preferido (opcional, ex.: code): ')).trim();

  const draft = normalizeProjectConfig({
    id,
    name,
    repositoryPath,
    githubRepository,
    remote,
    baseBranch,
    worktree: {
      enabled: worktreeEnabled,
      rootPath: worktreeRoot.length > 0 ? worktreeRoot : null,
      reuseWhenSafe: true,
    },
    commands: {
      install: [],
      tests: tests.length > 0 ? tests : ['npm test'],
      timeoutSeconds: Number.isFinite(timeoutSeconds) && timeoutSeconds > 0 ? timeoutSeconds : 1800,
    },
    execution: {
      maxAttemptsPerPrompt: Number.isFinite(maxAttempts) && maxAttempts >= 1 ? maxAttempts : 3,
      maxReviewerRetries: 2,
      continueAfterApproval: true,
      stopOnBlocked: true,
      loopGuard: defaultLoopGuardConfig(),
    },
    editor: editor.length > 0 ? editor : null,
  });

  const validated = validateProjectConfig(draft);
  if (!validated.ok) {
    print('');
    print(formatError(validated.error));
    return EXIT_FAIL;
  }

  const created = createProject(validated.value);
  if (!created.ok) {
    print('');
    print(formatError(created.error));
    return EXIT_FAIL;
  }

  const promptsDir = ensurePromptsDir(created.value.id);
  print('');
  print(`  Projeto "${created.value.name}" cadastrado.`);
  if (promptsDir.ok) {
    print(`  Coloque seus prompts .md em:`);
    print(`    ${promptsDir.value}`);
  }
  print('  Use EXECUTAR-DRY-RUN.cmd para validar antes da primeira execução real.');
  return EXIT_OK;
}

async function interactiveEditProject(id: string): Promise<number> {
  const existing = getProject(id);
  if (!existing.ok) {
    print(formatError(existing.error));
    return EXIT_FAIL;
  }
  const project = existing.value;

  printBanner();
  print(`  EDITAR PROJETO — ${project.name}`);
  print('  ' + '─'.repeat(70));
  print('  Pressione ENTER para manter o valor atual.');
  print('');

  const patch: Partial<ProjectConfig> = {};

  const name = (await ask(`  Nome [${project.name}]: `)).trim();
  if (name) patch.name = name;

  const repoPath = (await ask(`  Caminho local [${project.repositoryPath}]: `)).trim();
  if (repoPath) patch.repositoryPath = repoPath;

  const gh = (await ask(`  GitHub [${project.githubRepository}]: `)).trim();
  if (gh) patch.githubRepository = gh;

  const base = (await ask(`  Branch base [${project.baseBranch}]: `)).trim();
  if (base) patch.baseBranch = base;

  const tests = (await ask(`  Comandos de teste separados por " && " [${project.commands.tests.join(' && ')}]: `)).trim();
  if (tests) {
    patch.commands = {
      ...project.commands,
      tests: tests.split('&&').map((t) => t.trim()).filter((t) => t.length > 0),
    };
  }

  const mergeEnabled = (await ask(`  Merge automático habilitado? [${project.merge.enabled ? 'S' : 'n'}]: `)).trim().toLowerCase();
  if (mergeEnabled === 's' || mergeEnabled === 'n') {
    patch.merge = { ...project.merge, enabled: mergeEnabled === 's' };
  }

  const updated = updateProject(id, patch);
  if (!updated.ok) {
    print('');
    print(formatError(updated.error));
    return EXIT_FAIL;
  }
  print('');
  print('  Projeto atualizado.');
  return EXIT_OK;
}

/* ------------------------------------------------------------------------- */
/* Execução                                                                   */
/* ------------------------------------------------------------------------- */

async function commandRun(args: string[], config: GlobalConfig): Promise<number> {
  const dryRun = args.includes('--dry-run');
  const positional = args.filter((arg) => !arg.startsWith('--'));
  const projectId = positional[0] ?? (await pickProject());
  if (!projectId) return EXIT_USAGE;

  if (dryRun) {
    const plan = buildDryRunPlan(projectId, config);
    if (!plan.ok) {
      print(formatError(plan.error));
      return EXIT_FAIL;
    }
    print(renderDryRunPlan(plan.value));
    return EXIT_OK;
  }

  const guard = inspectApiEnvironment({ config });
  if (guard.presentKeys.length > 0 || guard.warnKeys.length > 0) {
    print('');
    print(describeApiGuard(guard));
    print('');
  }
  if (guard.blocked) {
    const answer = (await ask('  Continuar com ambiente filho sanitizado? [s/N]: '))
      .trim()
      .toLowerCase();
    if (answer !== 's') {
      print('  Execução cancelada.');
      return EXIT_FAIL;
    }
  }

  const logger = createLogger({ scope: `run:${projectId}` });
  const controller = new AbortController();

  const onSignal = (): void => {
    print('\n  Interrupção recebida. Preservando código, worktree, branch e logs...');
    controller.abort();
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  const result = await runProject({
    projectId,
    dryRun: false,
    config,
    logger,
    ports: createDefaultPorts(),
    signal: controller.signal,
    onUpdate: (run: RunRecord) => {
      print(`  [${run.state}] ${describeRunState(run.state)}`);
    },
  });

  process.removeListener('SIGINT', onSignal);
  process.removeListener('SIGTERM', onSignal);

  if (!result.ok) {
    print('');
    print(formatError(result.error));
    return EXIT_FAIL;
  }

  const run = result.value;
  const project = getProject(projectId);
  if (project.ok) {
    const written = writeRunReport({ project: project.value, run });
    if (written.ok) {
      print('');
      print(`  Relatório: ${written.value.htmlPath}`);
    }
  }

  print('');
  print(`  Execução ${run.runId} finalizada no estado ${run.state} (${describeRunState(run.state)}).`);

  return run.state === 'MERGED' || run.state === 'COMPLETED' ? EXIT_OK : EXIT_FAIL;
}

async function commandPause(args: string[]): Promise<number> {
  const projectId = args[0] ?? (await pickProject());
  if (!projectId) return EXIT_USAGE;

  const active = findActiveRun(projectId);
  if (!active.ok) {
    print(formatError(active.error));
    return EXIT_FAIL;
  }
  if (!active.value) {
    print('  Nenhuma execução ativa para pausar.');
    return EXIT_OK;
  }
  /*
   * A intenção é PERSISTIDA primeiro e o controlador vivo é acionado depois.
   *
   * Uma pausa que não chega ao disco não sobrevive a nada — nem a um reinício,
   * nem à retomada — então falhar a gravação precisa reprovar o comando em vez
   * de interromper o trabalho sem deixar registro do porquê.
   */
  const paused = requestPause(active.value);
  const saved = saveRun(paused);
  if (!saved.ok) {
    print('  A pausa NÃO foi registrada. Nada foi interrompido.');
    print(formatError(saved.error));
    return EXIT_FAIL;
  }

  const accepted = pauseRun(projectId);
  print(`  Pausa solicitada para a execução ${saved.value.runId}.`);
  if (accepted === null) {
    /* Caso normal da CLI: a rodada vive no processo do painel. A vigília de
       intenção daquele processo lê esta marca e interrompe a etapa em curso. */
    print('  Intenção registrada no estado. A execução em curso interrompe a etapa corrente.');
  } else {
    print(`  Etapa "${accepted.step ?? 'desconhecida'}" interrompida neste processo.`);
  }
  print('  O estado, o código e o worktree são preservados. Use RETOMAR.cmd para continuar.');
  return EXIT_OK;
}

async function commandResume(args: string[], config: GlobalConfig): Promise<number> {
  const projectId = args[0] ?? (await pickProject());
  if (!projectId) return EXIT_USAGE;

  const runs = listRuns(projectId);
  if (!runs.ok) {
    print(formatError(runs.error));
    return EXIT_FAIL;
  }
  const resumable = runs.value.find(
    (run) =>
      run.state === 'INTERRUPTED' ||
      run.state === 'BLOCKED' ||
      run.state === 'CI_FAILED' ||
      run.state === 'AUTH_REQUIRED' ||
      run.state === 'USAGE_LIMIT_REACHED' ||
      // Sem isto, uma execução parada pelo Loop Guard jamais poderia ser
      // retomada — e a autorização manual seria impossível de exercer.
      run.state === 'LOOP_GUARD_TRIGGERED',
  );
  if (!resumable) {
    print('  Nenhuma execução retomável encontrada.');
    return EXIT_OK;
  }

  print(`  Retomando ${resumable.runId} a partir do estado ${resumable.state}.`);
  print('  Prompts já aprovados não serão reexecutados.');

  const logger = createLogger({ scope: `resume:${projectId}` });
  const result = await runProject({
    projectId,
    dryRun: false,
    resumeRunId: resumable.runId,
    config,
    logger,
    ports: createDefaultPorts(),
    onUpdate: (run: RunRecord) => print(`  [${run.state}] ${describeRunState(run.state)}`),
  });

  if (!result.ok) {
    print(formatError(result.error));
    return EXIT_FAIL;
  }
  print(`  Execução ${result.value.runId} agora está em ${result.value.state}.`);
  return EXIT_OK;
}

async function commandCancel(args: string[]): Promise<number> {
  const projectId = args[0] ?? (await pickProject());
  if (!projectId) return EXIT_USAGE;

  const active = findActiveRun(projectId);
  if (!active.ok) {
    print(formatError(active.error));
    return EXIT_FAIL;
  }
  if (!active.value) {
    /* Idempotência: cancelar de novo o que já foi cancelado é sucesso, não
       "não havia nada". A distinção é o que o operador precisa ler. */
    const previous = latestRun(projectId);
    const last = previous.ok ? previous.value : null;
    if (last && (last.state === 'CANCELLED' || last.cancelRequested)) {
      print(`  A execução ${last.runId} já estava cancelada (${last.state}). Nada foi alterado.`);
      return EXIT_OK;
    }
    print('  Nenhuma execução ativa para cancelar.');
    return EXIT_OK;
  }

  print('');
  print('  CANCELAMENTO SEGURO');
  print('  O código, a branch, o worktree, os logs e os artefatos serão PRESERVADOS.');
  print('  Nenhum reset destrutivo e nenhuma limpeza serão executados.');
  const answer = (await ask('  Confirmar cancelamento? [s/N]: ')).trim().toLowerCase();
  if (answer !== 's') {
    print('  Cancelamento abortado.');
    return EXIT_OK;
  }

  const cancelled = requestCancel(active.value);
  const saved = saveRun(cancelled);
  if (!saved.ok) {
    print('  O cancelamento NÃO foi registrado. Nada foi interrompido.');
    print(formatError(saved.error));
    return EXIT_FAIL;
  }

  const accepted = cancelRun(projectId);
  print(`  Cancelamento solicitado para ${saved.value.runId}. Nada foi apagado.`);
  if (accepted === null) {
    print('  Intenção registrada no estado. A execução em curso encerra a etapa corrente.');
  } else {
    print(`  Etapa "${accepted.step ?? 'desconhecida'}" interrompida neste processo.`);
  }
  return EXIT_OK;
}

/* ------------------------------------------------------------------------- */
/* Status e diagnóstico                                                       */
/* ------------------------------------------------------------------------- */

async function commandStatus(args: string[]): Promise<number> {
  const projectId = args[0];
  const projectsResult = listProjects();
  if (!projectsResult.ok) {
    print(formatError(projectsResult.error));
    return EXIT_FAIL;
  }

  const projects = projectId
    ? projectsResult.value.filter((p) => p.id === projectId)
    : projectsResult.value;

  if (projects.length === 0) {
    print('  Nenhum projeto cadastrado.');
    return EXIT_OK;
  }

  printBanner();
  for (const project of projects) {
    const runs = listRuns(project.id);
    const latest = runs.ok ? runs.value[0] : undefined;
    const prompts = discoverPrompts(project.id);

    print(`  ${project.name} (${project.id})`);
    print('  ' + '─'.repeat(70));
    print(`    Repositório : ${project.repositoryPath}`);
    print(`    GitHub      : ${project.githubRepository} · base ${project.baseBranch}`);
    print(`    Prompts     : ${prompts.ok ? prompts.value.length : 0}`);

    if (!latest) {
      print('    Execuções   : nenhuma');
      print('');
      continue;
    }

    const approved = latest.prompts.filter((p) => p.status === 'APPROVED').length;
    print(`    Execução    : ${latest.runId}`);
    print(`    Estado      : ${latest.state} (${describeRunState(latest.state)})`);
    print(`    Progresso   : ${approved}/${latest.prompts.length} prompt(s) aprovado(s)`);
    print(`    Branch      : ${latest.branchName ?? '—'}`);
    if (latest.pullRequest) {
      print(`    PR          : #${latest.pullRequest.number} ${latest.pullRequest.url}`);
    }
    if (latest.checks) {
      print(
        `    CI          : ${latest.checks.passed}/${latest.checks.total} aprovados, ${latest.checks.pending} pendentes`,
      );
    }
    if (latest.consensus) {
      print(`    Consenso    : ${latest.consensus.reached ? 'ALCANÇADO' : 'NÃO ALCANÇADO'}`);
    }
    if (latest.gateReport) {
      const passed = latest.gateReport.gates.filter((g) => g.status === 'PASSED').length;
      print(`    Gates       : ${passed}/${latest.gateReport.gates.length} aprovados`);
    }
    if (latest.mergeOutcome?.merged) {
      print(`    Merge       : ${latest.mergeOutcome.mergeSha ?? 'concluído'}`);
    }
    if (latest.lastError) {
      print(`    Último erro : [${latest.lastError.code}] ${latest.lastError.message}`);
    }
    print('');
  }

  return EXIT_OK;
}

async function commandDoctor(args: string[]): Promise<number> {
  const report = await runDiagnostics();

  if (args.includes('--json')) {
    print(JSON.stringify(report, null, 2));
    return report.overall === 'ERRO' ? EXIT_FAIL : EXIT_OK;
  }

  print(renderDiagnosticReport(report));
  return report.overall === 'ERRO' ? EXIT_FAIL : EXIT_OK;
}

async function commandDocs(): Promise<number> {
  const guide = path.join(orqpegRoot(), 'COMECE-AQUI.html');
  if (!fileExists(guide)) {
    print(`  Documentação não encontrada em ${guide}`);
    return EXIT_FAIL;
  }
  await openInBrowser(guide);
  print(`  Abrindo ${guide}`);
  return EXIT_OK;
}

/* ------------------------------------------------------------------------- */
/* Auxiliares                                                                 */
/* ------------------------------------------------------------------------- */

function print(line: string): void {
  process.stdout.write(`${line}\n`);
}

function printBanner(): void {
  print('');
  print('  ' + '═'.repeat(70));
  print(`   ORQPEG ${readVersion()}   ·   orquestrador local Claude + Codex`);
  print('  ' + '═'.repeat(70));
  print('');
}

function printUsage(): void {
  print('');
  print('  Uso: orqpeg <comando> [opções]');
  print('');
  print('    menu                        Menu interativo');
  print('    panel start|open|stop       Painel local em 127.0.0.1');
  print('    project list|add|edit|remove');
  print('    run <projeto> [--dry-run]   Executa (ou simula) um projeto');
  print('    pause <projeto>             Solicita pausa segura');
  print('    resume <projeto>            Retoma a execução preservada');
  print('    cancel <projeto>            Cancelamento seguro (nada é apagado)');
  print('    status [projeto]            Situação atual');
  print('    doctor [--json]             Diagnóstico completo');
  print('    docs                        Abre COMECE-AQUI.html');
  print('    version                     Versão instalada');
  print('');
}

function readVersion(): string {
  const file = readTextSync(path.join(orqpegRoot(), 'VERSION'));
  return file.ok ? file.value.trim() : '1.0.0';
}

async function pickProject(): Promise<string | null> {
  const result = listProjects();
  if (!result.ok || result.value.length === 0) {
    print('  Nenhum projeto cadastrado. Use CADASTRAR-PROJETO.cmd.');
    return null;
  }
  if (result.value.length === 1) {
    const only = result.value[0];
    return only ? only.id : null;
  }

  print('');
  print('  Projetos disponíveis:');
  result.value.forEach((project, index) => {
    print(`    ${index + 1}. ${project.id.padEnd(20)} ${project.name}`);
  });
  print('');

  const answer = (await ask('  Número ou identificador: ')).trim();
  const index = Number.parseInt(answer, 10);
  if (Number.isFinite(index) && index >= 1 && index <= result.value.length) {
    const chosen = result.value[index - 1];
    return chosen ? chosen.id : null;
  }
  const byId = result.value.find((project) => project.id === answer);
  if (byId) return byId.id;

  print('  Projeto não encontrado.');
  return null;
}

function ask(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

async function openInBrowser(target: string): Promise<void> {
  if (process.platform === 'win32') {
    await runProcess('explorer.exe', [target], { cwd: orqpegRoot(), timeoutMs: 15_000 });
    return;
  }
  const command = process.platform === 'darwin' ? 'open' : 'xdg-open';
  await runProcess(command, [target], { cwd: orqpegRoot(), timeoutMs: 15_000 });
}

export { ORQPEG_DIRS };
