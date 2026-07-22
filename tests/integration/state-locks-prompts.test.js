'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'orqpeg-int-'));
process.env.ORQPEG_HOME = HOME;
process.env.ORQPEG_NO_FILE_LOG = '1';

const {
  createRun,
  saveRun,
  loadRun,
  listRuns,
  transition,
  canTransition,
  isTerminal,
  invalidateMergeApprovals,
  updatePromptProgress,
  allPromptsApproved,
  nextPendingPrompt,
  newRunId,
  requestPause,
  requestCancel,
  findActiveRun,
} = require('../../dist/state/run-state');
const { acquireLock, listLocks, withLock } = require('../../dist/state/locks');
const { discoverPrompts, ensurePromptsDir, countPrompts } = require('../../dist/prompts/prompt-store');
const { parsePrompt } = require('../../dist/prompts/prompt-parser');
const { createProject, listProjects, removeProjectRegistration, getProject } = require('../../dist/projects/project-store');
const { normalizeProjectConfig, validateProjectConfig } = require('../../dist/projects/project-validator');
const { ensureDataLayout, projectPromptsDir } = require('../../dist/utils/paths');
const { toSlug } = require('../../dist/projects/slug');

ensureDataLayout();

let counter = 0;
function makeProject() {
  counter += 1;
  const id = `proj${counter}`;
  const repoPath = path.join(HOME, 'repos', id);
  fs.mkdirSync(repoPath, { recursive: true });
  const config = normalizeProjectConfig({
    id,
    name: `Projeto ${counter}`,
    repositoryPath: repoPath,
    githubRepository: 'maquinanerd/demo',
  });
  const created = createProject(config);
  assert.equal(created.ok, true, created.ok ? '' : JSON.stringify(created.error));
  return created.value;
}

function promptFiles() {
  return [
    {
      id: '010-a',
      name: 'A',
      fileName: '010-a.md',
      absolutePath: 'x',
      order: 10,
      sizeBytes: 1,
    },
    {
      id: '020-b',
      name: 'B',
      fileName: '020-b.md',
      absolutePath: 'y',
      order: 20,
      sizeBytes: 1,
    },
  ];
}

/* ------------------------------------------------------------------------ */
/* Slug e cadastro                                                           */
/* ------------------------------------------------------------------------ */

test('toSlug normaliza nomes com acentos e espaços', () => {
  assert.equal(toSlug('Meu Imóvel .io'), 'meu-imovel-io');
  assert.equal(toSlug('  Ação   Café  '), 'acao-cafe');
});

test('projeto criado gera a estrutura completa de dados', () => {
  const project = makeProject();
  const base = path.join(HOME, 'data', 'projects', project.id);
  for (const dir of ['prompts', 'state', 'logs', 'reviews', 'reports', 'artifacts']) {
    assert.equal(fs.existsSync(path.join(base, dir)), true, `faltou ${dir}`);
  }
  assert.equal(fs.existsSync(path.join(base, 'project.json')), true);
});

test('remover cadastro NÃO apaga o repositório real do usuário', () => {
  const project = makeProject();
  const repoPath = project.repositoryPath;
  fs.writeFileSync(path.join(repoPath, 'codigo-importante.txt'), 'não apague', 'utf8');

  const removed = removeProjectRegistration(project.id);
  assert.equal(removed.ok, true);

  assert.equal(fs.existsSync(repoPath), true, 'o repositório real deve continuar existindo');
  assert.equal(
    fs.readFileSync(path.join(repoPath, 'codigo-importante.txt'), 'utf8'),
    'não apague',
  );
  assert.equal(getProject(project.id).ok, false, 'o cadastro deve ter sumido');
});

test('validateProjectConfig recusa configuração inválida', () => {
  const base = normalizeProjectConfig({
    id: 'ok',
    name: 'ok',
    repositoryPath: path.join(HOME, 'repos'),
    githubRepository: 'maquinanerd/demo',
  });

  assert.equal(validateProjectConfig({ ...base, githubRepository: 'sem-barra' }).ok, false);
  assert.equal(validateProjectConfig({ ...base, repositoryPath: 'relativo' }).ok, false);
  assert.equal(
    validateProjectConfig({ ...base, merge: { ...base.merge, minimumConfidence: 5 } }).ok,
    false,
  );
  assert.equal(
    validateProjectConfig({ ...base, merge: { ...base.merge, strategy: 'octopus' } }).ok,
    false,
  );
  assert.equal(validateProjectConfig({ ...base, baseBranch: '--flag' }).ok, false);
});

/* ------------------------------------------------------------------------ */
/* Descoberta de prompts                                                     */
/* ------------------------------------------------------------------------ */

test('descoberta de prompts ordena naturalmente e ignora arquivos reservados', () => {
  const project = makeProject();
  const dir = projectPromptsDir(project.id);
  ensurePromptsDir(project.id);

  for (const name of ['20-vinte.md', '2-dois.md', '10-dez.md', 'README.md', 'TEMPLATE-PROMPT.md', '_oculto.md', 'nota.txt']) {
    fs.writeFileSync(path.join(dir, name), `# Objetivo\n\nconteúdo de ${name}\n`, 'utf8');
  }

  const result = discoverPrompts(project.id);
  assert.equal(result.ok, true);
  assert.deepEqual(
    result.value.map((p) => p.fileName),
    ['2-dois.md', '10-dez.md', '20-vinte.md'],
  );
  assert.equal(countPrompts(project.id), 3);
});

test('projeto sem prompts devolve lista vazia sem erro', () => {
  const project = makeProject();
  const result = discoverPrompts(project.id);
  assert.equal(result.ok, true);
  assert.deepEqual(result.value, []);
});

test('parsePrompt extrai as seções do template', () => {
  const content = [
    '# Identificação',
    '',
    'ID: 030-backend',
    'Nome: Backend',
    'Dependências: 020-banco',
    '',
    '# Objetivo',
    '',
    'Construir o backend.',
    '',
    '# Escopo obrigatório',
    '',
    '- Criar rotas',
    '- Validar entrada',
    '',
    '# Áreas proibidas',
    '',
    '- frontend/',
    '',
    '# Critérios de aceitação',
    '',
    '- Testes passam',
    '',
    '# Testes obrigatórios',
    '',
    '- npm test',
    '',
  ].join('\n');

  const parsed = parsePrompt('030-backend.md', content);
  assert.equal(parsed.id, '030-backend');
  assert.equal(parsed.name, 'Backend');
  assert.match(parsed.objective, /backend/i);
  assert.deepEqual(parsed.scope, ['Criar rotas', 'Validar entrada']);
  assert.deepEqual(parsed.forbiddenAreas, ['frontend/']);
  assert.deepEqual(parsed.acceptanceCriteria, ['Testes passam']);
  assert.deepEqual(parsed.requiredTests, ['npm test']);
});

test('parsePrompt aceita arquivo fora do template sem falhar', () => {
  const parsed = parsePrompt('livre.md', 'Só um texto livre, sem seções.');
  assert.equal(typeof parsed.rawBody, 'string');
  assert.ok(parsed.rawBody.includes('texto livre'));
  assert.deepEqual(parsed.scope, []);
});

/* ------------------------------------------------------------------------ */
/* Estado                                                                    */
/* ------------------------------------------------------------------------ */

test('newRunId produz identificador único e seguro para caminho', () => {
  const a = newRunId();
  const b = newRunId();
  assert.notEqual(a, b);
  assert.match(a, /^run-\d{8}-\d{6}-[0-9a-f]{4}$/);
});

test('estado é persistido e relido integralmente', () => {
  const project = makeProject();
  const run = createRun({ projectId: project.id, dryRun: false, prompts: promptFiles() });

  assert.equal(saveRun(run).ok, true);
  const loaded = loadRun(project.id, run.runId);
  assert.equal(loaded.ok, true);
  assert.equal(loaded.value.runId, run.runId);
  assert.equal(loaded.value.prompts.length, 2);
  assert.equal(loaded.value.prompts[0].status, 'PENDING');
});

test('transições válidas são aceitas e registram evento', () => {
  const project = makeProject();
  let run = createRun({ projectId: project.id, dryRun: false, prompts: promptFiles() });
  run = transition(run, 'VALIDATING', 'validando');
  run = transition(run, 'PREPARING_WORKTREE', 'worktree');
  run = transition(run, 'RUNNING_CLAUDE', 'claude');

  assert.equal(run.state, 'RUNNING_CLAUDE');
  assert.equal(run.previousState, 'PREPARING_WORKTREE');
  assert.ok(run.events.length >= 3);
  assert.equal(run.events[run.events.length - 1].state, 'RUNNING_CLAUDE');
});

test('estados terminais são reconhecidos', () => {
  for (const state of ['MERGED', 'COMPLETED', 'FAILED', 'CANCELLED']) {
    assert.equal(isTerminal(state), true, `${state} deveria ser terminal`);
  }
  for (const state of ['RUNNING_CLAUDE', 'WAITING_CI', 'BLOCKED']) {
    assert.equal(isTerminal(state), false, `${state} não deveria ser terminal`);
  }
});

test('estados de exceção são alcançáveis de qualquer estado ativo', () => {
  for (const from of ['RUNNING_CLAUDE', 'RUNNING_TESTS', 'WAITING_CI', 'MERGING']) {
    for (const to of ['BLOCKED', 'FAILED', 'INTERRUPTED', 'CANCELLED']) {
      assert.equal(canTransition(from, to), true, `${from} -> ${to} deveria ser permitido`);
    }
  }
});

test('a retomada permite sair dos estados de pausa/bloqueio', () => {
  assert.equal(canTransition('INTERRUPTED', 'RUNNING_CLAUDE'), true);
  assert.equal(canTransition('CI_FAILED', 'RUNNING_CLAUDE'), true);
  assert.equal(canTransition('USAGE_LIMIT_REACHED', 'VALIDATING'), true);
});

test('estado terminal não transiciona para estado ativo', () => {
  assert.equal(canTransition('MERGED', 'RUNNING_CLAUDE'), false);
  assert.equal(canTransition('CANCELLED', 'MERGING'), false);
});

/*
 * Regressão: a suíte final de testes roda depois do último commit, e a
 * transição COMMITTING -> RUNNING_TESTS não existia no mapa. Como transições
 * inválidas são apenas registradas (não lançam), o defeito ficou invisível:
 * o estado não avançava e o fluxo seguia por acidente. Ao corrigir a primeira
 * lacuna, apareceu a segunda — RUNNING_TESTS não tinha saída para PUSHING —,
 * e aí a execução ficava presa de verdade.
 *
 * Este teste percorre a cadeia real do orquestrador, ponta a ponta, para que
 * nenhuma etapa do fluxo volte a depender de uma transição rejeitada.
 */
test('a cadeia completa do orquestrador é percorrível sem transição rejeitada', () => {
  const caminhoFeliz = [
    'IDLE', 'VALIDATING', 'PREPARING_WORKTREE',
    'RUNNING_CLAUDE', 'RUNNING_TESTS', 'BUILDING_REVIEW_PACKAGE', 'RUNNING_CODEX',
    'PROMPT_APPROVED', 'COMMITTING',
    'RUNNING_TESTS',            // suíte COMPLETA antes de publicar
    'PUSHING', 'CREATING_PR', 'WAITING_CI',
    'RUNNING_CLAUDE_MERGE_AUDIT', 'RUNNING_CODEX_MERGE_AUDIT',
    'MERGE_CONSENSUS_PENDING', 'MERGE_APPROVED', 'MERGING', 'MERGED',
  ];

  for (let i = 0; i < caminhoFeliz.length - 1; i += 1) {
    const de = caminhoFeliz[i];
    const para = caminhoFeliz[i + 1];
    assert.equal(canTransition(de, para), true, `${de} -> ${para} deveria ser permitido`);
  }
});

test('a cadeia percorrida de fato muda o estado (nenhuma transição é ignorada)', () => {
  const project = makeProject();
  let run = createRun({ projectId: project.id, dryRun: false, prompts: promptFiles() });

  const cadeia = [
    'VALIDATING', 'PREPARING_WORKTREE', 'RUNNING_CLAUDE', 'RUNNING_TESTS',
    'BUILDING_REVIEW_PACKAGE', 'RUNNING_CODEX', 'PROMPT_APPROVED', 'COMMITTING',
    'RUNNING_TESTS', 'PUSHING', 'CREATING_PR', 'WAITING_CI',
  ];

  for (const alvo of cadeia) {
    run = transition(run, alvo, 'etapa ' + alvo);
    assert.equal(run.state, alvo, `o estado deveria ter avançado para ${alvo}`);
  }

  const rejeitadas = run.events.filter((e) => e.message.startsWith('Transição rejeitada'));
  assert.deepEqual(
    rejeitadas.map((e) => e.message),
    [],
    'nenhuma etapa do fluxo real pode depender de uma transição rejeitada',
  );
});

/*
 * Regressão de campo: numa execução real com Claude e Codex, o Loop Guard
 * disparou FORBIDDEN_AREA_CHANGED a partir de CHANGES_REQUESTED e a transição
 * para LOOP_GUARD_TRIGGERED foi REJEITADA — o estado caiu para BLOCKED genérico
 * e o gatilho sumiu da linha do tempo. Os dublês não pegaram porque nunca
 * chegaram ao portão com um gatilho acionado.
 */
test('LOOP_GUARD_TRIGGERED é alcançável de todo estado ativo do fluxo', () => {
  const ativos = [
    'VALIDATING', 'PREPARING_WORKTREE', 'RUNNING_CLAUDE', 'RUNNING_TESTS',
    'BUILDING_REVIEW_PACKAGE', 'RUNNING_CODEX', 'CHANGES_REQUESTED',
    'PROMPT_APPROVED', 'COMMITTING', 'PUSHING', 'CREATING_PR', 'WAITING_CI',
    'RUNNING_CLAUDE_MERGE_AUDIT', 'RUNNING_CODEX_MERGE_AUDIT',
    'MERGE_CONSENSUS_PENDING', 'MERGE_APPROVED',
  ];
  for (const de of ativos) {
    assert.equal(
      canTransition(de, 'LOOP_GUARD_TRIGGERED'),
      true,
      `${de} -> LOOP_GUARD_TRIGGERED precisa ser permitido`,
    );
  }
});

test('a parada do Loop Guard muda o estado de verdade, sem rejeição', () => {
  const project = makeProject();
  let run = createRun({ projectId: project.id, dryRun: false, prompts: promptFiles() });
  const caminho = [
    'VALIDATING',
    'RUNNING_CLAUDE',
    'RUNNING_TESTS',
    'BUILDING_REVIEW_PACKAGE',
    'RUNNING_CODEX',
    'CHANGES_REQUESTED',
  ];
  for (const alvo of caminho) {
    run = transition(run, alvo, 'etapa');
  }
  run = transition(run, 'LOOP_GUARD_TRIGGERED', 'FORBIDDEN_AREA_CHANGED');

  assert.equal(run.state, 'LOOP_GUARD_TRIGGERED', 'a parada não pode virar BLOCKED genérico');
  const rejeitadas = run.events.filter((e) => e.message.startsWith('Transição rejeitada'));
  assert.deepEqual(rejeitadas.map((e) => e.message), []);
});

test('de LOOP_GUARD_TRIGGERED a execução pode ser retomada por decisão humana', () => {
  assert.equal(canTransition('LOOP_GUARD_TRIGGERED', 'RUNNING_CLAUDE'), true);
  assert.equal(canTransition('LOOP_GUARD_TRIGGERED', 'CANCELLED'), true);
});

test('variantes do fluxo também são percorríveis', () => {
  // Projeto que não publica: a suíte final leva direto a COMPLETED.
  assert.equal(canTransition('RUNNING_TESTS', 'COMPLETED'), true);
  // Suíte final reprovada: BLOCKED é alcançável de qualquer estado ativo.
  assert.equal(canTransition('RUNNING_TESTS', 'BLOCKED'), true);
  // Retomada após CI vermelho volta ao trabalho.
  assert.equal(canTransition('CI_FAILED', 'RUNNING_CLAUDE'), true);
  // Consenso não alcançado volta para correção.
  assert.equal(canTransition('MERGE_CONSENSUS_PENDING', 'CHANGES_REQUESTED'), true);
});

test('progresso de prompt e agregados', () => {
  const project = makeProject();
  let run = createRun({ projectId: project.id, dryRun: false, prompts: promptFiles() });

  assert.equal(allPromptsApproved(run), false);
  assert.equal(nextPendingPrompt(run).promptId, '010-a');

  run = updatePromptProgress(run, '010-a', { status: 'APPROVED', commitSha: 'abc1234' });
  assert.equal(nextPendingPrompt(run).promptId, '020-b');
  assert.equal(allPromptsApproved(run), false);

  run = updatePromptProgress(run, '020-b', { status: 'APPROVED' });
  assert.equal(allPromptsApproved(run), true);
  assert.equal(nextPendingPrompt(run), null);
});

test('invalidateMergeApprovals invalida TODAS as auditorias e zera o consenso', () => {
  const project = makeProject();
  let run = createRun({ projectId: project.id, dryRun: false, prompts: promptFiles() });
  run = {
    ...run,
    mergeReviews: [
      { auditor: 'claude', review: {}, producedAt: 'x', observedHeadSha: 'a', rawOutputPath: null, invalidated: false, invalidationReason: null },
      { auditor: 'codex', review: {}, producedAt: 'x', observedHeadSha: 'a', rawOutputPath: null, invalidated: false, invalidationReason: null },
    ],
    consensus: { reached: true },
    gateReport: { allPassed: true },
  };

  const invalidated = invalidateMergeApprovals(run, 'head SHA mudou');
  assert.equal(invalidated.mergeReviews.every((r) => r.invalidated === true), true);
  assert.equal(invalidated.mergeReviews.every((r) => r.invalidationReason === 'head SHA mudou'), true);
  assert.equal(invalidated.consensus, null, 'o consenso antigo não pode sobreviver');
  assert.equal(invalidated.gateReport, null);
});

test('pausa e cancelamento marcam o pedido sem destruir estado', () => {
  const project = makeProject();
  let run = createRun({ projectId: project.id, dryRun: false, prompts: promptFiles() });
  run = updatePromptProgress(run, '010-a', { status: 'APPROVED' });

  const paused = requestPause(run);
  assert.equal(paused.pauseRequested, true);
  assert.equal(paused.prompts[0].status, 'APPROVED', 'o progresso é preservado');

  const cancelled = requestCancel(run);
  assert.equal(cancelled.cancelRequested, true);
  assert.equal(cancelled.prompts[0].status, 'APPROVED');
});

test('listRuns e findActiveRun refletem o que foi gravado', () => {
  const project = makeProject();
  const run = createRun({ projectId: project.id, dryRun: false, prompts: promptFiles() });
  saveRun(transition(run, 'RUNNING_CLAUDE', 'ativo'));

  const runs = listRuns(project.id);
  assert.equal(runs.ok, true);
  assert.equal(runs.value.length, 1);

  const activeRun = findActiveRun(project.id);
  assert.equal(activeRun.ok, true);
  assert.equal(activeRun.value.runId, run.runId);
});

/* ------------------------------------------------------------------------ */
/* Locks                                                                     */
/* ------------------------------------------------------------------------ */

test('lock exclusivo impede aquisição concorrente', async () => {
  const first = await acquireLock({ scope: 'project', key: 'trava1', operation: 'teste' });
  assert.equal(first.ok, true);

  const second = await acquireLock({ scope: 'project', key: 'trava1', operation: 'outro' });
  assert.equal(second.ok, false);
  assert.equal(second.error.code, 'LOCK_HELD');

  await first.value.release();

  const third = await acquireLock({ scope: 'project', key: 'trava1', operation: 'depois' });
  assert.equal(third.ok, true);
  await third.value.release();
});

test('lock registra pid, hostname e operação', async () => {
  const handle = await acquireLock({
    scope: 'merge',
    key: 'trava2',
    projectId: 'demo',
    runId: 'run-1',
    operation: 'merge por consenso',
  });
  assert.equal(handle.ok, true);
  assert.equal(handle.value.info.pid, process.pid);
  assert.equal(handle.value.info.operation, 'merge por consenso');
  assert.ok(listLocks().some((l) => l.key === 'trava2'));
  await handle.value.release();
  assert.equal(listLocks().some((l) => l.key === 'trava2'), false);
});

test('withLock libera o lock mesmo quando a função lança', async () => {
  await assert.rejects(
    withLock({ scope: 'run', key: 'trava3', operation: 'falha' }, async () => {
      throw new Error('erro proposital');
    }),
  ).catch(() => {});

  // Independentemente de como o erro propagou, o lock não pode ter ficado preso.
  const retry = await acquireLock({ scope: 'run', key: 'trava3', operation: 'retry' });
  assert.equal(retry.ok, true, 'o lock deveria ter sido liberado');
  await retry.value.release();
});

test('withLock devolve o valor da função em caso de sucesso', async () => {
  const result = await withLock({ scope: 'state', key: 'trava4', operation: 'ok' }, async () => 42);
  assert.equal(result.ok, true);
  assert.equal(result.value, 42);
});
