'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'orqpeg-lg-'));
process.env.ORQPEG_HOME = HOME;
process.env.ORQPEG_NO_FILE_LOG = '1';

const {
  evaluateLoopGuard,
  assertRunCanContinue,
  createPromptBudget,
  severityOf,
  isHardStop,
} = require('../../dist/execution/loop-guard');
const {
  defaultLoopGuardConfig,
  normalizeLoopGuardConfig,
  validateLoopGuardConfig,
} = require('../../dist/execution/loop-guard-config');
const {
  diffFingerprint,
  reviewFingerprint,
  testFailureFingerprint,
  detectOscillation,
  trailingRepeatCount,
  pushBounded,
  measureDiff,
  normalizeTestOutput,
} = require('../../dist/execution/fingerprints');

/* ------------------------------------------------------------------------ */
/* Cenário base                                                              */
/* ------------------------------------------------------------------------ */

function scenario(overrides = {}) {
  const budget = { ...createPromptBudget('010-x'), ...(overrides.budget ?? {}) };
  const now = Date.now();
  return {
    config: { ...defaultLoopGuardConfig(), ...(overrides.config ?? {}) },
    budget,
    maxAttemptsPerPrompt: 3,
    nextAttempt: 2,
    nowMs: now,
    runStartedAtMs: now - 1000,

    pauseRequested: false,
    cancelRequested: false,
    aborted: false,
    lastAgentErrorCode: null,

    promptHashNow: 'p1',
    promptHashSnapshot: 'p1',
    contextHashNow: 'c1',
    contextHashSnapshot: 'c1',
    configHashNow: 'g1',
    configHashSnapshot: 'g1',

    previousDiffFingerprint: null,
    currentDiffFingerprint: 'A',
    reviewFingerprint: null,
    testFailureFingerprint: null,
    lastReview: null,

    scopeViolations: [],
    forbiddenViolations: [],
    changedFileCount: 3,
    changedLineCount: 40,
    reviewEvidenceComplete: true,
    overrideAvailable: false,
    ...overrides.top,
  };
}

function triggerOf(input) {
  return evaluateLoopGuard(input).trigger;
}

/* ------------------------------------------------------------------------ */
/* Caminho permitido                                                         */
/* ------------------------------------------------------------------------ */

test('cenário saudável autoriza a próxima tentativa', () => {
  const decision = evaluateLoopGuard(scenario());
  assert.equal(decision.allowed, true);
  assert.equal(decision.trigger, null);
  assert.equal(decision.severity, 'none');
  assert.equal(assertRunCanContinue(decision).canContinue, true);
});

/* ------------------------------------------------------------------------ */
/* Invariante: fail-closed                                                   */
/* ------------------------------------------------------------------------ */

test('decisão ausente NUNCA autoriza continuação', () => {
  assert.equal(assertRunCanContinue(null).canContinue, false);
  assert.equal(assertRunCanContinue(undefined).canContinue, false);
  assert.equal(assertRunCanContinue({}).canContinue, false);
});

test('decisão incoerente (permitida com gatilho) é recusada', () => {
  const result = assertRunCanContinue({
    allowed: true,
    trigger: 'NO_PROGRESS',
    severity: 'soft_stop',
    reason: 'x',
    evidence: {},
    nextActions: [],
  });
  assert.equal(result.canContinue, false);
  assert.match(result.reason, /inconsistente/i);
});

/* ------------------------------------------------------------------------ */
/* Orçamentos                                                                */
/* ------------------------------------------------------------------------ */

test('limite de tentativas bloqueia a quarta tentativa', () => {
  assert.equal(triggerOf(scenario({ top: { nextAttempt: 4 } })), 'MAX_ATTEMPTS_REACHED');
});

test('orçamento do Claude esgotado bloqueia', () => {
  assert.equal(
    triggerOf(scenario({ budget: { claudeCalls: 3 } })),
    'CLAUDE_CALL_BUDGET_EXHAUSTED',
  );
});

test('orçamento do Codex esgotado bloqueia', () => {
  assert.equal(triggerOf(scenario({ budget: { codexCalls: 5 } })), 'CODEX_CALL_BUDGET_EXHAUSTED');
});

test('orçamento total de chamadas de IA bloqueia', () => {
  assert.equal(
    triggerOf(scenario({ config: { maxClaudeCallsPerPrompt: 9, maxCodexCallsPerPrompt: 9 }, budget: { claudeCalls: 4, codexCalls: 4 } })),
    'AGENT_CALL_BUDGET_EXHAUSTED',
  );
});

test('tempo do prompt esgotado bloqueia', () => {
  assert.equal(
    triggerOf(scenario({ budget: { consumedMs: 91 * 60_000 } })),
    'PROMPT_TIME_BUDGET_EXHAUSTED',
  );
});

test('tempo da execução esgotado bloqueia', () => {
  const now = Date.now();
  assert.equal(
    triggerOf(scenario({ top: { nowMs: now, runStartedAtMs: now - 9 * 60 * 60_000 } })),
    'RUN_TIME_BUDGET_EXHAUSTED',
  );
});

/* ------------------------------------------------------------------------ */
/* Repetição e oscilação                                                     */
/* ------------------------------------------------------------------------ */

test('diff idêntico após correção é NO_PROGRESS', () => {
  assert.equal(
    triggerOf(
      scenario({
        budget: { diffFingerprints: ['A', 'A'] },
        top: { previousDiffFingerprint: 'A', currentDiffFingerprint: 'A' },
      }),
    ),
    'NO_PROGRESS',
  );
});

test('diff diferente após correção NÃO dispara NO_PROGRESS', () => {
  const decision = evaluateLoopGuard(
    scenario({
      budget: { diffFingerprints: ['A', 'B'] },
      top: { previousDiffFingerprint: 'A', currentDiffFingerprint: 'B' },
    }),
  );
  assert.equal(decision.allowed, true);
});

test('oscilação A → B → A do código é detectada', () => {
  assert.equal(
    triggerOf(scenario({ budget: { diffFingerprints: ['A', 'B', 'A'] } })),
    'OSCILLATION_DETECTED',
  );
});

test('mesma revisão duas vezes seguidas bloqueia', () => {
  assert.equal(
    triggerOf(scenario({ budget: { reviewFingerprints: ['R', 'R'] } })),
    'REPEATED_REVIEW_ISSUES',
  );
});

test('oscilação de revisão A → B → A é detectada', () => {
  assert.equal(
    triggerOf(scenario({ budget: { reviewFingerprints: ['R1', 'R2', 'R1'] } })),
    'REVIEW_OSCILLATION_DETECTED',
  );
});

test('mesma falha de teste duas vezes seguidas bloqueia', () => {
  assert.equal(
    triggerOf(scenario({ budget: { testFailureFingerprints: ['T', 'T'] } })),
    'REPEATED_TEST_FAILURE',
  );
});

/* ------------------------------------------------------------------------ */
/* Integridade do alvo                                                       */
/* ------------------------------------------------------------------------ */

test('prompt alterado durante a execução bloqueia', () => {
  assert.equal(
    triggerOf(scenario({ top: { promptHashNow: 'OUTRO' } })),
    'PROMPT_CHANGED_DURING_RUN',
  );
});

test('contexto do projeto alterado bloqueia', () => {
  assert.equal(triggerOf(scenario({ top: { contextHashNow: 'OUTRO' } })), 'PROJECT_CONTEXT_CHANGED');
});

test('configuração do projeto alterada bloqueia com gatilho próprio', () => {
  // Gatilho separado de PROJECT_CONTEXT_CHANGED: reaproveitar aquele mandava o
  // operador procurar PROJECT-CONTEXT.md e encontrar um arquivo intacto.
  assert.equal(triggerOf(scenario({ top: { configHashNow: 'OUTRO' } })), 'PROJECT_CONFIG_CHANGED');
});

test('PROJECT_CONFIG_CHANGED é parada dura e não admite override', () => {
  const { isOverridable } = require('../../dist/execution/override');
  assert.equal(isOverridable('PROJECT_CONFIG_CHANGED'), false);
  assert.equal(isOverridable('POLICY_SNAPSHOT_MISSING'), false);
});

/* ------------------------------------------------------------------------ */
/* Escopo                                                                    */
/* ------------------------------------------------------------------------ */

test('área proibida alterada é hard stop', () => {
  const decision = evaluateLoopGuard(scenario({ top: { forbiddenViolations: ['infra/deploy.ts'] } }));
  assert.equal(decision.trigger, 'FORBIDDEN_AREA_CHANGED');
  assert.equal(decision.severity, 'hard_stop');
  assert.equal(
    decision.nextActions.includes('AUTHORIZE_EXTRA_ATTEMPT'),
    false,
    'hard stop nunca oferece override',
  );
});

test('violação de escopo bloqueia', () => {
  assert.equal(triggerOf(scenario({ top: { scopeViolations: ['outro/lugar.ts'] } })), 'SCOPE_VIOLATION');
});

test('diff excessivo em arquivos bloqueia', () => {
  assert.equal(triggerOf(scenario({ top: { changedFileCount: 999 } })), 'DIFF_BUDGET_EXCEEDED');
});

test('diff excessivo em linhas bloqueia', () => {
  assert.equal(triggerOf(scenario({ top: { changedLineCount: 999_999 } })), 'DIFF_BUDGET_EXCEEDED');
});

test('limite null de diff desativa o teto', () => {
  const decision = evaluateLoopGuard(
    scenario({
      config: { maxChangedFilesPerPrompt: null, maxChangedLinesPerPrompt: null },
      top: { changedFileCount: 999, changedLineCount: 999_999 },
    }),
  );
  assert.equal(decision.allowed, true);
});

/* ------------------------------------------------------------------------ */
/* Qualidade da evidência                                                    */
/* ------------------------------------------------------------------------ */

test('pacote de revisão incompleto bloqueia', () => {
  assert.equal(
    triggerOf(scenario({ top: { reviewEvidenceComplete: false } })),
    'INCOMPLETE_REVIEW_EVIDENCE',
  );
});

test('retentativas de formato esgotadas bloqueiam', () => {
  assert.equal(
    triggerOf(scenario({ budget: { reviewFormatRetries: 3 } })),
    'REVIEW_FORMAT_RETRIES_EXHAUSTED',
  );
});

test('CHANGES_REQUESTED sem ação concreta é recusado', () => {
  const vago = {
    verdict: 'CHANGES_REQUESTED',
    blockingIssues: [],
    nonBlockingIssues: [],
    requiredActions: [],
    scopeAssessment: { withinScope: true, unexpectedChanges: [] },
  };
  assert.equal(triggerOf(scenario({ top: { lastReview: vago } })), 'INVALID_CHANGES_REQUEST');
});

test('CHANGES_REQUESTED com ação concreta é aceito', () => {
  const concreto = {
    verdict: 'CHANGES_REQUESTED',
    blockingIssues: [],
    nonBlockingIssues: [],
    requiredActions: ['Tratar o caso nulo em X.'],
    scopeAssessment: { withinScope: true, unexpectedChanges: [] },
  };
  assert.equal(evaluateLoopGuard(scenario({ top: { lastReview: concreto } })).allowed, true);
});

/* ------------------------------------------------------------------------ */
/* Erros de agente nunca viram retentativa                                   */
/* ------------------------------------------------------------------------ */

test('autenticação, cota, ferramenta e timeout param sem retentativa', () => {
  const casos = [
    ['AUTH_REQUIRED', 'AUTH_REQUIRED'],
    ['USAGE_LIMIT_REACHED', 'USAGE_LIMIT_REACHED'],
    ['TOOL_MISSING', 'TOOL_MISSING'],
    ['PROCESS_TIMEOUT', 'PROCESS_TIMEOUT'],
  ];
  for (const [code, esperado] of casos) {
    const decision = evaluateLoopGuard(scenario({ top: { lastAgentErrorCode: code } }));
    assert.equal(decision.trigger, esperado, `código ${code}`);
    assert.equal(decision.allowed, false);
  }
});

test('erro comum de código NÃO é tratado como gatilho de agente', () => {
  assert.equal(evaluateLoopGuard(scenario({ top: { lastAgentErrorCode: 'TESTS_FAILED' } })).allowed, true);
});

/* ------------------------------------------------------------------------ */
/* Interrupção humana                                                        */
/* ------------------------------------------------------------------------ */

test('pausa e cancelamento impedem a próxima etapa', () => {
  assert.equal(triggerOf(scenario({ top: { pauseRequested: true } })), 'USER_PAUSED');
  assert.equal(triggerOf(scenario({ top: { cancelRequested: true } })), 'USER_CANCELLED');
  assert.equal(triggerOf(scenario({ top: { aborted: true } })), 'USER_PAUSED');
});

test('cancelamento tem precedência sobre pausa', () => {
  assert.equal(
    triggerOf(scenario({ top: { pauseRequested: true, cancelRequested: true } })),
    'USER_CANCELLED',
  );
});

/* ------------------------------------------------------------------------ */
/* Severidade e override                                                     */
/* ------------------------------------------------------------------------ */

test('hard stops nunca oferecem tentativa adicional', () => {
  const duros = [
    'AUTH_REQUIRED', 'USAGE_LIMIT_REACHED', 'TOOL_MISSING', 'FORBIDDEN_AREA_CHANGED',
    'PROMPT_CHANGED_DURING_RUN', 'PROJECT_CONTEXT_CHANGED', 'INCOMPLETE_REVIEW_EVIDENCE',
    'SCOPE_VIOLATION', 'DIFF_BUDGET_EXCEEDED',
  ];
  for (const trigger of duros) {
    assert.equal(severityOf(trigger), 'hard_stop', trigger);
    assert.equal(isHardStop(trigger), true, trigger);
  }
});

/*
 * `overrideAvailable` significa "existe autorização CONCEDIDA e ainda não
 * consumida", não "seria possível pedir uma". Por isso ele libera a passagem
 * em vez de apenas sugerir a ação.
 */
test('soft stop com autorização concedida libera a tentativa', () => {
  const decision = evaluateLoopGuard(
    scenario({
      budget: { testFailureFingerprints: ['T', 'T'] },
      top: { overrideAvailable: true },
    }),
  );
  assert.equal(decision.allowed, true);
  assert.equal(decision.trigger, null);
  assert.equal(decision.evidence.overrideApplied, true);
  assert.equal(decision.evidence.suppressedTrigger, 'REPEATED_TEST_FAILURE');
});

test('soft stop sem autorização bloqueia e OFERECE pedir uma', () => {
  const decision = evaluateLoopGuard(
    scenario({ budget: { testFailureFingerprints: ['T', 'T'] }, top: { overrideAvailable: false } }),
  );
  assert.equal(decision.allowed, false);
  assert.equal(decision.severity, 'soft_stop');
  assert.ok(
    decision.nextActions.includes('AUTHORIZE_EXTRA_ATTEMPT'),
    'com orçamento de override livre, a ação deve ser oferecida',
  );
});

test('override já usado não é oferecido de novo', () => {
  const decision = evaluateLoopGuard(
    scenario({
      budget: { testFailureFingerprints: ['T', 'T'], manualOverridesUsed: 1 },
      top: { overrideAvailable: false },
    }),
  );
  assert.equal(decision.allowed, false);
  assert.equal(
    decision.nextActions.includes('AUTHORIZE_EXTRA_ATTEMPT'),
    false,
    'o orçamento de override do prompt já foi consumido',
  );
});

/* ------------------------------------------------------------------------ */
/* Guarda desativada ainda respeita limites duros                            */
/* ------------------------------------------------------------------------ */

test('desativar a guarda NÃO libera laço infinito', () => {
  const off = { enabled: false };
  assert.equal(
    triggerOf(scenario({ config: off, top: { nextAttempt: 9 } })),
    'MAX_ATTEMPTS_REACHED',
    'o teto de tentativas permanece',
  );
  assert.equal(
    triggerOf(scenario({ config: off, top: { cancelRequested: true } })),
    'USER_CANCELLED',
    'interrupção humana permanece',
  );
  assert.equal(
    triggerOf(scenario({ config: off, top: { lastAgentErrorCode: 'USAGE_LIMIT_REACHED' } })),
    'USAGE_LIMIT_REACHED',
    'limite de assinatura permanece',
  );
});

/* ------------------------------------------------------------------------ */
/* Configuração                                                              */
/* ------------------------------------------------------------------------ */

test('normalização corrige valores fora de faixa em vez de aceitá-los', () => {
  const c = normalizeLoopGuardConfig({ maxClaudeCallsPerPrompt: 0, maxPromptDurationMinutes: -5 });
  assert.ok(c.maxClaudeCallsPerPrompt >= 1, 'zero chamada travaria a execução');
  assert.ok(c.maxPromptDurationMinutes >= 1);
});

test('normalização preserva null explícito do teto de diff', () => {
  const c = normalizeLoopGuardConfig({ maxChangedFilesPerPrompt: null });
  assert.equal(c.maxChangedFilesPerPrompt, null);
});

test('configuração ausente assume os padrões seguros', () => {
  const c = normalizeLoopGuardConfig(undefined);
  assert.equal(c.enabled, true);
  assert.equal(c.maxClaudeCallsPerPrompt, 3);
  assert.equal(c.maxManualOverridesPerPrompt, 1);
});

test('combinação incoerente de limites é reportada', () => {
  const c = { ...defaultLoopGuardConfig(), maxTotalAgentCallsPerPrompt: 2, maxClaudeCallsPerPrompt: 5 };
  assert.ok(validateLoopGuardConfig(c).length > 0);
  assert.equal(validateLoopGuardConfig(defaultLoopGuardConfig()).length, 0);
});

/* ------------------------------------------------------------------------ */
/* Fingerprints                                                              */
/* ------------------------------------------------------------------------ */

test('diff igual em bases diferentes produz a mesma assinatura', () => {
  const a = 'diff --git a/x.ts b/x.ts\nindex 111..222\n@@ -1,3 +1,4 @@\n contexto\n+nova linha\n';
  const b = 'diff --git a/x.ts b/x.ts\nindex 999..888\n@@ -40,3 +40,4 @@\n outro contexto\n+nova linha\n';
  assert.equal(diffFingerprint(a), diffFingerprint(b));
});

test('diff diferente produz assinatura diferente', () => {
  const a = 'diff --git a/x.ts b/x.ts\n@@\n+linha A\n';
  const b = 'diff --git a/x.ts b/x.ts\n@@\n+linha B\n';
  assert.notEqual(diffFingerprint(a), diffFingerprint(b));
});

test('diff vazio tem assinatura própria', () => {
  assert.equal(diffFingerprint(''), 'empty');
});

test('measureDiff conta arquivos e linhas', () => {
  const patch = 'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@\n+um\n-dois\ndiff --git a/b.ts b/b.ts\n@@\n+tres\n';
  const m = measureDiff(patch);
  assert.equal(m.files, 2);
  assert.equal(m.lines, 3);
});

test('mesma falha com timestamp e caminho temporário diferentes tem a mesma assinatura', () => {
  const build = (ts, tmp, dur) => ({
    passed: false,
    status: 'FAILED',
    commands: [
      {
        command: 'npm test',
        status: 'FAILED',
        exitCode: 1,
        stdout: `${ts} falhou em ${tmp} apos ${dur}`,
        stderr: '',
      },
    ],
  });
  const a = build('2026-07-22T01:00:00.000Z', 'C:\\Users\\x\\AppData\\Local\\Temp\\abc', '12ms');
  const b = build('2026-07-23T09:31:11.000Z', 'C:\\Users\\x\\AppData\\Local\\Temp\\zzz', '87ms');
  assert.equal(testFailureFingerprint(a), testFailureFingerprint(b));
});

test('suíte aprovada não tem assinatura de falha', () => {
  assert.equal(testFailureFingerprint({ passed: true, status: 'PASSED', commands: [] }), null);
});

test('mesma revisão em ordem diferente tem a mesma assinatura', () => {
  const issue = (t) => ({ severity: 'blocking', title: t, description: 'desc ' + t });
  const a = { verdict: 'CHANGES_REQUESTED', blockingIssues: [issue('X'), issue('Y')], nonBlockingIssues: [], requiredActions: ['ação 1', 'ação 2'] };
  const b = { verdict: 'CHANGES_REQUESTED', blockingIssues: [issue('Y'), issue('X')], nonBlockingIssues: [], requiredActions: ['ação 2', 'ação 1'] };
  assert.equal(reviewFingerprint(a), reviewFingerprint(b));
});

test('variação de pontuação e caixa não muda a assinatura da revisão', () => {
  const a = { verdict: 'CHANGES_REQUESTED', blockingIssues: [{ severity: 'blocking', title: 'Falta teste', description: 'Adicione um teste.' }], nonBlockingIssues: [], requiredActions: [] };
  const b = { verdict: 'CHANGES_REQUESTED', blockingIssues: [{ severity: 'blocking', title: 'falta teste!!', description: 'adicione   um teste' }], nonBlockingIssues: [], requiredActions: [] };
  assert.equal(reviewFingerprint(a), reviewFingerprint(b));
});

test('normalizeTestOutput remove variação incidental', () => {
  const s = normalizeTestOutput('Erro em 2026-07-22T01:00:00Z apos 123ms na porta 51234 uuid 550e8400-e29b-41d4-a716-446655440000');
  assert.ok(s.includes('<ts>'));
  assert.ok(s.includes('<dur>'));
  assert.ok(s.includes('<uuid>'));
  assert.equal(/\b51234\b/.test(s), false);
});

test('detectOscillation reconhece A → B → A e ignora A → A → A', () => {
  assert.equal(detectOscillation(['A', 'B', 'A']), true);
  assert.equal(detectOscillation(['A', 'A', 'A']), false);
  assert.equal(detectOscillation(['A', 'B']), false);
});

test('trailingRepeatCount conta apenas a cauda', () => {
  assert.equal(trailingRepeatCount(['A', 'B', 'B', 'B']), 3);
  assert.equal(trailingRepeatCount(['B', 'B', 'A']), 1);
  assert.equal(trailingRepeatCount([]), 0);
});

test('pushBounded nunca deixa o histórico crescer sem teto', () => {
  let h = [];
  for (let i = 0; i < 50; i += 1) h = pushBounded(h, 'v' + i, 5);
  assert.equal(h.length, 5);
  assert.equal(h[4], 'v49');
});

/* ------------------------------------------------------------------------ */
/* Invariante global: nenhum cenário produz laço infinito                    */
/* ------------------------------------------------------------------------ */

test('MATRIZ: nenhuma combinação permite exceder o orçamento de chamadas', () => {
  const config = defaultLoopGuardConfig();
  let permitidasAlemDoOrcamento = 0;

  for (let claude = 0; claude <= 6; claude += 1) {
    for (let codex = 0; codex <= 8; codex += 1) {
      for (let attempt = 1; attempt <= 6; attempt += 1) {
        const decision = evaluateLoopGuard(
          scenario({ budget: { claudeCalls: claude, codexCalls: codex }, top: { nextAttempt: attempt } }),
        );
        const excedeu =
          claude >= config.maxClaudeCallsPerPrompt ||
          codex >= config.maxCodexCallsPerPrompt ||
          claude + codex >= config.maxTotalAgentCallsPerPrompt ||
          attempt > 3;
        if (decision.allowed && excedeu) permitidasAlemDoOrcamento += 1;
      }
    }
  }

  assert.equal(
    permitidasAlemDoOrcamento,
    0,
    'nenhuma combinação pode autorizar chamada além do orçamento configurado',
  );
});

test('MATRIZ: todo cenário de parada termina com gatilho nomeado e ações', () => {
  const cenarios = [
    { top: { nextAttempt: 9 } },
    { budget: { claudeCalls: 99 } },
    { budget: { codexCalls: 99 } },
    { budget: { consumedMs: 999 * 60_000 } },
    { budget: { diffFingerprints: ['A', 'B', 'A'] } },
    { budget: { reviewFingerprints: ['R', 'R'] } },
    { budget: { testFailureFingerprints: ['T', 'T'] } },
    { top: { promptHashNow: 'z' } },
    { top: { contextHashNow: 'z' } },
    { top: { scopeViolations: ['a.ts'] } },
    { top: { forbiddenViolations: ['b.ts'] } },
    { top: { changedFileCount: 9999 } },
    { top: { reviewEvidenceComplete: false } },
    { top: { lastAgentErrorCode: 'AUTH_REQUIRED' } },
    { top: { cancelRequested: true } },
  ];

  for (const overrides of cenarios) {
    const decision = evaluateLoopGuard(scenario(overrides));
    assert.equal(decision.allowed, false, JSON.stringify(overrides));
    assert.ok(decision.trigger, 'gatilho precisa ser nomeado');
    assert.ok(decision.reason.length > 20, 'motivo precisa ser explicativo');
    assert.ok(['soft_stop', 'hard_stop'].includes(decision.severity));
    assert.ok(decision.nextActions.length > 0, 'toda parada oferece caminho adiante');
    assert.equal(assertRunCanContinue(decision).canContinue, false);
  }
});

/**
 * Todo gatilho precisa ter rótulo em português no painel.
 *
 * Sem esta trava, um gatilho novo degrada em silêncio: o painel cai no padrão
 * e mostra "Motivo não catalogado" ou um traço, justamente para a parada mais
 * recente — a que ninguém ainda sabe ler. A parada não fica anônima (o código
 * do gatilho aparece), mas a única frase que a explica em português fica vazia.
 *
 * Seis gatilhos já estavam sem rótulo quando isto foi escrito. O teste existe
 * para que o sétimo reprove em vez de passar.
 */
test('todo LoopGuardTrigger tem rótulo no painel', () => {
  const raizRepo = path.resolve(__dirname, '..', '..');

  const uniao = fs
    .readFileSync(path.join(raizRepo, 'src', 'types.ts'), 'utf8')
    .match(/export type LoopGuardTrigger =([\s\S]*?);\n/);
  assert.ok(uniao, 'a união LoopGuardTrigger precisa ser localizável em src/types.ts');
  const gatilhos = [...uniao[1].matchAll(/'([A-Z_]+)'/g)].map((m) => m[1]);
  assert.ok(gatilhos.length > 20, `esperava dezenas de gatilhos, achei ${gatilhos.length}`);

  const mapa = fs
    .readFileSync(path.join(raizRepo, 'public', 'assets', 'app.js'), 'utf8')
    .match(/LOOP_TRIGGER_LABEL\s*=\s*\{([\s\S]*?)\n\s*\};/);
  assert.ok(mapa, 'LOOP_TRIGGER_LABEL precisa ser localizável em public/assets/app.js');
  const rotulados = new Set([...mapa[1].matchAll(/([A-Z_]{4,}):/g)].map((m) => m[1]));

  assert.deepEqual(
    gatilhos.filter((gatilho) => !rotulados.has(gatilho)),
    [],
    'gatilho sem rótulo aparece no painel como "Motivo não catalogado"',
  );
});
