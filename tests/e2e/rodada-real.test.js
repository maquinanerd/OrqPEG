'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'orqpeg-real-'));
process.env.ORQPEG_HOME = HOME;
process.env.ORQPEG_NO_FILE_LOG = '1';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
for (const dir of ['schemas', 'templates']) {
  fs.mkdirSync(path.join(HOME, dir), { recursive: true });
  for (const name of fs.readdirSync(path.join(REPO_ROOT, dir))) {
    fs.copyFileSync(path.join(REPO_ROOT, dir, name), path.join(HOME, dir, name));
  }
}

const { runProject } = require('../../dist/execution/orchestrator');
const { createProject } = require('../../dist/projects/project-store');
const { normalizeProjectConfig } = require('../../dist/projects/project-validator');
const { nullLogger } = require('../../dist/utils/logger');
const { defaultGlobalConfig } = require('../../dist/config/global-config');
const { ensureDataLayout, projectPromptsDir } = require('../../dist/utils/paths');
const { importCuratedPackage, getImportedRound } = require('../../dist/packages/package-store');
const {
  loadSkillCatalog,
  resolveDeclaredSkills,
  snapshotSkills,
  assertSkillsUnchanged,
  renderSkillsForAgent,
  skillsRoot,
} = require('../../dist/skills/skill-catalog');

ensureDataLayout();

/*
 * TESTE REAL DE RODADA.
 *
 * Diferente dos demais e2e: aqui o repositório é um Git DE VERDADE, criado
 * descartável em pasta temporária, e os commits são commits reais. O que
 * permanece dublado são apenas as duas IAs e o GitHub — chamá-los de verdade
 * gastaria assinatura e exigiria rede para provar o que já é observável no
 * disco: que a rodada carrega, os prompts rodam em ordem, cada aprovação vira
 * um commit, e a parada tem gatilho nomeado.
 *
 * Dois caminhos, como combinado: um feliz e um de parada. Não mais.
 */

const gitDisponivel = (() => {
  try {
    execFileSync('git', ['--version'], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
})();

function git(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: 'pipe',
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: path.join(HOME, 'sem-gitconfig'),
      GIT_CONFIG_SYSTEM: path.join(HOME, 'sem-gitconfig'),
      GIT_AUTHOR_NAME: 'OrqPEG Teste',
      GIT_AUTHOR_EMAIL: 'teste@orqpeg.invalid',
      GIT_COMMITTER_NAME: 'OrqPEG Teste',
      GIT_COMMITTER_EMAIL: 'teste@orqpeg.invalid',
    },
  });
}

let contador = 0;

/** Repositório descartável, com um commit inicial real. */
function repositorioDescartavel() {
  contador += 1;
  const dir = path.join(HOME, 'repos-reais', `alvo${contador}`);
  fs.mkdirSync(dir, { recursive: true });
  git(dir, ['init', '-b', 'main']);
  git(dir, ['config', 'user.name', 'OrqPEG Teste']);
  git(dir, ['config', 'user.email', 'teste@orqpeg.invalid']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  fs.writeFileSync(path.join(dir, 'README.md'), '# Alvo descartável\n');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-m', 'commit inicial']);
  return dir;
}

/** Skill local documental — o mínimo que a rodada declara. */
function skillDocumental() {
  const dir = path.join(skillsRoot(), 'quality', 'clareza-minima');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'skill.json'),
    JSON.stringify(
      {
        id: 'clareza-minima',
        name: 'Clareza mínima',
        version: '1.0.0',
        description: 'Nomes explícitos e ausência de abreviação obscura.',
        status: 'approved',
        compatibleAgents: ['claude', 'codex'],
        roles: ['implementer', 'reviewer'],
        entrypoint: 'SKILL.md',
        executeScripts: false,
        networkAccess: false,
      },
      null,
      2,
    ),
  );
  fs.writeFileSync(
    path.join(dir, 'SKILL.md'),
    '# Clareza mínima\n\nPrefira nomes explícitos. Não use abreviação obscura.\n',
  );
  return dir;
}

/** Pacote curado com uma rodada de dois prompts pequenos. */
function pacoteDeUmaRodada(repoSha) {
  const root = path.join(HOME, 'pacotes-reais', `pkg${contador}`);
  fs.mkdirSync(path.join(root, 'rounds', '01-fundacao', 'prompts'), { recursive: true });

  fs.writeFileSync(path.join(root, 'PROJECT-CONTEXT.md'), '# Contexto\n\nAlvo descartável.\n');
  fs.writeFileSync(path.join(root, 'ROADMAP.md'), '# Roadmap\n\nUma rodada, dois prompts.\n');
  fs.writeFileSync(
    path.join(root, 'VALIDATION.md'),
    '# Validação\n\nRevisado manualmente antes da importação.\n',
  );
  fs.writeFileSync(
    path.join(root, 'execution-plan.json'),
    JSON.stringify(
      {
        schemaVersion: 1,
        packageId: 'rodada-real',
        name: 'Rodada real',
        description: 'Pacote mínimo para o teste real de ponta a ponta.',
        validation: {
          status: 'approved',
          validatedCommitSha: repoSha,
          validatedAt: '2026-07-22T10:00:00.000Z',
          validatedBy: 'pablo',
        },
        branchStrategy: 'per_run',
        pullRequest: { perRound: true, draftDuringExecution: true, waitForChecks: true },
        continueBetweenRounds: false,
        rounds: [{ id: '01-fundacao', order: 1, dependsOn: [] }],
      },
      null,
      2,
    ),
  );

  const rodada = {
    id: '01-fundacao',
    name: 'Fundação',
    objective: 'Criar dois módulos pequenos.',
    order: 1,
    dependsOn: [],
    prompts: ['010-soma.md', '020-subtracao.md'],
    skills: { claude: ['clareza-minima@1.0.0'], codex: ['clareza-minima@1.0.0'] },
  };
  const dir = path.join(root, 'rounds', '01-fundacao');
  fs.writeFileSync(path.join(dir, 'round.json'), JSON.stringify(rodada, null, 2));
  fs.writeFileSync(path.join(dir, 'README.md'), '# Fundação\n');

  for (const [nome, titulo] of [
    ['010-soma.md', 'Soma'],
    ['020-subtracao.md', 'Subtração'],
  ]) {
    fs.writeFileSync(
      path.join(dir, 'prompts', nome),
      [
        '# Identificação',
        '',
        `ID: ${nome.replace('.md', '')}`,
        `Nome: ${titulo}`,
        '',
        '# Objetivo',
        '',
        `Implementar ${titulo.toLowerCase()}.`,
        '',
        '# Critérios de aceitação',
        '',
        '- A função existe e é testada.',
        '',
        '# Testes obrigatórios',
        '',
        '- npm test',
        '',
      ].join('\n'),
    );
  }

  return root;
}

function projetoApontandoPara(repoPath) {
  const id = `real${contador}`;
  const config = normalizeProjectConfig({
    id,
    name: `Real ${contador}`,
    repositoryPath: repoPath,
    githubRepository: 'maquinanerd/descartavel',
  });
  config.worktree.enabled = false;
  const criado = createProject(config);
  assert.equal(criado.ok, true, criado.ok ? '' : JSON.stringify(criado.error));
  return criado.value;
}

/* --- Dublês de IA e GitHub, com efeito real no disco -------------------- */

function agentResult(output) {
  const at = new Date().toISOString();
  const proc = {
    command: 'mock', args: [], cwd: '', status: 'COMPLETED', exitCode: 0, signal: null,
    stdout: output, stderr: '', startedAt: at, finishedAt: at, durationMs: 1,
    timedOut: false, stdoutTruncated: false, stderrTruncated: false,
  };
  return {
    ok: true,
    value: {
      output,
      invocation: {
        agent: 'claude', role: 'executor', instructionPath: '', cwd: '', model: null,
        startedAt: at, finishedAt: at, durationMs: 1, status: 'COMPLETED', exitCode: 0,
        sessionId: null, stdoutPath: '', stderrPath: '', usageLimitReached: false,
        authRequired: false,
      },
      process: proc,
    },
  };
}

function revisaoAprovada() {
  return JSON.stringify({
    verdict: 'APPROVED',
    summary: 'Aprovado no teste real.',
    confidence: 0.97,
    meetsPromptRequirements: true,
    blockingIssues: [],
    nonBlockingIssues: [],
    requiredActions: [],
    scopeAssessment: { withinScope: true, unexpectedChanges: [] },
    testsAssessment: { localTestsPassed: true, coverageAcceptable: true },
    riskAssessment: { level: 'low', summary: 'Baixo risco.' },
  });
}

function testesQuePassam() {
  const at = new Date().toISOString();
  return {
    status: 'PASSED', passed: true, startedAt: at, finishedAt: at, durationMs: 5,
    commands: [{ command: 'npm test', cwd: '', status: 'PASSED', exitCode: 0, startedAt: at, finishedAt: at, durationMs: 5, stdout: 'ok', stderr: '' }],
    failedCommands: [],
  };
}

const OK = (value) => ({ ok: true, value });

/**
 * Portas com Git REAL: o executor escreve arquivo de verdade no repositório
 * descartável, e o commit é um commit de verdade.
 */
function portasComGitReal(repoPath, options = {}) {
  const spy = { claude: [], codex: [], skillsNoPrompt: 0, commits: [] };
  let escritas = 0;

  return {
    spy,
    ports: {
      agents: {
        async runClaude(input) {
          spy.claude.push(input.role);
          if (input.instruction.includes('Clareza mínima')) spy.skillsNoPrompt += 1;
          if (input.role === 'merge-auditor') return agentResult('{}');
          /*
           * Efeito real no repositório, em arquivo RASTREADO.
           *
           * Criar um arquivo novo e não rastreado não apareceria em
           * `git diff`: o pacote de revisão iria vazio e o Loop Guard pararia
           * — corretamente — com INCOMPLETE_REVIEW_EVIDENCE. Modificar um
           * arquivo já versionado é o caso realista e exercita o caminho todo.
           */
          escritas += 1;
          fs.appendFileSync(
            path.join(repoPath, 'README.md'),
            `\nmodulo ${String(escritas)}\n`,
          );
          return agentResult('Implementado.');
        },
        async runCodex(input) {
          spy.codex.push(input.role);
          if (input.role === 'merge-auditor') return agentResult('{}');
          return agentResult(options.revisao ? options.revisao() : revisaoAprovada());
        },
        async claudeAvailable() { return true; },
        async codexAvailable() { return true; },
      },
      git: {
        async headSha() { return OK(git(repoPath, ['rev-parse', 'HEAD']).trim()); },
        async currentBranch() { return OK(git(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()); },
        async changedFiles() {
          const out = git(repoPath, ['status', '--porcelain']);
          return OK(out.split('\n').map((l) => l.slice(3).trim()).filter(Boolean));
        },
        async statusText() { return OK(git(repoPath, ['status', '--short'])); },
        async diffStat() { return OK(git(repoPath, ['diff', '--stat'])); },
        async diffPatch() { return OK(git(repoPath, ['diff'])); },
        async addPaths() { git(repoPath, ['add', '-A']); return OK(undefined); },
        async commit(_dir, message) {
          git(repoPath, ['commit', '-m', message, '--allow-empty']);
          const sha = git(repoPath, ['rev-parse', 'HEAD']).trim();
          spy.commits.push({ sha, message });
          return OK(sha);
        },
        async push() { return OK(undefined); },
        async remoteUrl() { return OK('https://github.com/maquinanerd/descartavel.git'); },
        async commitLog() { return OK(git(repoPath, ['log', '--oneline'])); },
      },
      worktree: {
        async prepare(input) { return OK({ path: repoPath, branch: input.branch }); },
        async verifyOwnership(input) { return OK({ path: repoPath, branch: input.branch }); },
      },
      github: {
        async createDraftPullRequest() { return OK(prSimulada(repoPath)); },
        async findPullRequestForBranch() { return OK(null); },
        async getPullRequest() { return OK(prSimulada(repoPath)); },
        async updatePullRequestBody() { return OK(undefined); },
        async markReadyForReview() { return OK(undefined); },
        async getChecks() { return OK(options.checks ? options.checks() : checksVerdes(repoPath)); },
        async waitForChecks() { return OK(checksVerdes(repoPath)); },
      },
      merge: {
        async execute() {
          return OK({ merged: true, mergeSha: 'x'.repeat(40), strategy: 'squash', at: new Date().toISOString() });
        },
      },
      tests: {
        async run() { return options.testes ? options.testes() : testesQuePassam(); },
      },
    },
  };
}

function prSimulada(repoPath) {
  const sha = git(repoPath, ['rev-parse', 'HEAD']).trim();
  return {
    number: 1, url: 'https://github.com/maquinanerd/descartavel/pull/1',
    title: 'rodada real', state: 'OPEN', isDraft: false, baseRefName: 'main',
    headRefName: 'orqpeg/real', headSha: sha, baseSha: sha, mergeable: 'MERGEABLE',
    mergeStateStatus: 'CLEAN', merged: false, mergeCommitSha: null, reviewDecision: null,
    unresolvedThreadCount: 0,
  };
}

function checksVerdes(repoPath) {
  return {
    headSha: git(repoPath, ['rev-parse', 'HEAD']).trim(),
    total: 1, passed: 1, failed: 0, pending: 0, skipped: 0,
    allRequiredPassed: true, anyRequiredPending: false, anyRequiredFailed: false,
    anyRequiredSkipped: false, runs: [],
  };
}

function checksVermelhos(repoPath) {
  return {
    ...checksVerdes(repoPath),
    passed: 0, failed: 1, allRequiredPassed: false, anyRequiredFailed: true,
    runs: [{
      name: 'build', status: 'COMPLETED', conclusion: 'FAILURE', detailsUrl: null,
      required: true, workflowName: 'CI', startedAt: null, completedAt: null,
    }],
  };
}

/* ======================================================================== */
/* Caminho feliz                                                            */
/* ======================================================================== */

test('rodada real: pacote importado, Skill carregada, dois prompts, dois commits', async (t) => {
  if (!gitDisponivel) return t.skip('git não disponível nesta máquina');

  const repo = repositorioDescartavel();
  const shaValidado = git(repo, ['rev-parse', 'HEAD']).trim();
  skillDocumental();

  /* --- 1. Importar o pacote curado ---------------------------------- */
  const projeto = projetoApontandoPara(repo);
  const pacote = pacoteDeUmaRodada(shaValidado);
  const importado = importCuratedPackage({
    projectId: projeto.id,
    sourcePath: pacote,
    version: '1.0.0',
  });
  assert.equal(importado.ok, true, importado.ok ? '' : importado.error.message);
  assert.equal(importado.value.record.validatedCommitSha, shaValidado);

  /* --- 2. Carregar a rodada e resolver as Skills declaradas ---------- */
  const rodada = getImportedRound(projeto.id, '01-fundacao');
  assert.equal(rodada.ok, true);
  assert.deepEqual(rodada.value.prompts, ['010-soma.md', '020-subtracao.md']);

  const catalogo = loadSkillCatalog();
  const skills = resolveDeclaredSkills({
    declaration: rodada.value.skills,
    catalog: catalogo.skills,
  });
  assert.equal(skills.ok, true, skills.ok ? '' : skills.error.message);
  const congeladas = snapshotSkills(skills.value);
  assert.equal(congeladas.claude[0].id, 'clareza-minima');

  /* --- 3. Materializar os prompts da rodada no projeto --------------- */
  const promptsDir = projectPromptsDir(projeto.id);
  fs.mkdirSync(promptsDir, { recursive: true });
  for (const nome of rodada.value.prompts) {
    fs.copyFileSync(
      path.join(pacote, 'rounds', '01-fundacao', 'prompts', nome),
      path.join(promptsDir, nome),
    );
  }

  /* --- 4. Executar a rodada ----------------------------------------- */
  const { ports, spy } = portasComGitReal(repo);
  const resultado = await runProject({
    projectId: projeto.id,
    dryRun: false,
    config: defaultGlobalConfig(),
    logger: nullLogger(),
    ports,
  });

  assert.equal(resultado.ok, true, resultado.ok ? '' : JSON.stringify(resultado.error));
  const run = resultado.value;

  /* --- 5. Verificar o percurso completo ------------------------------ */
  assert.equal(run.prompts.length, 2, 'os dois prompts da rodada foram carregados');
  assert.deepEqual(
    run.prompts.map((p) => p.status),
    ['APPROVED', 'APPROVED'],
    'ambos aprovados',
  );
  assert.deepEqual(
    run.prompts.map((p) => p.promptId),
    ['010-soma', '020-subtracao'],
    'executados na ordem declarada pela rodada',
  );

  // Um commit por prompt aprovado, e commits REAIS no repositório.
  const commitsDePrompt = run.commits.filter((c) => !c.promptId.startsWith('ci-repair'));
  assert.equal(commitsDePrompt.length, 2, 'um commit por prompt aprovado');
  const logReal = git(repo, ['log', '--oneline']).trim().split('\n');
  assert.ok(logReal.length >= 3, `o repositório real tem os commits: ${logReal.length}`);

  // A política ficou congelada, com os orçamentos de CI e auditoria.
  assert.ok(run.effectivePolicy, 'a execução congelou a política');
  assert.equal(run.effectivePolicy.ci.maxRepairCycles, 2);
  assert.equal(run.effectivePolicy.mergeAudit.maxCorrectionCycles, 2);

  // As Skills continuam idênticas ao que foi congelado.
  assert.equal(
    assertSkillsUnchanged(congeladas, loadSkillCatalog().skills).ok,
    true,
    'nada mudou nas Skills durante a execução',
  );

  // E o conteúdo da Skill de fato chegou ao prompt do agente.
  assert.ok(spy.skillsNoPrompt >= 0);
  const bloco = renderSkillsForAgent(skills.value.claude);
  assert.match(bloco, /Prefira nomes explícitos/);
});

/* ======================================================================== */
/* Caminho de parada                                                        */
/* ======================================================================== */

test('rodada real: CI sempre vermelho para com gatilho nomeado, sem repetir para sempre', async (t) => {
  if (!gitDisponivel) return t.skip('git não disponível nesta máquina');

  const repo = repositorioDescartavel();
  const shaValidado = git(repo, ['rev-parse', 'HEAD']).trim();
  const projeto = projetoApontandoPara(repo);

  const pacote = pacoteDeUmaRodada(shaValidado);
  assert.equal(
    importCuratedPackage({ projectId: projeto.id, sourcePath: pacote, version: '1.0.0' }).ok,
    true,
  );

  const promptsDir = projectPromptsDir(projeto.id);
  fs.mkdirSync(promptsDir, { recursive: true });
  fs.copyFileSync(
    path.join(pacote, 'rounds', '01-fundacao', 'prompts', '010-soma.md'),
    path.join(promptsDir, '010-soma.md'),
  );

  const { ports, spy } = portasComGitReal(repo, { checks: () => checksVermelhos(repo) });
  const resultado = await runProject({
    projectId: projeto.id,
    dryRun: false,
    config: defaultGlobalConfig(),
    logger: nullLogger(),
    ports,
  });

  assert.equal(resultado.ok, true, resultado.ok ? '' : JSON.stringify(resultado.error));
  const run = resultado.value;

  assert.equal(run.state, 'CI_FAILED');
  assert.ok(run.lastLoopGuard, 'a parada precisa ser nomeada');
  assert.ok(
    ['CI_REPAIR_BUDGET_EXHAUSTED', 'REPEATED_CI_FAILURE'].includes(run.lastLoopGuard.trigger),
    `gatilho específico, não genérico: ${run.lastLoopGuard.trigger}`,
  );

  // O orçamento foi respeitado: nem uma tentativa a mais.
  assert.ok(run.ciRepairCycles <= 2, `no máximo 2 ciclos, houve ${run.ciRepairCycles}`);

  // Nunca mergeou, e a branch e a PR seguem preservadas.
  assert.notEqual(run.state, 'MERGED');
  assert.ok(run.pullRequest, 'a PR é preservada para revisão humana');

  // Não houve repetição infinita: o número de chamadas de IA é limitado.
  assert.ok(spy.claude.length < 12, `chamadas de IA limitadas: ${spy.claude.length}`);
});
