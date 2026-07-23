'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/*
 * Ciclo completo do OrqPEG contra dublês.
 *
 * Nenhuma IA real, nenhuma rede, nenhum repositório do usuário é tocado.
 * ORQPEG_HOME é redirecionado para uma pasta temporária antes de qualquer
 * import, de modo que todo o estado gravado fique isolado.
 */

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'orqpeg-e2e-'));
process.env.ORQPEG_HOME = HOME;
process.env.ORQPEG_NO_FILE_LOG = '1';

// A raiz precisa conter os schemas reais: o parser de revisão valida contra eles.
const REPO_ROOT = path.resolve(__dirname, '..', '..');
fs.mkdirSync(path.join(HOME, 'schemas'), { recursive: true });
for (const name of fs.readdirSync(path.join(REPO_ROOT, 'schemas'))) {
  fs.copyFileSync(path.join(REPO_ROOT, 'schemas', name), path.join(HOME, 'schemas', name));
}
fs.mkdirSync(path.join(HOME, 'templates'), { recursive: true });
for (const name of fs.readdirSync(path.join(REPO_ROOT, 'templates'))) {
  fs.copyFileSync(path.join(REPO_ROOT, 'templates', name), path.join(HOME, 'templates', name));
}

const { runProject } = require('../../dist/execution/orchestrator');
const { createProject } = require('../../dist/projects/project-store');
const { normalizeProjectConfig } = require('../../dist/projects/project-validator');
const { nullLogger } = require('../../dist/utils/logger');
const { defaultGlobalConfig } = require('../../dist/config/global-config');
const { ensureDataLayout, projectPromptsDir } = require('../../dist/utils/paths');

ensureDataLayout();

const HEAD = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const BASE = '0000111122223333444455556666777788889999';

/* ------------------------------------------------------------------------ */
/* Fixtures                                                                  */
/* ------------------------------------------------------------------------ */

let projectCounter = 0;

function makeProject(overrides = {}) {
  projectCounter += 1;
  const id = `demo${projectCounter}`;
  const repoPath = path.join(HOME, 'repos', id);
  fs.mkdirSync(repoPath, { recursive: true });

  const config = normalizeProjectConfig({
    id,
    name: `Demo ${projectCounter}`,
    repositoryPath: repoPath,
    githubRepository: 'maquinanerd/demo',
    ...overrides,
  });
  config.worktree.enabled = false;
  Object.assign(config.merge, overrides.merge ?? {});

  const created = createProject(config);
  assert.equal(created.ok, true, created.ok ? '' : JSON.stringify(created.error));

  const promptsDir = projectPromptsDir(id);
  fs.mkdirSync(promptsDir, { recursive: true });
  fs.writeFileSync(
    path.join(promptsDir, '010-fundacao.md'),
    [
      '# Identificação',
      '',
      'ID: 010-fundacao',
      'Nome: Fundação',
      '',
      '# Objetivo',
      '',
      'Criar a fundação do módulo.',
      '',
      '# Critérios de aceitação',
      '',
      '- O módulo compila.',
      '',
      '# Testes obrigatórios',
      '',
      '- npm test',
      '',
    ].join('\n'),
    'utf8',
  );
  // Arquivos reservados nunca podem virar prompt.
  fs.writeFileSync(path.join(promptsDir, 'README.md'), '# leia-me', 'utf8');
  fs.writeFileSync(path.join(promptsDir, '_rascunho.md'), '# rascunho', 'utf8');

  return created.value;
}

function promptReviewJson(verdict = 'APPROVED', extra = {}) {
  // Um pedido de mudança PRECISA trazer ação concreta: o Loop Guard recusa
  // CHANGES_REQUESTED vago, porque encaminhá-lo produziria correção às cegas.
  const actions =
    verdict === 'CHANGES_REQUESTED' ? ['Adicionar validação do caso de borda X.'] : [];
  return JSON.stringify({
    verdict,
    summary: 'Revisão automatizada de teste.',
    confidence: 0.97,
    meetsPromptRequirements: verdict === 'APPROVED',
    blockingIssues: [],
    nonBlockingIssues: [],
    requiredActions: actions,
    scopeAssessment: { withinScope: true, unexpectedChanges: [] },
    testsAssessment: { localTestsPassed: true, coverageAcceptable: true },
    riskAssessment: { level: 'low', summary: 'Baixo risco.' },
    ...extra,
  });
}

function mergeReviewJson(overrides = {}) {
  return JSON.stringify({
    verdict: 'APPROVED_FOR_MERGE',
    reviewedHeadSha: HEAD,
    summary: 'Auditoria final de teste.',
    confidence: 0.96,
    blockingIssues: [],
    nonBlockingIssues: [],
    requiredActions: [],
    riskAssessment: { level: 'low', summary: 'Baixo risco.' },
    testsAssessment: { localTestsPassed: true, ciPassed: true, coverageAcceptable: true },
    scopeAssessment: { withinScope: true, unexpectedChanges: [] },
    ...overrides,
  });
}

function agentResult(output) {
  const at = new Date().toISOString();
  return {
    ok: true,
    value: {
      output,
      invocation: {
        agent: 'claude',
        role: 'executor',
        instructionPath: '',
        cwd: '',
        model: null,
        startedAt: at,
        finishedAt: at,
        durationMs: 1,
        status: 'COMPLETED',
        exitCode: 0,
        sessionId: null,
        stdoutPath: '',
        stderrPath: '',
        usageLimitReached: false,
        authRequired: false,
      },
      process: {
        command: 'mock',
        args: [],
        cwd: '',
        status: 'COMPLETED',
        exitCode: 0,
        signal: null,
        stdout: output,
        stderr: '',
        startedAt: at,
        finishedAt: at,
        durationMs: 1,
        timedOut: false,
        stdoutTruncated: false,
        stderrTruncated: false,
      },
    },
  };
}

function passingTests() {
  const at = new Date().toISOString();
  return {
    status: 'PASSED',
    passed: true,
    startedAt: at,
    finishedAt: at,
    durationMs: 10,
    commands: [
      {
        command: 'npm test',
        cwd: '',
        status: 'PASSED',
        exitCode: 0,
        startedAt: at,
        finishedAt: at,
        durationMs: 10,
        stdout: 'ok',
        stderr: '',
      },
    ],
    failedCommands: [],
  };
}

function failingTests() {
  const suite = passingTests();
  suite.status = 'FAILED';
  suite.passed = false;
  suite.commands[0].status = 'FAILED';
  suite.commands[0].exitCode = 1;
  suite.failedCommands = ['npm test'];
  return suite;
}

function pullRequest(overrides = {}) {
  return {
    number: 7,
    url: 'https://github.com/maquinanerd/demo/pull/7',
    title: 'orqpeg: demo',
    state: 'OPEN',
    isDraft: false,
    baseRefName: 'main',
    headRefName: 'orqpeg/demo/run-1',
    headSha: HEAD,
    baseSha: BASE,
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'CLEAN',
    merged: false,
    mergeCommitSha: null,
    reviewDecision: null,
    unresolvedThreadCount: 0,
    ...overrides,
  };
}

function checksSummary(overrides = {}) {
  return {
    headSha: HEAD,
    total: 1,
    passed: 1,
    failed: 0,
    pending: 0,
    skipped: 0,
    allRequiredPassed: true,
    anyRequiredPending: false,
    anyRequiredFailed: false,
    anyRequiredSkipped: false,
    runs: [],
    ...overrides,
  };
}

const OK = (value) => ({ ok: true, value });

/**
 * Portas mockadas. `spy` acumula o que foi chamado para as asserções.
 */
function makePorts(options = {}) {
  const spy = {
    merged: false,
    mergeCalls: 0,
    pushes: 0,
    commits: 0,
    claudeCalls: [],
    codexCalls: [],
    // O nome da branch é gerado pelo orquestrador; a PR simulada precisa
    // refletir exatamente esse valor, senão o gate 3 reprova (com razão).
    branch: 'orqpeg/demo/run-1',
    diffRevision: 0,
  };

  const ports = {
    agents: {
      async runClaude(input) {
        spy.claudeCalls.push(input.role);
        if (input.role === 'merge-auditor') {
          return options.claudeAudit
            ? options.claudeAudit()
            : agentResult(mergeReviewJson(options.claudeAuditOverrides ?? {}));
        }
        return agentResult('Implementado.');
      },
      async runCodex(input) {
        spy.codexCalls.push(input.role);
        if (input.role === 'merge-auditor') {
          if (options.codexAudit) return options.codexAudit();
          return agentResult(mergeReviewJson(options.codexAuditOverrides ?? {}));
        }
        if (options.codexReview) return options.codexReview(spy.codexCalls.length);
        return agentResult(promptReviewJson('APPROVED'));
      },
      async claudeAvailable() {
        return options.claudeAvailable !== false;
      },
      async codexAvailable() {
        return options.codexAvailable !== false;
      },
    },

    git: {
      async headSha() {
        return OK(BASE);
      },
      async currentBranch() {
        return OK('main');
      },
      async changedFiles() {
        return OK(options.changedFiles ?? ['src/app.ts']);
      },
      async statusText() {
        return OK('M src/app.ts');
      },
      async diffStat() {
        return OK(' src/app.ts | 10 +++++');
      },
      async diffPatch() {
        // Por padrão o diff é constante entre tentativas — é o que caracteriza
        // ausência de progresso. `varyingDiff` simula um executor que de fato
        // muda o código a cada correção.
        if (options.varyingDiff) {
          spy.diffRevision += 1;
          return OK(
            'diff --git a/src/app.ts b/src/app.ts\n@@\n+revisao ' + spy.diffRevision + '\n',
          );
        }
        return OK('diff --git a/src/app.ts b/src/app.ts');
      },
      async addPaths() {
        return OK(undefined);
      },
      async commit() {
        spy.commits += 1;
        return OK(`c0mm1t${spy.commits}`);
      },
      async push() {
        spy.pushes += 1;
        return OK(undefined);
      },
      async remoteUrl() {
        return OK(options.remoteUrl ?? 'https://github.com/maquinanerd/demo.git');
      },
      async commitLog() {
        return OK('c0mm1t1 orqpeg: demo');
      },
    },

    worktree: {
      async prepare(input) {
        spy.branch = input.branch;
        return OK({ path: input.worktreePath, branch: input.branch });
      },
    },

    github: {
      async createDraftPullRequest(input) {
        spy.branch = input.head;
        return OK(pullRequest({ headRefName: input.head, ...(options.prOverrides ?? {}) }));
      },
      async getPullRequest() {
        return OK(
          pullRequest({
            headRefName: spy.branch,
            ...(options.prOverrides ?? {}),
            ...(options.freshPrOverrides ?? {}),
          }),
        );
      },
      async findPullRequestForBranch() {
        return OK(null);
      },
      async updatePullRequestBody() {
        return OK(undefined);
      },
      async markReadyForReview() {
        return OK(undefined);
      },
      async getChecks() {
        return OK(checksSummary(options.checksOverrides ?? {}));
      },
      async waitForChecks() {
        return OK(checksSummary(options.checksOverrides ?? {}));
      },
    },

    merge: {
      async execute(input) {
        spy.mergeCalls += 1;
        if (input.pr.merged) {
          return OK({
            attempted: false,
            merged: true,
            mergeSha: input.pr.mergeCommitSha,
            strategy: 'squash',
            matchedHeadSha: input.pr.headSha,
            performedAt: null,
            reason: 'PR já estava mergeada; nada a fazer.',
            idempotentSkip: true,
          });
        }
        spy.merged = true;
        return OK({
          attempted: true,
          merged: true,
          mergeSha: 'merged00',
          strategy: 'squash',
          matchedHeadSha: input.pr.headSha,
          performedAt: new Date().toISOString(),
          reason: 'Todos os gates aprovados.',
          idempotentSkip: false,
        });
      },
    },

    tests: {
      async run() {
        return options.tests ? options.tests() : passingTests();
      },
    },
  };

  return { ports, spy };
}

async function execute(project, options = {}) {
  const { ports, spy } = makePorts(options);
  const result = await runProject({
    projectId: project.id,
    dryRun: options.dryRun === true,
    config: defaultGlobalConfig(),
    logger: nullLogger(),
    ports,
  });
  return { result, spy };
}

/* ------------------------------------------------------------------------ */
/* Caminho feliz completo                                                    */
/* ------------------------------------------------------------------------ */

test('ciclo completo com ambas as IAs aprovando chega a MERGED', async () => {
  const project = makeProject();
  const { result, spy } = await execute(project);

  assert.equal(result.ok, true, result.ok ? '' : JSON.stringify(result.error));
  const run = result.value;

  assert.equal(run.state, 'MERGED', `estado final inesperado: ${run.state}`);
  assert.equal(run.prompts[0].status, 'APPROVED');
  assert.equal(run.commits.length, 1, 'deve existir um commit por prompt aprovado');
  assert.equal(spy.pushes, 1);
  assert.equal(spy.merged, true);
  assert.equal(run.consensus.reached, true);
  assert.equal(run.gateReport.allPassed, true);
  assert.equal(run.mergeOutcome.merged, true);

  // As duas auditorias finais foram executadas, em sessões separadas do executor.
  assert.ok(spy.claudeCalls.includes('executor'));
  assert.ok(spy.claudeCalls.includes('merge-auditor'));
  assert.ok(spy.codexCalls.includes('prompt-reviewer'));
  assert.ok(spy.codexCalls.includes('merge-auditor'));
});

test('arquivos reservados não viram prompts', async () => {
  const project = makeProject();
  const { result } = await execute(project);
  assert.equal(result.value.prompts.length, 1, 'README.md e _rascunho.md devem ser ignorados');
  assert.equal(result.value.prompts[0].promptId, '010-fundacao');
});

/* ------------------------------------------------------------------------ */
/* O OrqPEG é a autoridade dos testes                                        */
/* ------------------------------------------------------------------------ */

test('teste falhando impede aprovação mesmo com o Codex dizendo APPROVED', async () => {
  const project = makeProject();
  const { result, spy } = await execute(project, { tests: failingTests });

  assert.equal(result.ok, true);
  assert.notEqual(result.value.state, 'MERGED');
  assert.notEqual(result.value.prompts[0].status, 'APPROVED');
  assert.equal(spy.merged, false, 'jamais mergear com teste falhando');
  assert.equal(spy.commits, 0, 'nenhum commit com teste falhando');
});

test('Codex pedindo mudanças gera nova tentativa e o Claude é chamado de novo', async () => {
  const project = makeProject();
  let call = 0;
  const { result, spy } = await execute(project, {
    codexReview: () => {
      call += 1;
      return agentResult(promptReviewJson(call === 1 ? 'CHANGES_REQUESTED' : 'APPROVED'));
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.value.prompts[0].status, 'APPROVED');
  assert.equal(result.value.prompts[0].attempts, 2, 'deve ter havido uma segunda tentativa');
  assert.ok(spy.claudeCalls.includes('corrector'), 'a correção deve usar o papel de corretor');
});

/*
 * Regressão de campo. Numa execução real com Claude e Codex, o laço de
 * tentativas esgotou e foi direto para BLOCKED com mensagem genérica, SEM
 * passar pelo Loop Guard: `lastLoopGuard` ficou nulo, o estado não virou
 * LOOP_GUARD_TRIGGERED e nenhum LOOP-GUARD.md foi gerado. O gatilho
 * MAX_ATTEMPTS_REACHED existia e era testado em unidade, mas nunca era emitido
 * na prática porque o `for` nunca chega a perguntar pela tentativa seguinte.
 */
test('correção que não muda o código para em NO_PROGRESS antes de gastar o limite', async () => {
  const project = makeProject();
  const { result, spy } = await execute(project, {
    // O revisor pede correção sempre, e o executor devolve o mesmo diff.
    codexReview: () => agentResult(promptReviewJson('CHANGES_REQUESTED')),
  });

  assert.equal(result.ok, true, result.ok ? '' : JSON.stringify(result.error));
  const run = result.value;

  assert.equal(run.state, 'LOOP_GUARD_TRIGGERED', 'parada consciente, não bloqueio genérico');
  assert.equal(run.lastLoopGuard.trigger, 'NO_PROGRESS');
  assert.equal(run.lastLoopGuard.severity, 'soft_stop');
  assert.ok(run.lastLoopGuard.nextActions.length > 0);
  assert.equal(run.prompts[0].status, 'BLOCKED');
  assert.equal(spy.commits, 0, 'prompt não aprovado nunca gera commit');

  // O ganho concreto: parou ANTES de gastar a terceira chamada do executor.
  const executores = spy.claudeCalls.filter((r) => r === 'executor' || r === 'corrector');
  assert.equal(
    executores.length,
    2,
    'detectar ausência de progresso economiza a tentativa que repetiria o mesmo código',
  );
});

test('esgotar as tentativas com progresso real nomeia MAX_ATTEMPTS_REACHED', async () => {
  const project = makeProject();
  // Progresso genuíno em todas as dimensões: o código muda a cada volta e o
  // revisor aponta problemas diferentes. Nenhum gatilho fino se aplica, então
  // o que resta é o teto de tentativas.
  let rodada = 0;
  const { result, spy } = await execute(project, {
    codexReview: () => {
      rodada += 1;
      return agentResult(
        promptReviewJson('CHANGES_REQUESTED', {
          requiredActions: ['Corrigir o ponto número ' + rodada + '.'],
          blockingIssues: [
            {
              severity: 'blocking',
              title: 'Problema distinto ' + rodada,
              description: 'Descrição específica da rodada ' + rodada + '.',
            },
          ],
        }),
      );
    },
    varyingDiff: true,
  });

  assert.equal(result.ok, true, result.ok ? '' : JSON.stringify(result.error));
  const run = result.value;

  assert.equal(run.state, 'LOOP_GUARD_TRIGGERED');
  assert.ok(run.lastLoopGuard, 'a decisão precisa ficar registrada no estado');
  assert.equal(run.lastLoopGuard.trigger, 'MAX_ATTEMPTS_REACHED');
  assert.equal(run.lastLoopGuard.allowed, false);
  assert.equal(run.prompts[0].status, 'BLOCKED');
  assert.equal(spy.merged, false);

  const executores = spy.claudeCalls.filter((r) => r === 'executor' || r === 'corrector');
  assert.equal(
    executores.length,
    project.execution.maxAttemptsPerPrompt,
    'com progresso real o limite de tentativas é usado por inteiro, mas não excedido',
  );
});

/*
 * Regressão de campo: ao retomar, o contador local do laço reiniciava em 1
 * enquanto o orçamento persistia. Como o diretório de artefatos é
 * `attempt-<n>`, a retomada SOBRESCREVIA a evidência da primeira tentativa —
 * diff, saída do Claude, testes e revisão do Codex eram perdidos.
 */
test('retomar continua a numeração e não sobrescreve artefatos anteriores', async () => {
  const project = makeProject();

  // Progresso genuíno em todas as dimensões para que as três tentativas
  // aconteçam e a parada seja por MAX_ATTEMPTS_REACHED.
  let rodada = 0;
  const revisaoDistinta = () => {
    rodada += 1;
    return agentResult(
      promptReviewJson('CHANGES_REQUESTED', {
        requiredActions: ['Ajuste número ' + rodada + '.'],
        blockingIssues: [
          { severity: 'blocking', title: 'Item ' + rodada, description: 'Detalhe ' + rodada + '.' },
        ],
      }),
    );
  };

  const primeira = await execute(project, {
    codexReview: revisaoDistinta,
    varyingDiff: true,
  });
  assert.equal(primeira.result.value.state, 'LOOP_GUARD_TRIGGERED');

  const antes = primeira.result.value.budgets.find((b) => b.promptId === '010-fundacao');
  assert.equal(antes.attempts, 3);

  // Autoriza uma tentativa extra e retoma.
  const { grantManualOverride } = require('../../dist/execution/override');
  const { saveRun } = require('../../dist/state/run-state');
  const concedido = grantManualOverride({
    run: primeira.result.value,
    promptId: '010-fundacao',
    justification: 'Ajustei o ambiente manualmente; mais uma tentativa deve resolver.',
    authorizedBy: 'teste',
    policy: require('../helpers/policy').loopGuardPolicyFor(project),
  });
  assert.equal(concedido.ok, true, concedido.ok ? '' : concedido.error.message);
  saveRun(concedido.value.run);

  const { ports } = makePorts({
    codexReview: revisaoDistinta,
    varyingDiff: true,
  });
  const retomada = await runProject({
    projectId: project.id,
    dryRun: false,
    resumeRunId: primeira.result.value.runId,
    config: defaultGlobalConfig(),
    logger: nullLogger(),
    ports,
  });

  assert.equal(retomada.ok, true, retomada.ok ? '' : JSON.stringify(retomada.error));
  const depois = retomada.value.budgets.find((b) => b.promptId === '010-fundacao');

  assert.equal(depois.attempts, 4, 'a quarta tentativa continua a contagem, não reinicia');
  assert.equal(depois.manualOverridesUsed, 1, 'a autorização foi consumida');
  assert.equal(
    retomada.value.overrides.filter((o) => o.consumed === false).length,
    0,
    'nenhuma autorização pode sobrar pendente após ser exercida',
  );

  // O diretório da quarta tentativa existe; os das anteriores continuam lá.
  const artifactRoot = path.join(
    HOME, 'data', 'projects', project.id, 'artifacts',
    primeira.result.value.runId, '010-fundacao',
  );
  for (const n of [1, 2, 3, 4]) {
    assert.equal(
      fs.existsSync(path.join(artifactRoot, 'attempt-' + n)),
      true,
      `attempt-${n} precisa existir e não ter sido sobrescrito`,
    );
  }
});

/*
 * Regra 2 do congelamento de política, ponta a ponta: uma alteração REAL no
 * cadastro entre a parada e a retomada interrompe a execução em vez de ser
 * absorvida em silêncio. O hash "de agora" precisa vir do disco — se viesse do
 * objeto em memória do início, a comparação seria contra ela mesma e nunca
 * falharia. Um override pendente não dispensa: mutação de config é parada dura.
 */
test('retomada detecta alteração REAL no cadastro em disco e para com PROJECT_CONFIG_CHANGED', async () => {
  const { updateProject } = require('../../dist/projects/project-store');
  const { grantManualOverride } = require('../../dist/execution/override');
  const { saveRun, loadRun } = require('../../dist/state/run-state');
  const { loopGuardPolicyFor } = require('../helpers/policy');

  const project = makeProject();

  let rodada = 0;
  const revisaoDistinta = () => {
    rodada += 1;
    return agentResult(
      promptReviewJson('CHANGES_REQUESTED', {
        requiredActions: ['Ajuste ' + rodada + '.'],
        blockingIssues: [
          { severity: 'blocking', title: 'Item ' + rodada, description: 'Detalhe ' + rodada + '.' },
        ],
      }),
    );
  };

  const primeira = await execute(project, { codexReview: revisaoDistinta, varyingDiff: true });
  assert.equal(primeira.result.value.state, 'LOOP_GUARD_TRIGGERED');
  assert.equal(primeira.result.value.lastLoopGuard.trigger, 'MAX_ATTEMPTS_REACHED');

  // Autorização pendente: sem ela o laço nem chegaria a reavaliar na retomada.
  const concedido = grantManualOverride({
    run: primeira.result.value,
    promptId: '010-fundacao',
    justification: 'Achei que mais uma tentativa resolveria; vou tentar.',
    authorizedBy: 'teste',
    policy: loopGuardPolicyFor(project),
  });
  assert.equal(concedido.ok, true, concedido.ok ? '' : concedido.error.message);
  saveRun(concedido.value.run);

  // Alteração REAL e relevante à execução: troca a suíte de testes no disco.
  const editado = updateProject(project.id, { commands: { tests: ['npm', 'run', 'outra-suite'] } });
  assert.equal(editado.ok, true, editado.ok ? '' : editado.error.message);

  const { ports, spy } = makePorts({ codexReview: revisaoDistinta, varyingDiff: true });
  const chamadasAntes = spy.claudeCalls.length;
  const retomada = await runProject({
    projectId: project.id,
    dryRun: false,
    resumeRunId: primeira.result.value.runId,
    config: defaultGlobalConfig(),
    logger: nullLogger(),
    ports,
  });

  assert.equal(retomada.ok, true, retomada.ok ? '' : JSON.stringify(retomada.error));
  assert.equal(
    retomada.value.lastLoopGuard.trigger,
    'PROJECT_CONFIG_CHANGED',
    'a mudança real no cadastro precisa interromper a retomada',
  );
  assert.equal(
    spy.claudeCalls.length,
    chamadasAntes,
    'nenhuma tentativa nova pode rodar depois da mutação detectada',
  );

  // A autorização NÃO foi consumida: parada dura não gasta o override.
  const persistido = loadRun(project.id, primeira.result.value.runId).value;
  assert.equal(
    persistido.overrides.filter((o) => o.consumed === false).length,
    1,
    'o override pendente sobrevive a uma parada dura',
  );
  // E a política congelada continua sendo a original, não a editada.
  assert.equal(persistido.effectivePolicy.commands.tests.join(' '), 'npm test');
});

/*
 * O reverso, igualmente importante: um resave BENIGNO — que só mexe em campos
 * irrelevantes à execução, como `updatedAt` — NÃO pode ser confundido com
 * mutação. Se o hash canônico reagisse a `updatedAt`, toda retomada após um
 * simples salvamento do projeto pararia com PROJECT_CONFIG_CHANGED.
 */
test('retomada após resave benigno (updatedAt) prossegue sem falso positivo de mutação', async () => {
  const { updateProject, getProject } = require('../../dist/projects/project-store');
  const { grantManualOverride } = require('../../dist/execution/override');
  const { saveRun } = require('../../dist/state/run-state');
  const { loopGuardPolicyFor } = require('../helpers/policy');

  const project = makeProject();

  let rodada = 0;
  const revisaoDistinta = () => {
    rodada += 1;
    return agentResult(
      promptReviewJson('CHANGES_REQUESTED', {
        requiredActions: ['Ajuste ' + rodada + '.'],
        blockingIssues: [
          { severity: 'blocking', title: 'Item ' + rodada, description: 'Detalhe ' + rodada + '.' },
        ],
      }),
    );
  };

  const primeira = await execute(project, { codexReview: revisaoDistinta, varyingDiff: true });
  assert.equal(primeira.result.value.state, 'LOOP_GUARD_TRIGGERED');

  const concedido = grantManualOverride({
    run: primeira.result.value,
    promptId: '010-fundacao',
    justification: 'Ambiente ajustado à mão; mais uma tentativa deve fechar.',
    authorizedBy: 'teste',
    policy: loopGuardPolicyFor(project),
  });
  assert.equal(concedido.ok, true, concedido.ok ? '' : concedido.error.message);
  saveRun(concedido.value.run);

  // Resave que NÃO toca nenhum campo relevante à execução: só `updatedAt` muda.
  const antes = getProject(project.id).value.updatedAt;
  const resave = updateProject(project.id, { name: project.name });
  assert.equal(resave.ok, true, resave.ok ? '' : resave.error.message);
  assert.notEqual(resave.value.updatedAt, antes, 'o resave precisa de fato bumpar updatedAt');

  const { ports } = makePorts({ codexReview: revisaoDistinta, varyingDiff: true });
  const retomada = await runProject({
    projectId: project.id,
    dryRun: false,
    resumeRunId: primeira.result.value.runId,
    config: defaultGlobalConfig(),
    logger: nullLogger(),
    ports,
  });

  assert.equal(retomada.ok, true, retomada.ok ? '' : JSON.stringify(retomada.error));
  const depois = retomada.value.budgets.find((b) => b.promptId === '010-fundacao');
  assert.equal(depois.attempts, 4, 'a tentativa extra autorizada rodou: nenhum falso positivo de mutação');
  assert.equal(depois.manualOverridesUsed, 1, 'a autorização foi de fato exercida');
  assert.notEqual(
    retomada.value.lastLoopGuard.trigger,
    'PROJECT_CONFIG_CHANGED',
    'um resave benigno jamais pode ser lido como mutação de configuração',
  );
});

test('o orçamento consumido fica registrado por prompt', async () => {
  const project = makeProject();
  let rodada = 0;
  const { result } = await execute(project, {
    codexReview: () => {
      rodada += 1;
      return agentResult(
        promptReviewJson('CHANGES_REQUESTED', {
          requiredActions: ['Ação distinta ' + rodada + '.'],
          blockingIssues: [
            {
              severity: 'blocking',
              title: 'Item ' + rodada,
              description: 'Detalhe ' + rodada + '.',
            },
          ],
        }),
      );
    },
    varyingDiff: true,
  });

  const budget = result.value.budgets.find((b) => b.promptId === '010-fundacao');
  assert.ok(budget, 'cada prompt tem orçamento próprio');
  assert.equal(budget.claudeCalls, 3, 'três chamadas do executor');
  assert.equal(budget.codexCalls, 3, 'três chamadas do revisor');
  assert.equal(budget.attempts, 3);
  assert.ok(budget.diffFingerprints.length >= 3, 'assinaturas de diff registradas por tentativa');
});

test('veredito BLOCKED interrompe o prompt sem commit', async () => {
  const project = makeProject();
  const { result, spy } = await execute(project, {
    codexReview: () => agentResult(promptReviewJson('BLOCKED')),
  });

  assert.equal(result.ok, true);
  assert.equal(result.value.prompts[0].status, 'BLOCKED');
  assert.equal(spy.commits, 0);
  assert.equal(spy.merged, false);
});

test('JSON de revisão inválido não aprova e não trava a execução', async () => {
  const project = makeProject();
  const { result, spy } = await execute(project, {
    codexReview: () => agentResult('desculpe, não consegui gerar o JSON'),
  });

  assert.equal(result.ok, true);
  assert.notEqual(result.value.prompts[0].status, 'APPROVED');
  assert.equal(spy.merged, false);
});

/* ------------------------------------------------------------------------ */
/* Merge exige as DUAS IAs                                                   */
/* ------------------------------------------------------------------------ */

test('Codex indisponível na auditoria final BLOQUEIA o merge', async () => {
  const project = makeProject();
  const { result, spy } = await execute(project, {
    codexAudit: () => ({
      ok: false,
      error: { code: 'TOOL_MISSING', message: 'Codex CLI não encontrado.' },
    }),
  });

  assert.equal(result.ok, true);
  assert.equal(result.value.state, 'BLOCKED');
  assert.equal(spy.merged, false, 'nunca mergear com apenas uma aprovação');
  assert.equal(result.value.consensus.reached, false);
  assert.equal(result.value.gateReport.allPassed, false);
  assert.ok(result.value.gateReport.failedGates.includes('CODEX_MERGE_APPROVED'));
});

test('Claude bloqueando a auditoria final impede o merge', async () => {
  const project = makeProject();
  const { result, spy } = await execute(project, {
    claudeAuditOverrides: {
      verdict: 'BLOCKED',
      blockingIssues: [
        { severity: 'blocking', title: 'Regressão', description: 'quebra o login' },
      ],
    },
  });

  assert.equal(result.value.state, 'BLOCKED');
  assert.equal(spy.merged, false);
  assert.ok(result.value.gateReport.failedGates.includes('CLAUDE_MERGE_APPROVED'));
});

test('auditoria sobre SHA diferente é rejeitada e impede o merge', async () => {
  const project = makeProject();
  const { result, spy } = await execute(project, {
    codexAuditOverrides: { reviewedHeadSha: 'ffff1111222233334444555566667777888899' },
  });

  assert.equal(spy.merged, false, 'SHA divergente jamais pode mergear');
  assert.equal(result.value.state, 'BLOCKED');
});

test('confiança abaixo do mínimo impede o merge', async () => {
  const project = makeProject();
  const { result, spy } = await execute(project, {
    codexAuditOverrides: { confidence: 0.4 },
  });

  assert.equal(spy.merged, false);
  assert.equal(result.value.consensus.reached, false);
});

/* ------------------------------------------------------------------------ */
/* CI                                                                        */
/* ------------------------------------------------------------------------ */

test('CI reprovado interrompe antes da auditoria final', async () => {
  const project = makeProject();
  const { result, spy } = await execute(project, {
    checksOverrides: {
      passed: 0,
      failed: 1,
      allRequiredPassed: false,
      anyRequiredFailed: true,
    },
  });

  assert.equal(result.value.state, 'CI_FAILED');
  assert.equal(spy.merged, false);
  assert.equal(
    spy.claudeCalls.includes('merge-auditor'),
    false,
    'não faz sentido auditar para merge com o CI reprovado',
  );
});

/*
 * Orçamento da auditoria final.
 *
 * O par "auditor pede mudança / executor corrige" é um laço como qualquer
 * outro, e o mais caro de todos: cada volta gasta DUAS auditorias de IA e
 * invalida toda a evidência anterior, porque o head SHA muda.
 */
test('auditor pedindo mudanças consome o orçamento e para em MERGE_CORRECTION_BUDGET_EXHAUSTED', async () => {
  const project = makeProject();

  // O Claude nunca aprova e sempre aponta ação concreta: é o caso corrigível.
  const { result, spy } = await execute(project, {
    claudeAuditOverrides: {
      verdict: 'CHANGES_REQUIRED',
      requiredActions: ['Tratar o caso de borda do parser.'],
      blockingIssues: [
        { severity: 'blocking', title: 'Borda', description: 'Entrada vazia quebra.' },
      ],
    },
  });

  assert.equal(result.value.state, 'BLOCKED');
  assert.equal(result.value.lastLoopGuard.trigger, 'MERGE_CORRECTION_BUDGET_EXHAUSTED');
  assert.equal(spy.merged, false, 'orçamento esgotado nunca mergeia');

  // Exatamente o limite: nem uma correção a mais.
  assert.equal(result.value.mergeCorrectionCycles, 2);
  assert.equal(result.value.mergeCorrections.length, 2);
  assert.deepEqual(
    result.value.mergeCorrections.map((c) => c.cycle),
    [1, 2],
    'os ciclos são numerados e nenhum sobrescreve o outro',
  );

  // Cada correção produziu um commit próprio, preservado.
  const correcoes = result.value.commits.filter((c) => c.promptId.startsWith('merge-correction-'));
  assert.equal(correcoes.length, 2);

  // A evidência antiga não sobrevive: nada continua afirmando aprovação.
  assert.equal(result.value.consensus.reached, false);
  for (const review of result.value.mergeReviews) {
    if (review.auditor === 'claude') continue;
    assert.ok(
      review.invalidated === true || result.value.consensus.reached === false,
      'aprovação anterior não pode sobreviver a um head novo',
    );
  }

  // A PR e a branch foram preservadas para revisão humana.
  assert.ok(result.value.pullRequest, 'a PR não é fechada');
  assert.ok(result.value.branchName, 'a branch não é apagada');
});

test('artefatos de correção pós-auditoria são append-only, um diretório por ciclo', async () => {
  const project = makeProject();
  const { result } = await execute(project, {
    claudeAuditOverrides: {
      verdict: 'CHANGES_REQUIRED',
      requiredActions: ['Corrigir a validação.'],
    },
  });

  const raiz = path.join(
    HOME, 'data', 'projects', project.id, 'artifacts', result.value.runId, 'merge-corrections',
  );
  assert.deepEqual(
    fs.readdirSync(raiz).sort(),
    ['cycle-001', 'cycle-002'],
    'um diretório por ciclo, nenhum sobrescrito',
  );
  for (const ciclo of ['cycle-001', 'cycle-002']) {
    const pedido = JSON.parse(
      fs.readFileSync(path.join(raiz, ciclo, 'requested-changes.json'), 'utf8'),
    );
    assert.ok(pedido.reasons.length > 0, 'o motivo do pedido fica registrado');
    assert.ok(pedido.requestedBy.includes('claude'));
  }
});

test('bloqueio estrutural NÃO consome o orçamento de correção', async () => {
  const project = makeProject();

  // Codex ausente na auditoria é bloqueio de gate, não pedido de mudança:
  // corrigir código não resolveria, e gastar ciclos aqui seria desperdício.
  const { result, spy } = await execute(project, {
    codexAudit: () => ({
      ok: false,
      error: { code: 'TOOL_MISSING', message: 'Codex CLI não encontrado.' },
    }),
  });

  assert.equal(result.value.state, 'BLOCKED');
  assert.equal(result.value.mergeCorrectionCycles, 0, 'nenhum ciclo foi consumido');
  assert.equal(
    spy.claudeCalls.filter((r) => r === 'corrector').length,
    0,
    'nenhuma correção foi tentada',
  );
  assert.equal(spy.merged, false);
});

/* ------------------------------------------------------------------------ */
/* Política do projeto e segurança                                           */
/* ------------------------------------------------------------------------ */

test('remoto divergente impede toda a execução', async () => {
  const project = makeProject();
  const { result, spy } = await execute(project, {
    remoteUrl: 'https://github.com/outro-dono/outro-repo.git',
  });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'REMOTE_MISMATCH');
  assert.equal(spy.pushes, 0, 'nunca enviar para um remoto que não confere');
});

test('merge desabilitado no projeto conclui sem mergear', async () => {
  const project = makeProject({ merge: { enabled: false } });
  const { result, spy } = await execute(project);

  assert.equal(result.value.state, 'COMPLETED');
  assert.equal(spy.merged, false);
});

test('Claude indisponível falha com TOOL_MISSING antes de qualquer efeito', async () => {
  const project = makeProject();
  const { result, spy } = await execute(project, { claudeAvailable: false });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'TOOL_MISSING');
  assert.equal(spy.commits, 0);
  assert.equal(spy.pushes, 0);
});

/* ------------------------------------------------------------------------ */
/* Idempotência do merge                                                     */
/* ------------------------------------------------------------------------ */

test('PR já mergeada não é mergeada de novo', async () => {
  const project = makeProject();
  const { result, spy } = await execute(project, {
    freshPrOverrides: { merged: true, state: 'MERGED', mergeCommitSha: 'jamerged' },
  });

  assert.equal(result.ok, true);
  assert.equal(spy.merged, false, 'não deve executar um segundo merge');
  if (result.value.mergeOutcome) {
    assert.equal(result.value.mergeOutcome.idempotentSkip, true);
  }
});

/* ------------------------------------------------------------------------ */
/* Dry-run                                                                   */
/* ------------------------------------------------------------------------ */

test('dry-run não chama IA, não commita, não faz push e não mergeia', async () => {
  const project = makeProject();
  const { result, spy } = await execute(project, { dryRun: true });

  assert.equal(result.ok, true);
  assert.equal(result.value.state, 'COMPLETED');
  assert.equal(result.value.dryRun, true);
  assert.deepEqual(spy.claudeCalls, [], 'dry-run não pode chamar o Claude');
  assert.deepEqual(spy.codexCalls, [], 'dry-run não pode chamar o Codex');
  assert.equal(spy.commits, 0);
  assert.equal(spy.pushes, 0);
  assert.equal(spy.merged, false);
});

/* ------------------------------------------------------------------------ */
/* Retomada                                                                  */
/* ------------------------------------------------------------------------ */

test('prompt já aprovado não é reexecutado ao retomar', async () => {
  const project = makeProject();
  const first = await execute(project);
  assert.equal(first.result.value.state, 'MERGED');

  const { ports, spy } = makePorts({});
  const resumed = await runProject({
    projectId: project.id,
    dryRun: false,
    resumeRunId: first.result.value.runId,
    config: defaultGlobalConfig(),
    logger: nullLogger(),
    ports,
  });

  assert.equal(resumed.ok, true);
  assert.equal(
    spy.claudeCalls.includes('executor'),
    false,
    'prompt já aprovado não deve ser reexecutado',
  );
});
