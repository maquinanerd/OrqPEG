'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'orqpeg-pkg-'));
process.env.ORQPEG_HOME = HOME;
process.env.ORQPEG_NO_FILE_LOG = '1';

const { readCuratedPackage } = require('../../dist/packages/package-reader');
const {
  importCuratedPackage,
  getImportedPackage,
  getImportedRound,
} = require('../../dist/packages/package-store');
const {
  loadSkillCatalog,
  resolveDeclaredSkills,
  snapshotSkills,
  assertSkillsUnchanged,
  parseSkillRef,
  renderSkillsForAgent,
  skillsRoot,
} = require('../../dist/skills/skill-catalog');
const { createProject } = require('../../dist/projects/project-store');
const { normalizeProjectConfig } = require('../../dist/projects/project-validator');
const { ensureDataLayout } = require('../../dist/utils/paths');

ensureDataLayout();

/*
 * Pacotes curados e Skills locais.
 *
 * O OrqPEG não planeja: o plano nasce fora, é validado à mão e só então é
 * importado. A regra que estes testes prendem é "validar e recusar, nunca
 * consertar" — um importador que completa seções decide pelo autor.
 */

const SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';

let contador = 0;

/** Monta um pacote válido em disco e devolve a raiz. Cada chamada é isolada. */
function pacoteValido(patch = {}) {
  contador += 1;
  const root = path.join(HOME, 'pacotes', `pkg${contador}`);
  fs.mkdirSync(root, { recursive: true });

  fs.writeFileSync(path.join(root, 'PROJECT-CONTEXT.md'), '# Contexto\n\nProjeto de teste.\n');
  fs.writeFileSync(path.join(root, 'ROADMAP.md'), '# Roadmap\n\nDuas rodadas.\n');
  fs.writeFileSync(path.join(root, 'VALIDATION.md'), '# Validação\n\nRevisado à mão.\n');

  const plano = {
    schemaVersion: 1,
    packageId: 'pacote-teste',
    name: 'Pacote de teste',
    description: 'Pacote curado para exercitar o importador.',
    validation: {
      status: 'approved',
      validatedCommitSha: SHA,
      validatedAt: '2026-07-22T10:00:00.000Z',
      validatedBy: 'pablo',
    },
    branchStrategy: 'per_run',
    pullRequest: { perRound: true, draftDuringExecution: true, waitForChecks: true },
    continueBetweenRounds: false,
    rounds: [
      { id: '01-fundacao', order: 1, dependsOn: [] },
      { id: '02-interface', order: 2, dependsOn: ['01-fundacao'] },
    ],
    ...(patch.plano ?? {}),
  };
  fs.writeFileSync(path.join(root, 'execution-plan.json'), JSON.stringify(plano, null, 2));

  const rodadas = patch.rodadas ?? [
    {
      id: '01-fundacao',
      name: 'Fundação',
      objective: 'Criar a base.',
      order: 1,
      dependsOn: [],
      prompts: ['010-database.md', '020-backend.md'],
      skills: { claude: [], codex: [] },
    },
    {
      id: '02-interface',
      name: 'Interface',
      objective: 'Construir a interface.',
      order: 2,
      dependsOn: ['01-fundacao'],
      prompts: ['010-tela.md'],
      skills: { claude: [], codex: [] },
    },
  ];

  for (const rodada of rodadas) {
    const dir = path.join(root, 'rounds', rodada.id);
    fs.mkdirSync(path.join(dir, 'prompts'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'round.json'), JSON.stringify(rodada, null, 2));
    fs.writeFileSync(path.join(dir, 'README.md'), `# ${rodada.name}\n`);
    for (const prompt of rodada.prompts) {
      fs.writeFileSync(path.join(dir, 'prompts', prompt), `# ${prompt}\n\nConteúdo.\n`);
    }
  }

  return root;
}

function projeto() {
  contador += 1;
  const id = `pkgproj${contador}`;
  const repoPath = path.join(HOME, 'repos', id);
  fs.mkdirSync(repoPath, { recursive: true });
  const criado = createProject(
    normalizeProjectConfig({
      id,
      name: `Projeto ${contador}`,
      repositoryPath: repoPath,
      githubRepository: 'maquinanerd/demo',
    }),
  );
  assert.equal(criado.ok, true, criado.ok ? '' : JSON.stringify(criado.error));
  return criado.value;
}

/* ------------------------------------------------------------------------ */
/* Pacote válido                                                             */
/* ------------------------------------------------------------------------ */

test('um pacote completo e coerente é lido com as rodadas em ordem', () => {
  const resultado = readCuratedPackage(pacoteValido());
  assert.equal(resultado.ok, true, resultado.ok ? '' : resultado.error.message);

  const pkg = resultado.value;
  assert.equal(pkg.plan.packageId, 'pacote-teste');
  assert.equal(pkg.plan.continueBetweenRounds, false, 'o padrão não encadeia rodadas');
  assert.deepEqual(
    pkg.rounds.map((r) => r.id),
    ['01-fundacao', '02-interface'],
  );
  assert.deepEqual(pkg.rounds[0].prompts, ['010-database.md', '020-backend.md']);
  assert.ok(pkg.packageHash, 'o pacote é hasheado para congelamento');
  assert.match(pkg.documents.projectContext, /Contexto/);
});

test('pacotes idênticos têm o mesmo hash; qualquer mudança real muda o hash', () => {
  const a = readCuratedPackage(pacoteValido());
  const b = readCuratedPackage(pacoteValido());
  assert.equal(a.value.packageHash, b.value.packageHash, 'mesmo conteúdo, mesmo hash');

  const raiz = pacoteValido();
  fs.writeFileSync(path.join(raiz, 'ROADMAP.md'), '# Roadmap\n\nMUDOU.\n');
  const c = readCuratedPackage(raiz);
  assert.notEqual(c.value.packageHash, a.value.packageHash);
});

/* ------------------------------------------------------------------------ */
/* Pacote inválido — validar e RECUSAR, nunca consertar                      */
/* ------------------------------------------------------------------------ */

test('documento obrigatório ausente invalida o pacote', () => {
  const raiz = pacoteValido();
  fs.rmSync(path.join(raiz, 'ROADMAP.md'));

  const resultado = readCuratedPackage(raiz);
  assert.equal(resultado.ok, false);
  assert.match(resultado.error.message, /PACOTE INVÁLIDO/);
  assert.match(resultado.error.message, /ROADMAP\.md/);
  // A recusa nunca vira conserto automático.
  assert.equal(fs.existsSync(path.join(raiz, 'ROADMAP.md')), false, 'nada é criado pelo OrqPEG');
});

test('pacote não validado à mão é recusado mesmo estando completo', () => {
  const raiz = pacoteValido({
    plano: {
      validation: {
        status: 'draft',
        validatedCommitSha: SHA,
        validatedAt: '2026-07-22T10:00:00.000Z',
        validatedBy: 'pablo',
      },
    },
  });

  const resultado = readCuratedPackage(raiz);
  assert.equal(resultado.ok, false);
  assert.match(resultado.error.message, /approved/);
});

test('validatedCommitSha ausente ou inválido é recusado', () => {
  const raiz = pacoteValido({
    plano: {
      validation: {
        status: 'approved',
        validatedCommitSha: 'nao-e-sha',
        validatedAt: '2026-07-22T10:00:00.000Z',
        validatedBy: 'pablo',
      },
    },
  });

  const resultado = readCuratedPackage(raiz);
  assert.equal(resultado.ok, false);
  assert.match(resultado.error.message, /validatedCommitSha/);
});

test('dependência inexistente é recusada', () => {
  const raiz = pacoteValido({
    rodadas: [
      {
        id: '01-fundacao',
        name: 'Fundação',
        objective: 'Base.',
        order: 1,
        dependsOn: ['99-inexistente'],
        prompts: ['010-database.md'],
        skills: { claude: [], codex: [] },
      },
    ],
    plano: { rounds: [{ id: '01-fundacao', order: 1, dependsOn: ['99-inexistente'] }] },
  });

  const resultado = readCuratedPackage(raiz);
  assert.equal(resultado.ok, false);
  assert.match(resultado.error.message, /99-inexistente/);
});

test('ciclo de dependências entre rodadas é recusado', () => {
  const raiz = pacoteValido({
    rodadas: [
      {
        id: '01-fundacao', name: 'A', objective: 'a.', order: 1,
        dependsOn: ['02-interface'], prompts: ['010-database.md'], skills: { claude: [], codex: [] },
      },
      {
        id: '02-interface', name: 'B', objective: 'b.', order: 2,
        dependsOn: ['01-fundacao'], prompts: ['010-tela.md'], skills: { claude: [], codex: [] },
      },
    ],
  });

  const resultado = readCuratedPackage(raiz);
  assert.equal(resultado.ok, false);
  assert.match(resultado.error.message, /ciclo/i);
});

test('rodada sem prompt é recusada', () => {
  const raiz = pacoteValido();
  const dir = path.join(raiz, 'rounds', '02-interface');
  fs.rmSync(path.join(dir, 'prompts', '010-tela.md'));

  const resultado = readCuratedPackage(raiz);
  assert.equal(resultado.ok, false);
  assert.match(resultado.error.message, /prompt/i);
});

test('prompt em disco não declarado no round.json é recusado', () => {
  const raiz = pacoteValido();
  fs.writeFileSync(
    path.join(raiz, 'rounds', '01-fundacao', 'prompts', '030-esquecido.md'),
    '# esquecido\n',
  );

  const resultado = readCuratedPackage(raiz);
  assert.equal(resultado.ok, false);
  assert.match(resultado.error.message, /030-esquecido\.md/);
  assert.match(resultado.error.message, /não seria executado/);
});

test('rodada em disco fora do plano é recusada, e vice-versa', () => {
  const raiz = pacoteValido({
    plano: { rounds: [{ id: '01-fundacao', order: 1, dependsOn: [] }] },
  });

  const resultado = readCuratedPackage(raiz);
  assert.equal(resultado.ok, false);
  assert.match(resultado.error.message, /02-interface/);
});

test('a recusa lista TODOS os problemas de uma vez', () => {
  const raiz = pacoteValido();
  fs.rmSync(path.join(raiz, 'ROADMAP.md'));
  fs.rmSync(path.join(raiz, 'VALIDATION.md'));

  const resultado = readCuratedPackage(raiz);
  assert.equal(resultado.ok, false);
  assert.equal(resultado.error.details.problems.length >= 2, true, 'não para no primeiro erro');
});

/* ------------------------------------------------------------------------ */
/* Importação                                                                */
/* ------------------------------------------------------------------------ */

test('importar copia o pacote e preserva a origem intacta', () => {
  const proj = projeto();
  const raiz = pacoteValido();

  const resultado = importCuratedPackage({ projectId: proj.id, sourcePath: raiz, version: '1.0.0' });
  assert.equal(resultado.ok, true, resultado.ok ? '' : resultado.error.message);

  const registro = getImportedPackage(proj.id);
  assert.equal(registro.value.version, '1.0.0');
  assert.equal(registro.value.validatedCommitSha, SHA);
  assert.deepEqual(registro.value.roundIds, ['01-fundacao', '02-interface']);

  // A origem continua completa: importar é copiar, não mover.
  assert.equal(fs.existsSync(path.join(raiz, 'execution-plan.json')), true);
  assert.equal(fs.existsSync(path.join(raiz, 'rounds', '01-fundacao', 'round.json')), true);

  // E a rodada é lida da CÓPIA, não da origem.
  const rodada = getImportedRound(proj.id, '01-fundacao');
  assert.equal(rodada.ok, true);
  assert.equal(rodada.value.name, 'Fundação');
});

test('pacote inválido não deixa rastro nenhum no projeto', () => {
  const proj = projeto();
  const raiz = pacoteValido();
  fs.rmSync(path.join(raiz, 'execution-plan.json'));

  const resultado = importCuratedPackage({ projectId: proj.id, sourcePath: raiz, version: '1.0.0' });
  assert.equal(resultado.ok, false);

  const registro = getImportedPackage(proj.id);
  assert.equal(registro.value, null, 'nada foi importado');
});

test('reimportar a MESMA versão com conteúdo diferente exige confirmação', () => {
  const proj = projeto();
  const raiz = pacoteValido();

  assert.equal(
    importCuratedPackage({ projectId: proj.id, sourcePath: raiz, version: '1.0.0' }).ok,
    true,
  );

  fs.writeFileSync(path.join(raiz, 'ROADMAP.md'), '# Roadmap\n\nOutro conteúdo.\n');
  const semConfirmar = importCuratedPackage({
    projectId: proj.id,
    sourcePath: raiz,
    version: '1.0.0',
  });
  assert.equal(semConfirmar.ok, false, 'sobrescrever em silêncio é inaceitável');
  assert.match(semConfirmar.error.message, /versão nova|substituição/i);

  const confirmando = importCuratedPackage({
    projectId: proj.id,
    sourcePath: raiz,
    version: '1.0.0',
    replaceExisting: true,
  });
  assert.equal(confirmando.ok, true, 'com intenção explícita, substitui');
});

test('reimportar o pacote idêntico é recusado como no-op', () => {
  const proj = projeto();
  const raiz = pacoteValido();
  importCuratedPackage({ projectId: proj.id, sourcePath: raiz, version: '1.0.0' });

  const denovo = importCuratedPackage({ projectId: proj.id, sourcePath: raiz, version: '1.0.0' });
  assert.equal(denovo.ok, false);
  assert.match(denovo.error.message, /já está importado/i);
});

/* ------------------------------------------------------------------------ */
/* Skills locais                                                             */
/* ------------------------------------------------------------------------ */

function skill(id, patch = {}, conteudo = '# Regras\n\nUse tipos estritos.\n') {
  const dir = path.join(skillsRoot(), patch.category ?? 'quality', id);
  fs.mkdirSync(dir, { recursive: true });
  const manifesto = {
    id,
    name: id,
    version: '1.0.0',
    description: 'Skill de teste.',
    status: 'approved',
    compatibleAgents: ['claude', 'codex'],
    roles: ['implementer'],
    entrypoint: 'SKILL.md',
    executeScripts: false,
    networkAccess: false,
    ...patch.manifest,
  };
  fs.writeFileSync(path.join(dir, 'skill.json'), JSON.stringify(manifesto, null, 2));
  fs.writeFileSync(path.join(dir, 'SKILL.md'), conteudo);
  return dir;
}

test('parseSkillRef exige o formato <id>@<versao>', () => {
  assert.equal(parseSkillRef('typescript-strict@1.0.0').ok, true);
  assert.equal(parseSkillRef('typescript-strict').ok, false, 'sem versão é ambíguo');
  assert.equal(parseSkillRef('typescript-strict@1.0').ok, false);
});

test('o catálogo carrega Skills válidas e reporta as inválidas', () => {
  skill('skill-boa');
  // Manifesto que promete executar script: recusa dura, não aviso.
  skill('skill-script', { manifest: { executeScripts: true } });

  const catalogo = loadSkillCatalog();
  const ids = catalogo.skills.map((s) => s.manifest.id);
  assert.equal(ids.includes('skill-boa'), true);
  assert.equal(ids.includes('skill-script'), false, 'Skill que executa script não é carregada');
  assert.equal(
    catalogo.problems.some((p) => /skill-script/.test(p) && /executeScripts/.test(p)),
    true,
    'a recusa é reportada, não engolida',
  );
});

test('Skill declarada e presente é resolvida e congelada', () => {
  skill('regra-a');
  const catalogo = loadSkillCatalog().skills;

  const resolvido = resolveDeclaredSkills({
    declaration: { claude: ['regra-a@1.0.0'], codex: [] },
    catalog: catalogo,
  });
  assert.equal(resolvido.ok, true, resolvido.ok ? '' : resolvido.error.message);
  assert.equal(resolvido.value.claude.length, 1);

  const snap = snapshotSkills(resolvido.value);
  assert.equal(snap.claude[0].id, 'regra-a');
  assert.equal(snap.claude[0].version, '1.0.0');
  assert.ok(snap.claude[0].contentHash, 'o conteúdo é congelado por hash');
});

test('Skill AUSENTE bloqueia a rodada', () => {
  const resolvido = resolveDeclaredSkills({
    declaration: { claude: ['nao-existe@1.0.0'], codex: [] },
    catalog: loadSkillCatalog().skills,
  });
  assert.equal(resolvido.ok, false);
  assert.match(resolvido.error.message, /não existe no catálogo/);
});

test('versão DIVERGENTE bloqueia a rodada', () => {
  skill('regra-b');
  const resolvido = resolveDeclaredSkills({
    declaration: { claude: ['regra-b@2.0.0'], codex: [] },
    catalog: loadSkillCatalog().skills,
  });
  assert.equal(resolvido.ok, false);
  assert.match(resolvido.error.message, /2\.0\.0/);
  assert.match(resolvido.error.message, /1\.0\.0/);
});

test('Skill não aprovada não pode ser ativada', () => {
  skill('regra-rascunho', { manifest: { status: 'draft' } });
  const resolvido = resolveDeclaredSkills({
    declaration: { claude: ['regra-rascunho@1.0.0'], codex: [] },
    catalog: loadSkillCatalog().skills,
  });
  assert.equal(resolvido.ok, false);
  assert.match(resolvido.error.message, /draft/);
});

test('Skill incompatível com o agente declarado é recusada', () => {
  skill('so-codex', { manifest: { compatibleAgents: ['codex'] } });
  const resolvido = resolveDeclaredSkills({
    declaration: { claude: ['so-codex@1.0.0'], codex: [] },
    catalog: loadSkillCatalog().skills,
  });
  assert.equal(resolvido.ok, false);
  assert.match(resolvido.error.message, /compatibilidade/);
});

test('Skill EDITADA durante a execução bloqueia', () => {
  const dir = skill('regra-mutante');
  const resolvido = resolveDeclaredSkills({
    declaration: { claude: ['regra-mutante@1.0.0'], codex: [] },
    catalog: loadSkillCatalog().skills,
  });
  const snap = snapshotSkills(resolvido.value);

  // Antes da edição, o snapshot confere.
  assert.equal(assertSkillsUnchanged(snap, loadSkillCatalog().skills).ok, true);

  fs.writeFileSync(path.join(dir, 'SKILL.md'), '# Regras\n\nREGRAS COMPLETAMENTE DIFERENTES.\n');
  const depois = assertSkillsUnchanged(snap, loadSkillCatalog().skills);
  assert.equal(depois.ok, false, 'editar a Skill no meio muda as regras entre tentativas');
  assert.match(depois.error.message, /editada durante a execução/);
});

test('Skill REMOVIDA durante a execução bloqueia', () => {
  const dir = skill('regra-sumida');
  const resolvido = resolveDeclaredSkills({
    declaration: { codex: ['regra-sumida@1.0.0'], claude: [] },
    catalog: loadSkillCatalog().skills,
  });
  const snap = snapshotSkills(resolvido.value);

  fs.rmSync(dir, { recursive: true, force: true });
  const depois = assertSkillsUnchanged(snap, loadSkillCatalog().skills);
  assert.equal(depois.ok, false);
  assert.match(depois.error.message, /removida/);
});

test('o bloco enviado ao agente declara que a Skill não amplia escopo', () => {
  skill('regra-texto', {}, '# Estilo\n\nPrefira funções puras.\n');
  const resolvido = resolveDeclaredSkills({
    declaration: { claude: ['regra-texto@1.0.0'], codex: [] },
    catalog: loadSkillCatalog().skills,
  });

  const bloco = renderSkillsForAgent(resolvido.value.claude);
  assert.match(bloco, /Prefira funções puras/, 'o conteúdo da Skill chega ao agente');
  assert.match(bloco, /não ampliam o escopo/i);
  assert.match(bloco, /não dispensam nenhum\s+teste/i);
});

test('sem Skills declaradas, nada é acrescentado ao prompt', () => {
  assert.equal(renderSkillsForAgent([]), '');
});
