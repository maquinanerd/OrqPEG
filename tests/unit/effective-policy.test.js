'use strict';

/**
 * Congelamento de política efetiva.
 *
 * O defeito que estes testes vigiam é sempre o mesmo, visto de ângulos
 * diferentes: uma edição no cadastro reescrevendo retroativamente uma execução
 * que já rodou sob outros limites. Cada teste abaixo edita o projeto DEPOIS do
 * congelamento e exige que o número antigo sobreviva — se algum consumidor
 * voltar a ler `getProject()`, o teste fica vermelho.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'orqpeg-pol-'));
process.env.ORQPEG_HOME = HOME;
process.env.ORQPEG_NO_FILE_LOG = '1';

const {
  resolveEffectiveExecutionPolicy,
  requireEffectivePolicy,
  assertEffectivePolicySnapshot,
  materializeLegacyPolicySnapshot,
  executionRelevantProjectConfigHash,
  parseRoundPolicyOverrides,
  roundConfigHashOf,
  hasPolicySnapshot,
} = require('../../dist/execution/effective-policy');
const { createRun, saveRun, loadRun } = require('../../dist/state/run-state');
const {
  createProject,
  updateProject,
  getProject,
} = require('../../dist/projects/project-store');
const { normalizeProjectConfig } = require('../../dist/projects/project-validator');
const { renderLoopGuardReport } = require('../../dist/reports/loop-guard-report');
const { grantManualOverride, consumeOverride } = require('../../dist/execution/override');
const { createPromptBudget } = require('../../dist/execution/loop-guard');
const { defaultGlobalConfig } = require('../../dist/config/global-config');
const {
  ensureDataLayout,
  runStatePath,
  setOrqpegRootForTesting,
} = require('../../dist/utils/paths');
const { loopGuardPolicyFor, createRunInput } = require('../helpers/policy');

setOrqpegRootForTesting(HOME);
ensureDataLayout();

/* ------------------------------------------------------------------------ */
/* Cenário base                                                              */
/* ------------------------------------------------------------------------ */

const JUSTIFICATIVA = 'A dependencia que quebrava o teste acabou de ser instalada manualmente.';

let contador = 0;

/** Cadastra um projeto real, com as pastas de dados criadas. */
function criarProjeto(patch = {}) {
  contador += 1;
  const id = `pol${contador}`;
  const repositoryPath = path.join(HOME, 'repos', id);
  fs.mkdirSync(repositoryPath, { recursive: true });

  const config = normalizeProjectConfig({
    id,
    name: `Projeto ${contador}`,
    repositoryPath,
    githubRepository: 'maquinanerd/demo',
    ...patch,
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
  ];
}

/** Lê o registro gravado no disco como JSON cru, para adulteração deliberada. */
function lerRegistroCru(projectId, runId) {
  return JSON.parse(fs.readFileSync(runStatePath(projectId, runId), 'utf8'));
}

function gravarRegistroCru(projectId, runId, record) {
  fs.writeFileSync(
    runStatePath(projectId, runId),
    JSON.stringify(record, null, 2),
    'utf8',
  );
}

function clonar(value) {
  return JSON.parse(JSON.stringify(value));
}

/* ------------------------------------------------------------------------ */
/* 1. A execução antiga mantém os limites com que começou                    */
/* ------------------------------------------------------------------------ */

test('execução antiga mantém 3/3 depois de o projeto mudar para 5', () => {
  const projeto = criarProjeto({ execution: { maxAttemptsPerPrompt: 3 } });
  assert.equal(projeto.execution.maxAttemptsPerPrompt, 3);

  const run = createRun(createRunInput(projeto, promptFiles()));
  assert.equal(saveRun(run).ok, true);
  assert.equal(run.effectivePolicy.loopGuard.maxAttemptsPerPrompt, 3);

  const editado = updateProject(projeto.id, { execution: { maxAttemptsPerPrompt: 5 } });
  assert.equal(editado.ok, true, editado.ok ? '' : JSON.stringify(editado.error));
  assert.equal(
    getProject(projeto.id).value.execution.maxAttemptsPerPrompt,
    5,
    'o cadastro precisa mesmo ter mudado, senão o teste não prova nada',
  );

  const relido = loadRun(projeto.id, run.runId);
  assert.equal(relido.ok, true, relido.ok ? '' : JSON.stringify(relido.error));
  assert.equal(
    relido.value.effectivePolicy.loopGuard.maxAttemptsPerPrompt,
    3,
    'o denominador da execução é o do congelamento, não o do cadastro de hoje',
  );

  // E a política resolvida HOJE é outra — é exatamente essa divergência que o
  // congelamento existe para tornar visível em vez de silenciosa.
  assert.equal(loopGuardPolicyFor(getProject(projeto.id).value).maxAttemptsPerPrompt, 5);
});

/* ------------------------------------------------------------------------ */
/* 2. Aumentar o teto de override não devolve override já gasto              */
/* ------------------------------------------------------------------------ */

test('override continua limitado depois de o projeto mudar', () => {
  const projeto = criarProjeto({
    execution: { loopGuard: { maxManualOverridesPerPrompt: 1 } },
  });
  assert.equal(projeto.execution.loopGuard.maxManualOverridesPerPrompt, 1);

  const criado = createRun(createRunInput(projeto, promptFiles()));
  const parado = {
    ...criado,
    state: 'LOOP_GUARD_TRIGGERED',
    lastLoopGuard: {
      allowed: false,
      severity: 'soft_stop',
      trigger: 'NO_PROGRESS',
      reason: 'a correção não mudou o código',
      evidence: {},
      nextActions: [],
    },
  };

  const congelada = parado.effectivePolicy.loopGuard;
  assert.equal(congelada.maxManualOverridesPerPrompt, 1);

  const primeiro = grantManualOverride({
    run: parado,
    promptId: '010-a',
    justification: JUSTIFICATIVA,
    authorizedBy: 'pablo',
    policy: congelada,
  });
  assert.equal(primeiro.ok, true, primeiro.ok ? '' : primeiro.error.message);
  const consumido = consumeOverride(primeiro.value.run, '010-a');

  // O cadastro passa a permitir três overrides por prompt.
  const editado = updateProject(projeto.id, {
    execution: { loopGuard: { ...projeto.execution.loopGuard, maxManualOverridesPerPrompt: 3 } },
  });
  assert.equal(editado.ok, true, editado.ok ? '' : JSON.stringify(editado.error));
  assert.equal(editado.value.execution.loopGuard.maxManualOverridesPerPrompt, 3);

  const segundo = grantManualOverride({
    run: consumido,
    promptId: '010-a',
    justification: JUSTIFICATIVA,
    authorizedBy: 'pablo',
    policy: consumido.effectivePolicy.loopGuard,
  });
  assert.equal(
    segundo.ok,
    false,
    'a parada já consumiu o único override que a execução tinha direito',
  );
  assert.match(segundo.error.message, /limite de 1 override/i);

  // Contraprova: com o cadastro de HOJE o segundo override passaria. É esse
  // caminho que não pode existir na execução.
  const comCadastroAtual = grantManualOverride({
    run: consumido,
    promptId: '010-a',
    justification: JUSTIFICATIVA,
    authorizedBy: 'pablo',
    policy: loopGuardPolicyFor(editado.value),
  });
  assert.equal(
    comCadastroAtual.ok,
    true,
    'a contraprova precisa passar, senão o teste anterior não prova nada',
  );
});

/* ------------------------------------------------------------------------ */
/* 3. Relatório emitido não é reescrito por edição posterior                 */
/* ------------------------------------------------------------------------ */

test('relatório antigo mantém os denominadores originais', () => {
  const projeto = criarProjeto({
    execution: { maxAttemptsPerPrompt: 3, loopGuard: { maxManualOverridesPerPrompt: 1 } },
  });
  const run = createRun(createRunInput(projeto, promptFiles()));
  const congelada = run.effectivePolicy.loopGuard;

  const editado = updateProject(projeto.id, {
    execution: {
      maxAttemptsPerPrompt: 5,
      loopGuard: { ...projeto.execution.loopGuard, maxManualOverridesPerPrompt: 4 },
    },
  });
  assert.equal(editado.ok, true, editado.ok ? '' : JSON.stringify(editado.error));

  const decisao = {
    allowed: false,
    severity: 'soft_stop',
    trigger: 'MAX_ATTEMPTS_REACHED',
    reason: 'o orçamento de tentativas deste prompt terminou',
    evidence: {},
    nextActions: ['AUTHORIZE_EXTRA_ATTEMPT'],
  };
  const budget = { ...createPromptBudget('010-a'), attempts: 3 };

  const relatorio = renderLoopGuardReport({
    project: editado.value,
    run,
    promptId: '010-a',
    decision: decisao,
    budget,
    policy: congelada,
  });

  assert.ok(
    relatorio.includes('| Tentativas | 3 | 3 |'),
    'o relatório precisa imprimir o teto sob o qual a parada aconteceu',
  );
  assert.ok(
    relatorio.includes('| Overrides manuais | 0 | 1 |'),
    'o teto de override também é o congelado',
  );
  assert.equal(
    relatorio.includes('| Tentativas | 3 | 5 |'),
    false,
    'o cadastro de hoje não pode aparecer na coluna Limite',
  );

  // Contraprova: com a política de hoje o relatório imprimiria outro número.
  const comCadastroAtual = renderLoopGuardReport({
    project: editado.value,
    run,
    promptId: '010-a',
    decision: decisao,
    budget,
    policy: loopGuardPolicyFor(editado.value),
  });
  assert.ok(comCadastroAtual.includes('| Tentativas | 3 | 5 |'));
});

/* ------------------------------------------------------------------------ */
/* 4. prepare() confere, e só confere                                        */
/* ------------------------------------------------------------------------ */

test('assertEffectivePolicySnapshot confere sem recapturar hashes nem alterar o registro', () => {
  const projeto = criarProjeto({ execution: { maxAttemptsPerPrompt: 3 } });
  const run = createRun(createRunInput(projeto, promptFiles()));
  assert.equal(saveRun(run).ok, true);

  const hashOriginal = run.effectivePolicy.sources.projectConfigHash;

  const editado = updateProject(projeto.id, { execution: { maxAttemptsPerPrompt: 5 } });
  assert.equal(editado.ok, true, editado.ok ? '' : JSON.stringify(editado.error));
  assert.notEqual(
    executionRelevantProjectConfigHash(editado.value),
    hashOriginal,
    'a edição precisa mesmo mudar o hash do cadastro',
  );

  const relido = loadRun(projeto.id, run.runId);
  assert.equal(relido.ok, true);
  const antes = clonar(relido.value);

  const verificado = assertEffectivePolicySnapshot(relido.value);
  assert.equal(verificado.ok, true, verificado.ok ? '' : verificado.error.message);

  assert.deepEqual(
    clonar(relido.value),
    antes,
    'a verificação não pode mutar o registro de execução',
  );
  assert.equal(
    verificado.value.sources.projectConfigHash,
    hashOriginal,
    'o hash de origem é o do congelamento; recapturá-lo apagaria a prova da edição',
  );
  assert.equal(verificado.value.loopGuard.maxAttemptsPerPrompt, 3);
});

test('snapshot adulterado no disco é recusado com STATE_CORRUPT', () => {
  const projeto = criarProjeto({ execution: { maxAttemptsPerPrompt: 3 } });
  const run = createRun(createRunInput(projeto, promptFiles()));
  assert.equal(saveRun(run).ok, true);

  // Edição à mão do JSON: sobe o teto sem recalcular `effectiveHash`.
  const cru = lerRegistroCru(projeto.id, run.runId);
  cru.effectivePolicy.loopGuard.maxAttemptsPerPrompt = 99;
  gravarRegistroCru(projeto.id, run.runId, cru);

  const relido = loadRun(projeto.id, run.runId);
  assert.equal(relido.ok, true, 'o registro continua legível; o problema é de integridade');
  assert.equal(relido.value.effectivePolicy.loopGuard.maxAttemptsPerPrompt, 99);

  const verificado = assertEffectivePolicySnapshot(relido.value);
  assert.equal(verificado.ok, false, 'um teto elevado à mão não pode ser aceito');
  assert.equal(verificado.error.code, 'STATE_CORRUPT');
  assert.match(verificado.error.message, /adulterada|hash/i);
});

test('snapshot de outro projeto é recusado com STATE_CORRUPT', () => {
  const projeto = criarProjeto();
  const outro = criarProjeto();
  const run = createRun(createRunInput(projeto, promptFiles()));

  const trocado = {
    ...run,
    effectivePolicy: {
      ...run.effectivePolicy,
      sourceMetadata: { ...run.effectivePolicy.sourceMetadata, projectId: outro.id },
    },
  };

  const verificado = assertEffectivePolicySnapshot(trocado);
  assert.equal(verificado.ok, false);
  assert.equal(verificado.error.code, 'STATE_CORRUPT');
});

/* ------------------------------------------------------------------------ */
/* 5. O hash reage à execução, não à papelada                                */
/* ------------------------------------------------------------------------ */

test('updatedAt, createdAt, name e editor não mudam o hash do cadastro', () => {
  const projeto = criarProjeto();
  const base = executionRelevantProjectConfigHash(projeto);

  const apenasPapelada = {
    ...projeto,
    name: 'Outro nome completamente diferente',
    editor: 'code --wait',
    createdAt: '2001-01-01T00:00:00.000Z',
    updatedAt: '2030-12-31T23:59:59.000Z',
  };
  assert.equal(
    executionRelevantProjectConfigHash(apenasPapelada),
    base,
    'renomear ou apenas salvar o projeto não pode interromper uma execução',
  );
});

test('mudar execution.maxAttemptsPerPrompt muda o hash do cadastro', () => {
  const projeto = criarProjeto({ execution: { maxAttemptsPerPrompt: 3 } });
  const base = executionRelevantProjectConfigHash(projeto);

  const comOutroTeto = {
    ...projeto,
    execution: { ...projeto.execution, maxAttemptsPerPrompt: 5 },
  };
  assert.notEqual(
    executionRelevantProjectConfigHash(comOutroTeto),
    base,
    'um limite de execução alterado precisa ser detectado',
  );
});

test('reordenar as chaves não muda o hash, mas trocar qualquer valor relevante muda', () => {
  const projeto = criarProjeto();
  const reordenado = reordenarChaves(projeto);
  const base = executionRelevantProjectConfigHash(projeto);

  assert.notDeepEqual(
    Object.keys(reordenado),
    Object.keys(projeto),
    'o objeto reordenado precisa mesmo estar em outra ordem',
  );
  assert.equal(
    executionRelevantProjectConfigHash(reordenado),
    base,
    'reformatar o JSON não é mudança de configuração',
  );

  /*
   * A metade acima, sozinha, passaria também se o hash ignorasse o conteúdo:
   * um hash constante é insensível a qualquer reordenação. Cada variação
   * abaixo troca UM campo que a execução realmente usa — sempre sobre o
   * objeto já reordenado — e exige que o hash reaja. Um campo que sumisse da
   * canonicalização deixaria de interromper execuções em curso, que é
   * exatamente o buraco que este hash existe para fechar.
   */
  const variacoes = {
    id: (p) => ({ ...p, id: `${p.id}-outro` }),
    repositoryPath: (p) => ({ ...p, repositoryPath: path.join(p.repositoryPath, 'outro') }),
    githubRepository: (p) => ({ ...p, githubRepository: 'maquinanerd/outro' }),
    remote: (p) => ({ ...p, remote: 'upstream' }),
    baseBranch: (p) => ({ ...p, baseBranch: 'develop' }),
    branchStrategy: (p) => ({ ...p, branchStrategy: 'single_branch' }),
    'worktree.enabled': (p) => ({
      ...p,
      worktree: { ...p.worktree, enabled: !p.worktree.enabled },
    }),
    'worktree.rootPath': (p) => ({
      ...p,
      worktree: { ...p.worktree, rootPath: path.join(HOME, 'worktrees') },
    }),
    'worktree.reuseWhenSafe': (p) => ({
      ...p,
      worktree: { ...p.worktree, reuseWhenSafe: !p.worktree.reuseWhenSafe },
    }),
    'commands.tests': (p) => ({
      ...p,
      commands: { ...p.commands, tests: ['npm run test:outro'] },
    }),
    'commands.timeoutSeconds': (p) => ({
      ...p,
      commands: { ...p.commands, timeoutSeconds: p.commands.timeoutSeconds + 1 },
    }),
    'execution.loopGuard.maxManualOverridesPerPrompt': (p) => ({
      ...p,
      execution: {
        ...p.execution,
        loopGuard: {
          ...p.execution.loopGuard,
          maxManualOverridesPerPrompt: p.execution.loopGuard.maxManualOverridesPerPrompt + 1,
        },
      },
    }),
    'git.commitMessagePrefix': (p) => ({
      ...p,
      git: { ...p.git, commitMessagePrefix: 'outro-prefixo:' },
    }),
    'pullRequest.waitForChecks': (p) => ({
      ...p,
      pullRequest: { ...p.pullRequest, waitForChecks: !p.pullRequest.waitForChecks },
    }),
    'merge.strategy': (p) => ({ ...p, merge: { ...p.merge, strategy: 'merge' } }),
    'agents.claudeModel': (p) => ({
      ...p,
      agents: { ...p.agents, claudeModel: 'outro-modelo' },
    }),
  };

  for (const [campo, trocar] of Object.entries(variacoes)) {
    assert.notEqual(
      executionRelevantProjectConfigHash(trocar(reordenado)),
      base,
      `alterar ${campo} muda o comportamento da execução e precisa ser detectado`,
    );
  }
});

test('barra e barra final do repositoryPath não mudam o hash do cadastro', () => {
  const projeto = criarProjeto();
  const comBarras = {
    ...projeto,
    repositoryPath: `${projeto.repositoryPath.replace(/\\/g, '/')}/`,
  };
  assert.notEqual(comBarras.repositoryPath, projeto.repositoryPath);
  assert.equal(
    executionRelevantProjectConfigHash(comBarras),
    executionRelevantProjectConfigHash(projeto),
    'C:\\Repo e C:/Repo/ são o mesmo alvo; a diferença é de digitação',
  );
});

test('no Windows, a caixa do repositoryPath não muda o hash do cadastro', (t) => {
  if (process.platform !== 'win32') {
    t.skip('caminhos só são insensíveis a caixa no Windows');
    return;
  }
  const projeto = criarProjeto();
  const emMaiusculas = { ...projeto, repositoryPath: projeto.repositoryPath.toUpperCase() };
  assert.notEqual(emMaiusculas.repositoryPath, projeto.repositoryPath);
  assert.equal(
    executionRelevantProjectConfigHash(emMaiusculas),
    executionRelevantProjectConfigHash(projeto),
  );
});

/* ------------------------------------------------------------------------ */
/* 6. Execução legada não é retomada em silêncio                             */
/* ------------------------------------------------------------------------ */

test('execução sem snapshot vira null na leitura e recusa retomada', () => {
  const projeto = criarProjeto();
  const run = createRun(createRunInput(projeto, promptFiles()));
  assert.equal(saveRun(run).ok, true);

  // Simula um registro gravado antes do congelamento de política.
  const cru = lerRegistroCru(projeto.id, run.runId);
  delete cru.effectivePolicy;
  delete cru.sourceSnapshots;
  gravarRegistroCru(projeto.id, run.runId, cru);

  const relido = loadRun(projeto.id, run.runId);
  assert.equal(relido.ok, true, 'o registro legado continua legível');
  assert.equal(
    relido.value.effectivePolicy,
    null,
    'a ausência é normalizada para null, nunca preenchida com o cadastro de hoje',
  );
  assert.equal(relido.value.sourceSnapshots, null);
  assert.equal(hasPolicySnapshot(relido.value), false);

  const exigida = requireEffectivePolicy(relido.value);
  assert.equal(exigida.ok, false, 'retomar sem política congelada reescreveria a história');
  assert.equal(exigida.error.code, 'POLICY_SNAPSHOT_MISSING');
  assert.equal(exigida.error.details.runId, run.runId);
});

test('snapshot em schema não suportado é recusado com STATE_CORRUPT', () => {
  const projeto = criarProjeto();
  const run = createRun(createRunInput(projeto, promptFiles()));
  const futuro = {
    ...run,
    effectivePolicy: { ...run.effectivePolicy, schemaVersion: 2 },
  };
  const exigida = requireEffectivePolicy(futuro);
  assert.equal(exigida.ok, false);
  assert.equal(exigida.error.code, 'STATE_CORRUPT');
});

/* ------------------------------------------------------------------------ */
/* 7. Precedência: rodada > projeto > global > padrões do produto            */
/* ------------------------------------------------------------------------ */

function cenarioDeCamadas() {
  const projeto = criarProjeto();
  const projetoComCamada = {
    ...projeto,
    execution: {
      ...projeto.execution,
      maxAttemptsPerPrompt: 4,
      maxReviewerRetries: 1,
      continueAfterApproval: false,
      stopOnBlocked: false,
      loopGuard: {
        /* Sobrepõe a global. */
        maxClaudeCallsPerPrompt: 5,
        /* Declarado como ausente: precisa cair para a camada global. */
        maxPromptDurationMinutes: undefined,
        /* Será sobreposto pela rodada. */
        maxRepeatedReviewFingerprints: 4,
      },
    },
  };

  const globalConfig = {
    ...defaultGlobalConfig(),
    loopGuard: {
      maxClaudeCallsPerPrompt: 2,
      maxPromptDurationMinutes: 45,
      maxCiRepairCycles: 7,
    },
  };

  const roundConfig = {
    roundId: 'rodada-1',
    maxAttemptsPerPrompt: 9,
    loopGuard: { maxRepeatedReviewFingerprints: 6 },
  };

  return { projeto: projetoComCamada, globalConfig, roundConfig };
}

test('cada camada só sobrepõe o campo que declara, na ordem rodada > projeto > global > padrão', () => {
  const { projeto, globalConfig, roundConfig } = cenarioDeCamadas();

  const resolvido = resolveEffectiveExecutionPolicy({
    globalConfig,
    projectConfig: projeto,
    roundConfig,
  });
  assert.equal(resolvido.ok, true, resolvido.ok ? '' : resolvido.error.message);
  const loop = resolvido.value.loopGuard;

  assert.equal(loop.maxCodexCallsPerPrompt, 5, 'nenhuma camada declara: vale o padrão do produto');
  assert.equal(loop.maxCiRepairCycles, 7, 'só a global declara: a global vence o padrão');
  assert.equal(loop.maxClaudeCallsPerPrompt, 5, 'o projeto vence a global');
  assert.equal(loop.maxRepeatedReviewFingerprints, 6, 'a rodada vence o projeto');
  assert.equal(loop.maxAttemptsPerPrompt, 9, 'a rodada vence o teto de tentativas do projeto');
  assert.equal(loop.maxReviewerRetries, 1, 'a rodada não declara: vale o projeto');
  assert.equal(loop.continueAfterApproval, false);
  assert.equal(loop.stopOnBlocked, false);

  assert.equal(
    loop.maxPromptDurationMinutes,
    45,
    'undefined é ausência, não zero: cai para a camada de baixo',
  );

  assert.equal(typeof resolvido.value.sources.roundConfigHash, 'string');
  assert.equal(resolvido.value.sourceMetadata.roundId, 'rodada-1');
});

test('sem rodada, roundConfigHash é null e o projeto governa', () => {
  const { projeto, globalConfig } = cenarioDeCamadas();

  const resolvido = resolveEffectiveExecutionPolicy({
    globalConfig,
    projectConfig: projeto,
    roundConfig: null,
  });
  assert.equal(resolvido.ok, true, resolvido.ok ? '' : resolvido.error.message);

  assert.equal(
    resolvido.value.sources.roundConfigHash,
    null,
    'null significa "esta fase não tem rodada", não "rodada vazia"',
  );
  assert.equal(resolvido.value.sourceMetadata.roundId, null);
  assert.equal(resolvido.value.loopGuard.maxAttemptsPerPrompt, 4, 'volta a valer o projeto');
  assert.equal(resolvido.value.loopGuard.maxRepeatedReviewFingerprints, 4);
});

test('o modelo do agente é resolvido contra o padrão global no congelamento', () => {
  const projeto = criarProjeto();
  assert.equal(projeto.agents.claudeModel, null);

  const globalConfig = {
    ...defaultGlobalConfig(),
    agents: { ...defaultGlobalConfig().agents, defaultClaudeModel: 'modelo-da-instalacao' },
  };

  const resolvido = resolveEffectiveExecutionPolicy({
    globalConfig,
    projectConfig: projeto,
    roundConfig: null,
  });
  assert.equal(resolvido.ok, true, resolvido.ok ? '' : resolvido.error.message);
  assert.equal(resolvido.value.agents.claudeModel, 'modelo-da-instalacao');
});

test('composição incoerente é recusada em vez de corrigida em silêncio', () => {
  const projeto = criarProjeto();
  const incoerente = {
    ...projeto,
    execution: {
      ...projeto.execution,
      loopGuard: { maxClaudeCallsPerPrompt: 9, maxTotalAgentCallsPerPrompt: 2 },
    },
  };

  const resolvido = resolveEffectiveExecutionPolicy({
    globalConfig: defaultGlobalConfig(),
    projectConfig: incoerente,
    roundConfig: null,
  });
  assert.equal(resolvido.ok, false, 'um teto total menor que o do Claude não pode ser congelado');
  assert.equal(resolvido.error.code, 'VALIDATION_FAILED');
});

/* ------------------------------------------------------------------------ */
/* 8. Materialização de execução legada                                      */
/* ------------------------------------------------------------------------ */

test('materializeLegacyPolicySnapshot declara que não é reconstrução histórica', () => {
  const projeto = criarProjeto({ execution: { maxAttemptsPerPrompt: 3 } });
  const run = createRun(createRunInput(projeto, promptFiles()));
  const legado = { ...run, effectivePolicy: null, sourceSnapshots: null };

  const materializado = materializeLegacyPolicySnapshot({
    run: legado,
    globalConfig: defaultGlobalConfig(),
    projectConfig: projeto,
    confirmedBy: 'pablo',
  });
  assert.equal(materializado.ok, true, materializado.ok ? '' : materializado.error.message);

  const snapshot = materializado.value;
  assert.equal(
    snapshot.sourceMetadata.materializedFromLegacyRun,
    true,
    'o snapshot precisa se declarar materializado, e não original',
  );
  assert.equal(snapshot.sourceMetadata.materializedBy, 'pablo');
  assert.ok(snapshot.sourceMetadata.materializedAt, 'a data da materialização fica registrada');

  // Continua sendo um snapshot íntegro: a flag não pode ficar fora do hash.
  const verificado = assertEffectivePolicySnapshot({ ...legado, effectivePolicy: snapshot });
  assert.equal(verificado.ok, true, verificado.ok ? '' : verificado.error.message);
});

test('apagar as marcas de materialização no disco é detectado como adulteração', () => {
  const projeto = criarProjeto({ execution: { maxAttemptsPerPrompt: 3 } });
  const run = createRun(createRunInput(projeto, promptFiles()));
  const legado = { ...run, effectivePolicy: null, sourceSnapshots: null };

  const materializado = materializeLegacyPolicySnapshot({
    run: legado,
    globalConfig: defaultGlobalConfig(),
    projectConfig: projeto,
    confirmedBy: 'pablo',
  });
  assert.equal(materializado.ok, true, materializado.ok ? '' : materializado.error.message);

  /*
   * Ataque exato descrito na auditoria: um snapshot materializado a partir do
   * cadastro de hoje tem sua procedência removida no disco para se passar por
   * congelamento histórico legítimo. `effectiveHash` sozinho não pega — a
   * política resolvida não mudou — então isto prova que o `integrityHash`
   * cobre a `sourceMetadata`.
   */
  const forjado = JSON.parse(JSON.stringify(materializado.value));
  delete forjado.sourceMetadata.materializedFromLegacyRun;
  delete forjado.sourceMetadata.materializedBy;
  delete forjado.sourceMetadata.materializedAt;
  forjado.sourceMetadata.roundId = 'rodada-inventada';

  const verificado = assertEffectivePolicySnapshot({ ...legado, effectivePolicy: forjado });
  assert.equal(verificado.ok, false, 'a procedência apagada precisa ser recusada');
  assert.equal(verificado.error.code, 'STATE_CORRUPT');
  assert.match(verificado.error.message, /procedência|integridade/i);

  // Sanidade: o mesmo snapshot, sem adulterar, passa.
  const intacto = assertEffectivePolicySnapshot({
    ...legado,
    effectivePolicy: materializado.value,
  });
  assert.equal(intacto.ok, true, intacto.ok ? '' : intacto.error.message);
});

test('sem autor identificado, a materialização registra o operador local', () => {
  const projeto = criarProjeto();
  const run = createRun(createRunInput(projeto, promptFiles()));
  const legado = { ...run, effectivePolicy: null, sourceSnapshots: null };

  const materializado = materializeLegacyPolicySnapshot({
    run: legado,
    globalConfig: defaultGlobalConfig(),
    projectConfig: projeto,
    confirmedBy: '   ',
  });
  assert.equal(materializado.ok, true, materializado.ok ? '' : materializado.error.message);
  assert.equal(materializado.value.sourceMetadata.materializedBy, 'operador local');
});

test('materializar sobre execução que já tem política congelada é recusado', () => {
  const projeto = criarProjeto();
  const run = createRun(createRunInput(projeto, promptFiles()));
  assert.equal(hasPolicySnapshot(run), true);

  const materializado = materializeLegacyPolicySnapshot({
    run,
    globalConfig: defaultGlobalConfig(),
    projectConfig: projeto,
    confirmedBy: 'pablo',
  });
  assert.equal(materializado.ok, false, 'sobrescrever a política original é inaceitável');
  assert.equal(materializado.error.code, 'VALIDATION_FAILED');
  assert.match(materializado.error.message, /já possui política congelada/i);

  // E o registro segue com a política original intacta.
  assert.equal(run.effectivePolicy.sourceMetadata.materializedFromLegacyRun, undefined);
});

/* ------------------------------------------------------------------------ */
/* Origem da camada de rodada                                                */
/* ------------------------------------------------------------------------ */

/**
 * A camada de rodada agora tem origem: o corpo da requisição que cria a
 * execução. O que estes testes vigiam é a fronteira — ela recusa em vez de
 * corrigir, porque um valor clampado em silêncio congelaria uma política
 * diferente da que o operador pediu.
 */

test('ausência de rodada é null, não rodada vazia', () => {
  for (const entrada of [undefined, null]) {
    const lido = parseRoundPolicyOverrides(entrada);
    assert.equal(lido.ok, true);
    assert.equal(lido.value, null);
  }
});

test('rodada válida atravessa a fronteira e passa a governar a política', () => {
  const { projeto, globalConfig } = cenarioDeCamadas();

  const lido = parseRoundPolicyOverrides({
    roundId: 'rodada-7',
    maxAttemptsPerPrompt: 9,
    loopGuard: { maxRepeatedReviewFingerprints: 6, maxChangedFilesPerPrompt: null },
  });
  assert.equal(lido.ok, true, lido.ok ? '' : lido.error.message);

  const resolvido = resolveEffectiveExecutionPolicy({
    globalConfig,
    projectConfig: projeto,
    roundConfig: lido.value,
  });
  assert.equal(resolvido.ok, true, resolvido.ok ? '' : resolvido.error.message);

  assert.equal(
    typeof resolvido.value.sources.roundConfigHash,
    'string',
    'com origem ligada, roundConfigHash deixa de ser null',
  );
  assert.equal(resolvido.value.sourceMetadata.roundId, 'rodada-7');
  assert.equal(resolvido.value.loopGuard.maxAttemptsPerPrompt, 9);
  assert.equal(resolvido.value.loopGuard.maxRepeatedReviewFingerprints, 6);
  assert.equal(
    resolvido.value.loopGuard.maxChangedFilesPerPrompt,
    null,
    'null na rodada é declaração explícita de "sem teto"',
  );
});

test('roundId é obrigatório: uma rodada sem identidade não é rastreável', () => {
  const semId = parseRoundPolicyOverrides({ maxAttemptsPerPrompt: 3 });
  assert.equal(semId.ok, false);
  assert.match(semId.error.message, /roundId/);
});

test('roundId passa pelo mesmo alfabeto dos demais identificadores', () => {
  for (const valor of ['../fuga', 'rodada com espaco', '', 'con', 'a'.repeat(101)]) {
    const lido = parseRoundPolicyOverrides({ roundId: valor });
    assert.equal(lido.ok, false, `"${valor}" deveria ser recusado`);
  }
  assert.equal(parseRoundPolicyOverrides({ roundId: 'rodada-1.2_final' }).ok, true);
});

test('campo não reconhecido é recusado em vez de ignorado', () => {
  const raiz = parseRoundPolicyOverrides({ roundId: 'r1', maxAttemptsPorPrompt: 3 });
  assert.equal(raiz.ok, false, 'um typo mudaria o hash sem mudar a política');
  assert.match(raiz.error.message, /não reconhecido/i);

  const dentro = parseRoundPolicyOverrides({
    roundId: 'r1',
    loopGuard: { maxClaudeCallsPorPrompt: 3 },
  });
  assert.equal(dentro.ok, false);
  assert.match(dentro.error.message, /loopGuard\.maxClaudeCallsPorPrompt/);
});

test('valor fora de faixa é recusado, não clampado', () => {
  const zero = parseRoundPolicyOverrides({ roundId: 'r1', maxAttemptsPerPrompt: 0 });
  assert.equal(zero.ok, false, 'clampar para 1 congelaria política diferente da pedida');

  const fracionario = parseRoundPolicyOverrides({ roundId: 'r1', maxReviewerRetries: 1.5 });
  assert.equal(fracionario.ok, false);

  const negativo = parseRoundPolicyOverrides({
    roundId: 'r1',
    loopGuard: { maxClaudeCallsPerPrompt: -1 },
  });
  assert.equal(negativo.ok, false);
});

test('tipo errado é recusado em cada camada do objeto', () => {
  assert.equal(parseRoundPolicyOverrides('rodada-1').ok, false, 'string não é objeto');
  assert.equal(parseRoundPolicyOverrides([{ roundId: 'r1' }]).ok, false, 'array não é objeto');
  assert.equal(
    parseRoundPolicyOverrides({ roundId: 'r1', continueAfterApproval: 'sim' }).ok,
    false,
  );
  assert.equal(parseRoundPolicyOverrides({ roundId: 'r1', loopGuard: 3 }).ok, false);
  assert.equal(
    parseRoundPolicyOverrides({ roundId: 'r1', loopGuard: { enabled: 1 } }).ok,
    false,
    'booleano não aceita número',
  );
});

test('null só é aceito onde significa "sem teto"', () => {
  const semTeto = parseRoundPolicyOverrides({
    roundId: 'r1',
    loopGuard: { maxChangedLinesPerPrompt: null },
  });
  assert.equal(semTeto.ok, true, semTeto.ok ? '' : semTeto.error.message);

  const naoNulavel = parseRoundPolicyOverrides({
    roundId: 'r1',
    loopGuard: { maxClaudeCallsPerPrompt: null },
  });
  assert.equal(naoNulavel.ok, false, 'null aqui seria confundido com "herdar"');
  assert.match(naoNulavel.error.message, /Omita o campo/);
});

test('rodadas com a mesma política produzem o mesmo hash', () => {
  const semLoopGuard = parseRoundPolicyOverrides({ roundId: 'r1' });
  const loopGuardVazio = parseRoundPolicyOverrides({ roundId: 'r1', loopGuard: {} });
  assert.equal(semLoopGuard.ok && loopGuardVazio.ok, true);
  assert.equal(
    roundConfigHashOf(semLoopGuard.value),
    roundConfigHashOf(loopGuardVazio.value),
    'um loopGuard vazio descreve a mesma política e não pode gerar outro hash',
  );

  const ordemA = parseRoundPolicyOverrides({
    roundId: 'r1',
    maxAttemptsPerPrompt: 5,
    loopGuard: { maxCiRepairCycles: 3, maxClaudeCallsPerPrompt: 2 },
  });
  const ordemB = parseRoundPolicyOverrides(
    reordenarChaves({
      roundId: 'r1',
      maxAttemptsPerPrompt: 5,
      loopGuard: { maxCiRepairCycles: 3, maxClaudeCallsPerPrompt: 2 },
    }),
  );
  assert.equal(ordemA.ok && ordemB.ok, true);
  assert.equal(
    roundConfigHashOf(ordemA.value),
    roundConfigHashOf(ordemB.value),
    'a ordem das chaves no JSON não tem significado',
  );

  const outra = parseRoundPolicyOverrides({ roundId: 'r1', maxAttemptsPerPrompt: 6 });
  assert.notEqual(
    roundConfigHashOf(ordemA.value),
    roundConfigHashOf(outra.value),
    'política diferente precisa de hash diferente',
  );
});

/* ------------------------------------------------------------------------ */
/* Auxiliares                                                                */
/* ------------------------------------------------------------------------ */

/** Devolve uma cópia profunda com as chaves de cada objeto em outra ordem. */
function reordenarChaves(value) {
  if (Array.isArray(value)) return value.map(reordenarChaves);
  if (value !== null && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort().reverse()) {
      out[key] = reordenarChaves(value[key]);
    }
    return out;
  }
  return value;
}
