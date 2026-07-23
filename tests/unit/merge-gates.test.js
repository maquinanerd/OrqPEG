'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { evaluateGates, GATE_DEFINITIONS } = require('../../dist/merge/gates');
const { computeConsensus } = require('../../dist/merge/consensus');

/* ------------------------------------------------------------------------ */
/* Construtores de cenário                                                   */
/* ------------------------------------------------------------------------ */

const HEAD = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const BASE = '0000111122223333444455556666777788889999';

function project(overrides = {}) {
  return {
    id: 'demo',
    name: 'Demo',
    repositoryPath: 'E:\\Projetos\\Demo',
    githubRepository: 'maquinanerd/demo',
    remote: 'origin',
    baseBranch: 'main',
    branchStrategy: 'per_run',
    worktree: { enabled: true, rootPath: 'E:\\AI-Worktrees', reuseWhenSafe: true },
    commands: { install: [], tests: ['npm test'], timeoutSeconds: 1800 },
    execution: {
      maxAttemptsPerPrompt: 3,
      maxReviewerRetries: 2,
      continueAfterApproval: true,
      stopOnBlocked: true,
    },
    git: { commitAfterApproval: true, pushAfterRun: true, commitMessagePrefix: 'orqpeg:' },
    pullRequest: {
      enabled: true,
      draftDuringExecution: true,
      markReadyBeforeMerge: true,
      waitForChecks: true,
    },
    merge: {
      enabled: true,
      mode: 'dual_ai_consensus',
      strategy: 'squash',
      deleteBranchAfterMerge: false,
      requireClaudeApproval: true,
      requireCodexApproval: true,
      requireLocalTests: true,
      requireCiSuccess: true,
      requireNoConflicts: true,
      requireNoUnresolvedThreads: true,
      invalidateApprovalOnHeadChange: true,
      minimumConfidence: 0.9,
      ...(overrides.merge ?? {}),
    },
    agents: { claudeModel: null, codexModel: null },
    ...overrides,
  };
}

function run(overrides = {}) {
  return {
    schemaVersion: 1,
    runId: 'run-20260721-120000-abcd',
    projectId: 'demo',
    state: 'MERGE_CONSENSUS_PENDING',
    previousState: null,
    createdAt: '2026-07-21T12:00:00.000Z',
    updatedAt: '2026-07-21T12:30:00.000Z',
    finishedAt: null,
    dryRun: false,
    baseCommitSha: BASE,
    branchName: 'orqpeg/demo/run-20260721-120000',
    worktreePath: 'E:\\AI-Worktrees\\demo\\run-1',
    workingDirectory: 'E:\\AI-Worktrees\\demo\\run-1',
    prompts: [
      {
        promptId: '010-fundacao',
        status: 'APPROVED',
        attempts: 1,
        lastAttemptAt: '2026-07-21T12:05:00.000Z',
        approvedAt: '2026-07-21T12:10:00.000Z',
        commitSha: 'aaaa111',
        lastVerdict: 'APPROVED',
        blockingIssueCount: 0,
      },
    ],
    currentPromptId: null,
    currentAttempt: 1,
    commits: [
      { promptId: '010-fundacao', sha: 'aaaa111', message: 'orqpeg: demo', at: '2026-07-21T12:10:00.000Z' },
    ],
    pushedAt: '2026-07-21T12:15:00.000Z',
    pushedRemote: 'origin',
    pullRequest: null,
    checks: null,
    finalTests: null,
    mergeReviews: [],
    consensus: null,
    gateReport: null,
    mergeOutcome: null,
    events: [],
    lastError: null,
    pauseRequested: false,
    cancelRequested: false,
    ...overrides,
  };
}

function pullRequest(overrides = {}) {
  return {
    number: 7,
    url: 'https://github.com/maquinanerd/demo/pull/7',
    title: 'orqpeg: demo',
    state: 'OPEN',
    isDraft: false,
    baseRefName: 'main',
    headRefName: 'orqpeg/demo/run-20260721-120000',
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

function checks(overrides = {}) {
  return {
    headSha: HEAD,
    total: 2,
    passed: 2,
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

function tests(overrides = {}) {
  return {
    status: 'PASSED',
    passed: true,
    startedAt: '2026-07-21T12:12:00.000Z',
    finishedAt: '2026-07-21T12:14:00.000Z',
    durationMs: 120000,
    // Uma suíte sem nenhum comando executado não é evidência de teste: o gate
    // 7 reprova esse caso de propósito, então o cenário feliz traz um comando.
    commands: [
      {
        command: 'npm test',
        cwd: 'E:\\AI-Worktrees\\demo\\run-1',
        status: 'PASSED',
        exitCode: 0,
        startedAt: '2026-07-21T12:12:00.000Z',
        finishedAt: '2026-07-21T12:14:00.000Z',
        durationMs: 120000,
        stdout: 'ok',
        stderr: '',
      },
    ],
    failedCommands: [],
    ...overrides,
  };
}

function review(auditor, overrides = {}) {
  // `review` é mesclado campo a campo; o restante de `overrides` é aplicado no
  // nível do registro. Separar os dois evita que o parcial sobrescreva o todo.
  const { review: reviewOverrides, ...recordOverrides } = overrides;
  return {
    auditor,
    review: {
      verdict: 'APPROVED_FOR_MERGE',
      reviewedHeadSha: HEAD,
      summary: 'Implementação coerente com o escopo.',
      confidence: 0.96,
      blockingIssues: [],
      nonBlockingIssues: [],
      requiredActions: [],
      riskAssessment: { level: 'low', summary: 'Risco residual baixo.' },
      testsAssessment: { localTestsPassed: true, ciPassed: true, coverageAcceptable: true },
      scopeAssessment: { withinScope: true, unexpectedChanges: [] },
      ...(reviewOverrides ?? {}),
    },
    producedAt: '2026-07-21T12:20:00.000Z',
    observedHeadSha: reviewOverrides?.reviewedHeadSha ?? HEAD,
    rawOutputPath: null,
    invalidated: false,
    invalidationReason: null,
    ...recordOverrides,
  };
}

function happyPath(overrides = {}) {
  return {
    project: project(),
    run: run(),
    pr: pullRequest(),
    checks: checks(),
    finalTests: tests(),
    currentHeadSha: HEAD,
    currentBaseSha: BASE,
    claudeReview: review('claude'),
    codexReview: review('codex'),
    ...overrides,
  };
}

/* ------------------------------------------------------------------------ */
/* Definição dos gates                                                       */
/* ------------------------------------------------------------------------ */

test('existem exatamente 20 gates, numerados de 1 a 20 sem repetição', () => {
  assert.equal(GATE_DEFINITIONS.length, 20);
  const indices = GATE_DEFINITIONS.map((g) => g.index).sort((a, b) => a - b);
  assert.deepEqual(indices, Array.from({ length: 20 }, (_, i) => i + 1));
  assert.equal(new Set(GATE_DEFINITIONS.map((g) => g.id)).size, 20);
});

/* ------------------------------------------------------------------------ */
/* Caminho feliz                                                             */
/* ------------------------------------------------------------------------ */

test('cenário completo e correto aprova todos os gates', () => {
  const report = evaluateGates(happyPath());
  const failed = report.gates.filter((g) => g.status === 'FAILED');
  assert.deepEqual(
    failed.map((g) => g.id),
    [],
    `gates reprovados inesperadamente: ${failed.map((g) => `${g.id} (${g.reason})`).join(', ')}`,
  );
  assert.equal(report.allPassed, true);
  assert.equal(report.gates.length, 20);
  assert.equal(
    report.gates.some((g) => g.status === 'NOT_EVALUATED'),
    false,
    'todos os gates devem ser avaliados',
  );
});

/* ------------------------------------------------------------------------ */
/* Fail-closed: dado ausente reprova                                         */
/* ------------------------------------------------------------------------ */

test('PR ausente reprova os gates que dependem dela', () => {
  const report = evaluateGates(happyPath({ pr: null }));
  assert.equal(report.allPassed, false);
  for (const id of ['PR_OPEN', 'PR_BASE_CORRECT', 'NO_CONFLICTS', 'NO_UNRESOLVED_THREADS']) {
    assert.ok(report.failedGates.includes(id), `${id} deveria reprovar sem PR`);
  }
});

test('checks ausentes reprovam os gates de CI', () => {
  const report = evaluateGates(happyPath({ checks: null }));
  assert.equal(report.allPassed, false);
  for (const id of ['REQUIRED_CHECKS_PASSED', 'NO_PENDING_REQUIRED_CHECKS', 'NO_SKIPPED_REQUIRED_CHECKS']) {
    assert.ok(report.failedGates.includes(id), `${id} deveria reprovar sem dados de CI`);
  }
});

test('testes locais ausentes reprovam LOCAL_TESTS_PASSED', () => {
  const report = evaluateGates(happyPath({ finalTests: null }));
  assert.ok(report.failedGates.includes('LOCAL_TESTS_PASSED'));
  assert.equal(report.allPassed, false);
});

test('threads não resolvidas desconhecidas (-1) reprovam', () => {
  const report = evaluateGates(
    happyPath({ pr: pullRequest({ unresolvedThreadCount: -1 }) }),
  );
  assert.ok(
    report.failedGates.includes('NO_UNRESOLVED_THREADS'),
    'contagem desconhecida deve ser tratada como reprovação',
  );
});

test('mergeable UNKNOWN reprova NO_CONFLICTS', () => {
  const report = evaluateGates(happyPath({ pr: pullRequest({ mergeable: 'UNKNOWN' }) }));
  assert.ok(report.failedGates.includes('NO_CONFLICTS'));
});

test('conflito real reprova NO_CONFLICTS', () => {
  const report = evaluateGates(happyPath({ pr: pullRequest({ mergeable: 'CONFLICTING' }) }));
  assert.ok(report.failedGates.includes('NO_CONFLICTS'));
});

/* ------------------------------------------------------------------------ */
/* Uma IA só nunca basta                                                     */
/* ------------------------------------------------------------------------ */

test('apenas o Claude aprovando NÃO libera o merge', () => {
  const report = evaluateGates(happyPath({ codexReview: null }));
  assert.equal(report.allPassed, false);
  assert.ok(report.failedGates.includes('CODEX_MERGE_APPROVED'));
});

test('apenas o Codex aprovando NÃO libera o merge', () => {
  const report = evaluateGates(happyPath({ claudeReview: null }));
  assert.equal(report.allPassed, false);
  assert.ok(report.failedGates.includes('CLAUDE_MERGE_APPROVED'));
});

test('auditorias sobre SHAs diferentes reprovam AUDITORS_SAME_HEAD_SHA', () => {
  const outro = 'ffffeeeeddddccccbbbbaaaa99998888777766';
  const report = evaluateGates(
    happyPath({
      codexReview: review('codex', { review: { reviewedHeadSha: outro } }),
    }),
  );
  assert.equal(report.allPassed, false);
  assert.ok(report.failedGates.includes('AUDITORS_SAME_HEAD_SHA'));
});

test('confiança abaixo do mínimo reprova MINIMUM_CONFIDENCE_MET', () => {
  const report = evaluateGates(
    happyPath({ codexReview: review('codex', { review: { confidence: 0.5 } }) }),
  );
  assert.ok(report.failedGates.includes('MINIMUM_CONFIDENCE_MET'));
});

test('problema bloqueador em qualquer auditoria reprova NO_BLOCKING_ISSUES', () => {
  const report = evaluateGates(
    happyPath({
      claudeReview: review('claude', {
        review: {
          blockingIssues: [
            { severity: 'blocking', title: 'SQL injection', description: 'entrada não sanitizada' },
          ],
        },
      }),
    }),
  );
  assert.ok(report.failedGates.includes('NO_BLOCKING_ISSUES'));
  assert.equal(report.allPassed, false);
});

test('veredito CHANGES_REQUIRED reprova o gate do auditor correspondente', () => {
  const report = evaluateGates(
    happyPath({ claudeReview: review('claude', { review: { verdict: 'CHANGES_REQUIRED' } }) }),
  );
  assert.ok(report.failedGates.includes('CLAUDE_MERGE_APPROVED'));
});

/* ------------------------------------------------------------------------ */
/* Invalidação por mudança de SHA                                            */
/* ------------------------------------------------------------------------ */

test('head SHA diferente do revisado reprova HEAD_SHA_UNCHANGED', () => {
  const novo = 'bbbbccccddddeeeeffff0000111122223333444455';
  const report = evaluateGates(
    happyPath({ pr: pullRequest({ headSha: novo }), currentHeadSha: novo }),
  );
  assert.equal(report.allPassed, false);
  assert.ok(
    report.failedGates.includes('AUDITORS_SAME_HEAD_SHA') ||
      report.failedGates.includes('HEAD_SHA_UNCHANGED'),
  );
});

test('auditoria invalidada reprova HEAD_SHA_UNCHANGED', () => {
  const report = evaluateGates(
    happyPath({
      claudeReview: review('claude', {
        invalidated: true,
        invalidationReason: 'novo commit enviado',
      }),
    }),
  );
  assert.equal(report.allPassed, false);
  assert.ok(report.failedGates.includes('HEAD_SHA_UNCHANGED'));
});

/* ------------------------------------------------------------------------ */
/* CI e revisão humana                                                       */
/* ------------------------------------------------------------------------ */

test('check obrigatório pendente reprova', () => {
  const report = evaluateGates(
    happyPath({
      checks: checks({ pending: 1, anyRequiredPending: true, allRequiredPassed: false }),
    }),
  );
  assert.ok(report.failedGates.includes('NO_PENDING_REQUIRED_CHECKS'));
});

test('check obrigatório ignorado reprova', () => {
  const report = evaluateGates(
    happyPath({
      checks: checks({ skipped: 1, anyRequiredSkipped: true, allRequiredPassed: false }),
    }),
  );
  assert.ok(report.failedGates.includes('NO_SKIPPED_REQUIRED_CHECKS'));
});

test('revisão humana pedindo mudanças reprova', () => {
  const report = evaluateGates(
    happyPath({ pr: pullRequest({ reviewDecision: 'CHANGES_REQUESTED' }) }),
  );
  assert.ok(report.failedGates.includes('NO_HUMAN_CHANGES_REQUESTED'));
});

test('base incorreta da PR reprova', () => {
  const report = evaluateGates(happyPath({ pr: pullRequest({ baseRefName: 'develop' }) }));
  assert.ok(report.failedGates.includes('PR_BASE_CORRECT'));
});

test('PR já fechada reprova PR_OPEN', () => {
  const report = evaluateGates(happyPath({ pr: pullRequest({ state: 'CLOSED' }) }));
  assert.ok(report.failedGates.includes('PR_OPEN'));
});

/* ------------------------------------------------------------------------ */
/* Prompts e política do projeto                                             */
/* ------------------------------------------------------------------------ */

test('prompt não aprovado reprova ALL_PROMPTS_APPROVED', () => {
  const r = run();
  r.prompts[0].status = 'CHANGES_REQUESTED';
  const report = evaluateGates(happyPath({ run: r }));
  assert.ok(report.failedGates.includes('ALL_PROMPTS_APPROVED'));
});

test('modo de merge diferente de dual_ai_consensus reprova o gate 20', () => {
  const report = evaluateGates(
    happyPath({ project: project({ merge: { mode: 'manual' } }) }),
  );
  assert.ok(report.failedGates.includes('PROJECT_ALLOWS_DUAL_AI_CONSENSUS'));
});

test('merge desabilitado reprova o gate 20', () => {
  const report = evaluateGates(happyPath({ project: project({ merge: { enabled: false } }) }));
  assert.ok(report.failedGates.includes('PROJECT_ALLOWS_DUAL_AI_CONSENSUS'));
});

test('branch não enviada reprova BRANCH_PUSHED_TO_CORRECT_REMOTE', () => {
  const report = evaluateGates(happyPath({ run: run({ pushedAt: null, pushedRemote: null }) }));
  assert.ok(report.failedGates.includes('BRANCH_PUSHED_TO_CORRECT_REMOTE'));
});

/* ------------------------------------------------------------------------ */
/* Consenso                                                                  */
/* ------------------------------------------------------------------------ */

test('consenso é alcançado quando ambas aprovam o mesmo SHA com confiança suficiente', () => {
  const consensus = computeConsensus({
    project: project(),
    currentHeadSha: HEAD,
    claude: review('claude'),
    codex: review('codex'),
  });
  assert.equal(consensus.reached, true);
  assert.equal(consensus.sameHeadSha, true);
  assert.equal(consensus.claude.verdict, 'APPROVED_FOR_MERGE');
  assert.equal(consensus.codex.verdict, 'APPROVED_FOR_MERGE');
});

test('consenso falha quando falta o Codex, com motivo explícito', () => {
  const consensus = computeConsensus({
    project: project(),
    currentHeadSha: HEAD,
    claude: review('claude'),
    codex: null,
  });
  assert.equal(consensus.reached, false);
  assert.ok(consensus.reasons.length > 0);
});

test('consenso falha quando os SHAs revisados divergem', () => {
  const consensus = computeConsensus({
    project: project(),
    currentHeadSha: HEAD,
    claude: review('claude'),
    codex: review('codex', { review: { reviewedHeadSha: 'ffff000011112222333344445555666677778888' } }),
  });
  assert.equal(consensus.reached, false);
  assert.equal(consensus.sameHeadSha, false);
});

test('consenso falha quando uma auditoria foi invalidada', () => {
  const consensus = computeConsensus({
    project: project(),
    currentHeadSha: HEAD,
    claude: review('claude', { invalidated: true, invalidationReason: 'head mudou' }),
    codex: review('codex'),
  });
  assert.equal(consensus.reached, false);
});

test('consenso falha quando a confiança fica abaixo do mínimo', () => {
  const consensus = computeConsensus({
    project: project(),
    currentHeadSha: HEAD,
    claude: review('claude', { review: { confidence: 0.89 } }),
    codex: review('codex'),
  });
  assert.equal(consensus.reached, false);
});
