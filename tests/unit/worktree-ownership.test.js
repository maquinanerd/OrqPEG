'use strict';

/**
 * Prova POSITIVA de propriedade do worktree.
 *
 * Estes testes NÃO usam dublês de Git: repositórios reais são criados em
 * diretório temporário com `git init` e `git worktree add`. A regressão que se
 * quer impedir só aparece com o Git de verdade — um worktree secundário tem
 * `.git` ARQUIVO, um merge em conflito mantém o HEAD ANEXADO à branch certa, e
 * um subdiretório de worktree responde `rev-parse` como se fosse o worktree.
 * Qualquer dublê que respondesse "a branch é a esperada" aprovaria os três.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'orqpeg-wto-home-'));
process.env.ORQPEG_HOME = HOME;
process.env.ORQPEG_NO_FILE_LOG = '1';

/* Isola o Git das configurações global/de sistema da máquina do desenvolvedor:
   `buildToolEnv` copia `process.env`, então isto também vale para os processos
   Git disparados pelo código de produção. */
const GIT_CONFIG_ISOLADO = path.join(HOME, 'gitconfig-inexistente');
process.env.GIT_CONFIG_GLOBAL = GIT_CONFIG_ISOLADO;
process.env.GIT_CONFIG_SYSTEM = GIT_CONFIG_ISOLADO;
process.env.GIT_TERMINAL_PROMPT = '0';

const { setOrqpegRootForTesting } = require('../../dist/utils/paths');
setOrqpegRootForTesting(HOME);

const {
  verifyWorktreeOwnership,
  detectGitOperationInProgress,
  listWorktrees,
  findWorktreeByPath,
} = require('../../dist/git/worktree');
const { status } = require('../../dist/git/git');

/* ------------------------------------------------------------------------ */
/* Infraestrutura: repositórios Git reais                                    */
/* ------------------------------------------------------------------------ */

const GIT_DISPONIVEL = temGit();

function temGit() {
  try {
    const resultado = spawnSync('git', ['--version'], { encoding: 'utf8' });
    return resultado.status === 0;
  } catch {
    return false;
  }
}

/** Executa o Git exigindo sucesso. */
function git(cwd, args) {
  const resultado = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  if (resultado.status !== 0) {
    throw new Error(
      `git ${args.join(' ')} (em ${cwd}) falhou com código ${String(resultado.status)}: ` +
        `${String(resultado.stderr || resultado.stdout).trim()}`,
    );
  }
  return String(resultado.stdout);
}

/** Executa o Git aceitando falha — usado para provocar conflitos de propósito. */
function gitTolerante(cwd, args) {
  const resultado = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  return { code: resultado.status, out: String(resultado.stdout ?? '') };
}

function escreve(arquivo, conteudo) {
  fs.mkdirSync(path.dirname(arquivo), { recursive: true });
  fs.writeFileSync(arquivo, conteudo, 'utf8');
}

function commitDe(dir, conteudo, mensagem) {
  escreve(path.join(dir, 'arquivo.txt'), conteudo);
  git(dir, ['add', '--all']);
  git(dir, ['commit', '--message', mensagem]);
}

let fx = null;
let raizTemporaria = null;

function montarFixture() {
  /* `realpathSync` desfaz nomes curtos (C:\Users\PABLO~1) e links do /var:
     `git worktree list` devolve o caminho real e a comparação é literal. */
  raizTemporaria = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orqpeg-wto-')));

  const repo = path.join(raizTemporaria, 'repo');
  const raizAutorizada = path.join(raizTemporaria, 'worktrees');
  const foraDaRaiz = path.join(raizTemporaria, 'fora');
  fs.mkdirSync(repo, { recursive: true });
  fs.mkdirSync(raizAutorizada, { recursive: true });
  fs.mkdirSync(foraDaRaiz, { recursive: true });

  git(repo, ['init']);
  git(repo, ['config', 'user.name', 'OrqPEG Teste']);
  git(repo, ['config', 'user.email', 'teste@orqpeg.invalid']);
  git(repo, ['config', 'commit.gpgsign', 'false']);

  commitDe(repo, 'linha original\n', 'commit inicial');
  const base = git(repo, ['rev-parse', '--abbrev-ref', 'HEAD']).trim();

  /* Branch que conflita com todas as outras na MESMA linha do MESMO arquivo. */
  git(repo, ['checkout', '-b', 'trabalho/conflito']);
  commitDe(repo, 'linha do conflito\n', 'altera a linha disputada');
  git(repo, ['checkout', base]);

  const adotado = path.join(raizAutorizada, 'run-adotado');
  const outro = path.join(raizAutorizada, 'run-outro');
  const comMerge = path.join(raizAutorizada, 'run-merge');
  const comCherry = path.join(raizAutorizada, 'run-cherry');
  const destacado = path.join(raizAutorizada, 'run-destacado');
  const travado = path.join(raizAutorizada, 'run-travado');
  const solto = path.join(raizAutorizada, 'run-solto');
  const externo = path.join(foraDaRaiz, 'run-externo');

  git(repo, ['worktree', 'add', '-b', 'trabalho/adotado', adotado, base]);
  git(repo, ['worktree', 'add', '-b', 'trabalho/outro', outro, base]);
  git(repo, ['worktree', 'add', '-b', 'trabalho/merge', comMerge, base]);
  git(repo, ['worktree', 'add', '-b', 'trabalho/cherry', comCherry, base]);
  git(repo, ['worktree', 'add', '-b', 'trabalho/destacado', destacado, base]);
  git(repo, ['worktree', 'add', '-b', 'trabalho/travado', travado, base]);
  git(repo, ['worktree', 'add', '-b', 'trabalho/externo', externo, base]);

  /* HEAD destacado de verdade: `git worktree list` passa a emitir "detached"
     e nenhuma linha "branch". */
  git(destacado, ['checkout', '--detach']);

  /* Trava administrativa de verdade: `git worktree list` passa a emitir
     "locked". O diretório continua na branch esperada e limpo. */
  git(repo, ['worktree', 'lock', travado]);

  /* Commit próprio da execução adotada ANTES de sujá-la: com isso o HEAD deste
     worktree é único no repositório, e o `headSha` devolvido pela verificação
     identifica este worktree — e nenhum outro. */
  commitDe(adotado, 'linha da execucao adotada\n', 'commit proprio da execucao adotada');

  /* Worktree do caso feliz: SUJO, com arquivo rastreado modificado e um
     arquivo novo não rastreado — exatamente o que o OrqPEG preserva ao parar. */
  escreve(path.join(adotado, 'arquivo.txt'), 'trabalho em andamento, nao commitado\n');
  escreve(path.join(adotado, 'nao-rastreado.txt'), 'rascunho\n');

  /* Diretório comum DENTRO de um worktree registrado: `git -C` responde por ele
     com a branch certa, e mesmo assim ele não é worktree nenhum. */
  const subdiretorio = path.join(adotado, 'subdiretorio');
  escreve(path.join(subdiretorio, 'conteudo.txt'), 'nada de git aqui\n');
  escreve(path.join(solto, 'conteudo.txt'), 'diretorio solto\n');

  /* Merge real deixado pela metade. */
  commitDe(comMerge, 'linha do merge\n', 'altera a linha disputada no worktree de merge');
  const merge = gitTolerante(comMerge, ['merge', '--no-edit', 'trabalho/conflito']);

  /* Cherry-pick real deixado pela metade. */
  commitDe(comCherry, 'linha do cherry\n', 'altera a linha disputada no worktree de cherry');
  const cherry = gitTolerante(comCherry, ['cherry-pick', 'trabalho/conflito']);

  return {
    repo,
    base,
    raizAutorizada,
    foraDaRaiz,
    adotado,
    outro,
    comMerge,
    comCherry,
    destacado,
    travado,
    solto,
    subdiretorio,
    externo,
    mergeConflitou: merge.code !== 0,
    cherryConflitou: cherry.code !== 0,
  };
}

test.before(() => {
  if (!GIT_DISPONIVEL) return;
  fx = montarFixture();
});

test.after(() => {
  if (raizTemporaria === null) return;
  try {
    fs.rmSync(raizTemporaria, { recursive: true, force: true, maxRetries: 5 });
  } catch {
    /* Lixo em diretório temporário não invalida o resultado da suíte. */
  }
});

/** Entrada de `verifyWorktreeOwnership` com os valores do caso feliz. */
function entrada(sobrescritas = {}) {
  return {
    repoDir: fx.repo,
    worktreePath: fx.adotado,
    canonicalPath: fx.adotado,
    branch: 'trabalho/adotado',
    allowedRoot: fx.raizAutorizada,
    ...sobrescritas,
  };
}

function assertFalha(resultado, codigo, contexto) {
  assert.equal(resultado.ok, false, `${contexto}: a adoção deveria ter sido recusada`);
  assert.equal(
    resultado.error.code,
    codigo,
    `${contexto}: código esperado ${codigo}, veio ${resultado.error.code} (${resultado.error.message})`,
  );
}

function pular(t) {
  if (GIT_DISPONIVEL) return false;
  t.skip('git não está disponível no PATH; o teste exige repositórios reais');
  return true;
}

/* ------------------------------------------------------------------------ */
/* 1. Diretório que não é worktree registrado                                */
/* ------------------------------------------------------------------------ */

test('diretório comum no caminho canônico é recusado por não ser worktree registrado', async (t) => {
  if (pular(t)) return;

  /* O subdiretório fica DENTRO de um worktree registrado e na branch esperada:
     `git -C <subdiretorio> rev-parse --abbrev-ref HEAD` responde exatamente
     "trabalho/adotado". Uma verificação baseada só na branch aprovaria. */
  const respostaDoGit = git(fx.subdiretorio, ['rev-parse', '--abbrev-ref', 'HEAD']).trim();
  assert.equal(
    respostaDoGit,
    'trabalho/adotado',
    'pré-condição: o subdiretório precisa responder com a branch esperada',
  );

  const dentroDeWorktree = await verifyWorktreeOwnership(
    entrada({ worktreePath: fx.subdiretorio, canonicalPath: fx.subdiretorio }),
  );
  assertFalha(dentroDeWorktree, 'WORKTREE_NOT_REGISTERED', 'subdiretório de worktree');
  assert.equal(dentroDeWorktree.error.details.worktreePath, fx.subdiretorio);

  const diretorioSolto = await verifyWorktreeOwnership(
    entrada({
      worktreePath: fx.solto,
      canonicalPath: fx.solto,
      branch: 'trabalho/solto',
    }),
  );
  assertFalha(diretorioSolto, 'WORKTREE_NOT_REGISTERED', 'diretório solto');

  /* A pasta continua intacta: recusar nunca é apagar. */
  assert.ok(fs.existsSync(path.join(fx.solto, 'conteudo.txt')));
  assert.ok(fs.existsSync(path.join(fx.subdiretorio, 'conteudo.txt')));
});

/* ------------------------------------------------------------------------ */
/* 2. Operação do Git pela metade                                            */
/* ------------------------------------------------------------------------ */

test('merge em conflito no worktree bloqueia a adoção com GIT_OPERATION_IN_PROGRESS', async (t) => {
  if (pular(t)) return;
  assert.ok(fx.mergeConflitou, 'pré-condição: o "git merge" precisava falhar com conflito');

  /* O merge conflitado NÃO destaca o HEAD: a branch continua sendo a esperada,
     e é justamente por isso que a checagem por branch não bastava. */
  const branchDurante = git(fx.comMerge, ['rev-parse', '--abbrev-ref', 'HEAD']).trim();
  assert.equal(branchDurante, 'trabalho/merge');

  const deteccao = await detectGitOperationInProgress(fx.comMerge);
  assert.equal(deteccao.ok, true);
  assert.equal(deteccao.value, 'merge');

  const resultado = await verifyWorktreeOwnership(
    entrada({
      worktreePath: fx.comMerge,
      canonicalPath: fx.comMerge,
      branch: 'trabalho/merge',
    }),
  );
  assertFalha(resultado, 'GIT_OPERATION_IN_PROGRESS', 'merge em andamento');
  assert.equal(resultado.error.details.operation, 'merge');
});

test('cherry-pick em conflito no worktree bloqueia a adoção com GIT_OPERATION_IN_PROGRESS', async (t) => {
  if (pular(t)) return;
  assert.ok(
    fx.cherryConflitou,
    'pré-condição: o "git cherry-pick" precisava falhar com conflito',
  );

  const branchDurante = git(fx.comCherry, ['rev-parse', '--abbrev-ref', 'HEAD']).trim();
  assert.equal(branchDurante, 'trabalho/cherry');

  const deteccao = await detectGitOperationInProgress(fx.comCherry);
  assert.equal(deteccao.ok, true);
  assert.equal(deteccao.value, 'cherry-pick');

  const resultado = await verifyWorktreeOwnership(
    entrada({
      worktreePath: fx.comCherry,
      canonicalPath: fx.comCherry,
      branch: 'trabalho/cherry',
    }),
  );
  assertFalha(resultado, 'GIT_OPERATION_IN_PROGRESS', 'cherry-pick em andamento');
  assert.equal(resultado.error.details.operation, 'cherry-pick');
});

/* ------------------------------------------------------------------------ */
/* 3. Worktree de outra execução                                             */
/* ------------------------------------------------------------------------ */

test('worktree registrado em outra branch é recusado como sendo de outra execução', async (t) => {
  if (pular(t)) return;

  const resultado = await verifyWorktreeOwnership(
    entrada({
      worktreePath: fx.outro,
      canonicalPath: fx.outro,
      branch: 'trabalho/adotado',
    }),
  );
  assertFalha(resultado, 'WORKTREE_OWNERSHIP_MISMATCH', 'worktree de outra execução');
  assert.equal(resultado.error.details.currentBranch, 'trabalho/outro');
  assert.equal(resultado.error.details.expectedBranch, 'trabalho/adotado');
});

test('worktree principal do repositório nunca é adotado por uma execução', async (t) => {
  if (pular(t)) return;

  const resultado = await verifyWorktreeOwnership(
    entrada({
      worktreePath: fx.repo,
      canonicalPath: fx.repo,
      branch: fx.base,
      allowedRoot: path.dirname(fx.repo),
    }),
  );
  assertFalha(resultado, 'WORKTREE_OWNERSHIP_MISMATCH', 'worktree principal');
});

test('worktree com HEAD destacado é recusado nomeando o destacamento, não a branch', async (t) => {
  if (pular(t)) return;

  const listados = await listWorktrees(fx.repo);
  assert.equal(listados.ok, true);
  const registro = findWorktreeByPath(listados.value, fx.destacado);
  assert.notEqual(registro, null, 'pré-condição: o worktree destacado está registrado');
  assert.equal(registro.isDetached, true, 'pré-condição: o Git precisa reportar "detached"');
  assert.equal(registro.branch, null, 'pré-condição: sem branch no registro');

  const resultado = await verifyWorktreeOwnership(
    entrada({
      worktreePath: fx.destacado,
      canonicalPath: fx.destacado,
      branch: 'trabalho/destacado',
    }),
  );
  assertFalha(resultado, 'WORKTREE_OWNERSHIP_MISMATCH', 'HEAD destacado');

  /* O diagnóstico precisa apontar a CAUSA. Se a recusa viesse da comparação de
     branch — `null !== "trabalho/destacado"` — o código seria o mesmo e o erro
     mandaria o usuário caçar uma branch que não existe. */
  assert.match(resultado.error.message, /destacado/i);
  assert.equal(resultado.error.details.expectedBranch, 'trabalho/destacado');
  assert.equal(
    Object.prototype.hasOwnProperty.call(resultado.error.details, 'currentBranch'),
    false,
    'destacamento não é divergência de branch e não deve ser relatado como tal',
  );
});

test('worktree travado (locked) é recusado mesmo estando limpo e na branch certa', async (t) => {
  if (pular(t)) return;

  const listados = await listWorktrees(fx.repo);
  assert.equal(listados.ok, true);
  const registro = findWorktreeByPath(listados.value, fx.travado);
  assert.notEqual(registro, null, 'pré-condição: o worktree travado está registrado');
  assert.equal(registro.isLocked, true, 'pré-condição: o Git precisa reportar "locked"');
  assert.equal(registro.branch, 'trabalho/travado');

  /* Tudo o mais está em ordem: limpo, na branch esperada, no caminho canônico,
     dentro da raiz autorizada e sem operação pela metade. Só a trava reprova. */
  const situacao = await status(fx.travado);
  assert.equal(situacao.ok, true);
  assert.equal(situacao.value.clean, true, 'pré-condição: o worktree travado está limpo');
  const semOperacao = await detectGitOperationInProgress(fx.travado);
  assert.equal(semOperacao.ok, true);
  assert.equal(semOperacao.value, null);

  const resultado = await verifyWorktreeOwnership(
    entrada({
      worktreePath: fx.travado,
      canonicalPath: fx.travado,
      branch: 'trabalho/travado',
    }),
  );
  assertFalha(resultado, 'WORKTREE_OWNERSHIP_MISMATCH', 'worktree travado');
  assert.match(resultado.error.message, /travado|locked/i);
});

/* ------------------------------------------------------------------------ */
/* 4. Caminho divergente do canônico                                         */
/* ------------------------------------------------------------------------ */

test('caminho persistido diferente do canônico é recusado mesmo sendo worktree válido', async (t) => {
  if (pular(t)) return;

  /* `fx.outro` é worktree registrado, limpo e não travado: só a divergência
     entre o caminho persistido e o canônico o reprova. */
  const resultado = await verifyWorktreeOwnership(
    entrada({
      worktreePath: fx.outro,
      canonicalPath: fx.adotado,
      branch: 'trabalho/outro',
    }),
  );
  assertFalha(resultado, 'WORKTREE_OWNERSHIP_MISMATCH', 'caminho divergente');
  assert.equal(resultado.error.details.persisted, fx.outro);
  assert.equal(resultado.error.details.canonical, fx.adotado);
});

/* ------------------------------------------------------------------------ */
/* 5. Fora da raiz autorizada                                                */
/* ------------------------------------------------------------------------ */

test('worktree fora da raiz autorizada é recusado ainda que registrado no repositório', async (t) => {
  if (pular(t)) return;

  const listados = await listWorktrees(fx.repo);
  assert.equal(listados.ok, true);
  assert.notEqual(
    findWorktreeByPath(listados.value, fx.externo),
    null,
    'pré-condição: o worktree externo precisa estar registrado no repositório',
  );

  const resultado = await verifyWorktreeOwnership(
    entrada({
      worktreePath: fx.externo,
      canonicalPath: fx.externo,
      branch: 'trabalho/externo',
    }),
  );
  assertFalha(resultado, 'WORKTREE_OUTSIDE_ALLOWED_ROOT', 'fora da raiz autorizada');
  assert.equal(resultado.error.details.allowedRoot, fx.raizAutorizada);
});

/* ------------------------------------------------------------------------ */
/* 6. Caso central: worktree sujo da MESMA execução é adotado                 */
/* ------------------------------------------------------------------------ */

test('worktree sujo da mesma execução é adotado: a sujeira é o trabalho preservado', async (t) => {
  if (pular(t)) return;

  const situacao = await status(fx.adotado);
  assert.equal(situacao.ok, true);
  assert.equal(
    situacao.value.clean,
    false,
    'pré-condição: o worktree do caso feliz precisa estar sujo',
  );
  const alterados = situacao.value.entries.map((e) => e.path);
  assert.ok(alterados.includes('arquivo.txt'), 'arquivo rastreado modificado');
  assert.ok(alterados.includes('nao-rastreado.txt'), 'arquivo não rastreado presente');

  const resultado = await verifyWorktreeOwnership(entrada());
  assert.equal(
    resultado.ok,
    true,
    `a adoção deveria ter sido aprovada: ${resultado.ok ? '' : resultado.error.message}`,
  );
  assert.equal(resultado.value.branch, 'trabalho/adotado');
  assert.equal(resultado.value.isMain, false);
  assert.equal(resultado.value.isDetached, false);
  assert.equal(resultado.value.isLocked, false);
  assert.equal(path.resolve(resultado.value.path), path.resolve(fx.adotado));

  /* A aprovação carrega a EVIDÊNCIA que a justifica: o registro do Git para
     este worktree, e não um "sim" derivado da branch. O `headSha` devolvido é o
     commit deste worktree — diferente do worktree principal e do worktree
     vizinho, ambos ainda na base. Uma verificação baseada em
     `rev-parse --abbrev-ref HEAD` responde a branch certa e não tem de onde
     tirar este sha: sem prova positiva, este assert cai. */
  const shaAdotado = git(fx.adotado, ['rev-parse', 'HEAD']).trim();
  const shaPrincipal = git(fx.repo, ['rev-parse', 'HEAD']).trim();
  const shaVizinho = git(fx.outro, ['rev-parse', 'HEAD']).trim();
  assert.match(shaAdotado, /^[0-9a-f]{40}$/, 'pré-condição: sha completo');
  assert.notEqual(
    shaAdotado,
    shaPrincipal,
    'pré-condição: o worktree adotado tem commit próprio, distinto do principal',
  );
  assert.equal(shaVizinho, shaPrincipal, 'pré-condição: o vizinho continua na base');
  assert.equal(
    resultado.value.headSha,
    shaAdotado,
    'a evidência devolvida precisa ser a entrada de registro DESTE worktree',
  );

  /* Nada foi commitado, revertido nem apagado pela verificação. */
  assert.equal(
    fs.readFileSync(path.join(fx.adotado, 'arquivo.txt'), 'utf8'),
    'trabalho em andamento, nao commitado\n',
  );
  assert.ok(fs.existsSync(path.join(fx.adotado, 'nao-rastreado.txt')));
});

/* ------------------------------------------------------------------------ */
/* 7. Resolução do git-dir em worktree secundário                            */
/* ------------------------------------------------------------------------ */

test('a detecção resolve o git-dir por rev-parse e por isso funciona onde .git é arquivo', async (t) => {
  if (pular(t)) return;

  const dotGitDoWorktree = path.join(fx.comMerge, '.git');
  assert.equal(
    fs.statSync(dotGitDoWorktree).isFile(),
    true,
    'em worktree secundário o .git é um ARQUIVO apontando para o repositório',
  );

  /* Prova de que procurar no sistema de arquivos não encontraria o marcador:
     `<worktree>/.git/MERGE_HEAD` sequer é um caminho válido aqui. */
  assert.equal(
    fs.existsSync(path.join(fx.comMerge, '.git', 'MERGE_HEAD')),
    false,
    'o marcador NÃO está sob <worktree>/.git — quem procurar ali nunca acha nada',
  );

  /* E ainda assim a detecção acha, porque pergunta ao Git onde o marcador mora. */
  const gitPath = git(fx.comMerge, ['rev-parse', '--git-path', 'MERGE_HEAD']).trim();
  const resolvido = path.isAbsolute(gitPath) ? gitPath : path.resolve(fx.comMerge, gitPath);
  assert.equal(fs.existsSync(resolvido), true, 'o marcador real vive no git-dir do worktree');
  assert.notEqual(
    path.resolve(path.dirname(resolvido)).toLowerCase(),
    path.resolve(fx.comMerge, '.git').toLowerCase(),
    'o git-dir do worktree secundário é outro diretório, não <worktree>/.git',
  );

  const comOperacao = await detectGitOperationInProgress(fx.comMerge);
  assert.equal(comOperacao.ok, true);
  assert.equal(comOperacao.value, 'merge');

  /* No worktree secundário limpo — .git também é arquivo — não há falso positivo. */
  assert.equal(fs.statSync(path.join(fx.outro, '.git')).isFile(), true);
  const semOperacao = await detectGitOperationInProgress(fx.outro);
  assert.equal(semOperacao.ok, true);
  assert.equal(semOperacao.value, null);
});
