'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

/*
 * Corrida REAL entre processos sobre o arquivo de estado.
 *
 * A auditoria da PR #2 apontou, corretamente, que comparar revisões não é
 * compare-and-swap. O cenário que a versão anterior não cobria:
 *
 *     Disco: revision=10, pauseRequested=false
 *     A lê 10                      B lê 10
 *     A monta 11, pause=false      B monta 11, pause=true
 *     B grava (pause=true)
 *     A grava depois (pause=false)  <-- a pausa desaparece
 *
 * Nenhum dos dois está "atrasado" no momento da leitura, então não há
 * obsolescência a detectar. Só exclusão mútua resolve.
 *
 * Estes testes usam PROCESSOS NODE SEPARADOS e uma BARREIRA de arquivo que
 * força todos a lerem antes e escreverem depois — a corrida é provocada, não
 * esperada por acaso. Chamadas sequenciais no mesmo processo não serviriam:
 * código síncrono não se intercala consigo mesmo.
 */

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'orqpeg-race-'));
process.env.ORQPEG_HOME = HOME;
process.env.ORQPEG_NO_FILE_LOG = '1';

const { createRun, loadRun, saveRun } = require('../../dist/state/run-state');
const { createProject } = require('../../dist/projects/project-store');
const { normalizeProjectConfig } = require('../../dist/projects/project-validator');
const { ensureDataLayout } = require('../../dist/utils/paths');
const { createRunInput } = require('../helpers/policy');

ensureDataLayout();

const RACE_WRITER = path.resolve(__dirname, '..', 'helpers', 'race-writer.js');

/** Número de repetições de cada cenário. Uma corrida única não prova nada. */
const RODADAS = 8;

let counter = 0;

function projeto() {
  counter += 1;
  const id = `race${counter}`;
  const repoPath = path.join(HOME, 'repos', id);
  fs.mkdirSync(repoPath, { recursive: true });
  const criado = createProject(
    normalizeProjectConfig({
      id,
      name: `Corrida ${counter}`,
      repositoryPath: repoPath,
      githubRepository: 'maquinanerd/demo',
    }),
  );
  assert.equal(criado.ok, true, criado.ok ? '' : JSON.stringify(criado.error));
  return criado.value;
}

function prompts() {
  return [
    { id: '010-a', name: 'A', fileName: '010-a.md', absolutePath: 'x', order: 10, sizeBytes: 1 },
  ];
}

function novaExecucao(project) {
  const saved = saveRun(createRun(createRunInput(project, prompts())));
  assert.equal(saved.ok, true, saved.ok ? '' : JSON.stringify(saved.error));
  return saved.value;
}

/**
 * Dispara N escritores concorrentes, todos sincronizados pela mesma barreira.
 * Devolve a saída de cada um.
 */
function corrida(project, runId, acoes, rodada) {
  const barrier = path.join(HOME, 'barriers', `${project.id}-${String(rodada)}`);
  fs.rmSync(barrier, { recursive: true, force: true });

  const processos = acoes.map(
    (acao) =>
      new Promise((resolve, reject) => {
        const child = spawn(
          process.execPath,
          [RACE_WRITER, HOME, project.id, runId, barrier, String(acoes.length), acao],
          { windowsHide: true },
        );
        let saida = '';
        child.stdout.on('data', (chunk) => {
          saida += chunk.toString('utf8');
        });
        child.stderr.on('data', () => undefined);
        child.on('error', reject);
        child.on('close', (code) => resolve({ acao, code, saida: saida.trim() }));
      }),
  );

  return Promise.all(processos);
}

/* ------------------------------------------------------------------------ */

test('orquestrador vs pausa: a pausa NUNCA desaparece', async () => {
  const project = projeto();

  for (let rodada = 1; rodada <= RODADAS; rodada += 1) {
    const run = novaExecucao(project);
    const resultados = await corrida(project, run.runId, ['progress:etapa', 'pause'], rodada);

    for (const resultado of resultados) {
      assert.equal(
        resultado.code,
        0,
        `escritor "${resultado.acao}" falhou na rodada ${rodada}: ${resultado.saida}`,
      );
    }

    const final = loadRun(project.id, run.runId);
    assert.equal(final.ok, true);
    assert.equal(
      final.value.pauseRequested,
      true,
      `rodada ${rodada}: a pausa foi apagada por uma escrita concorrente`,
    );
    // O progresso do outro escritor também sobreviveu.
    assert.equal(final.value.currentPromptId, 'etapa', `rodada ${rodada}: o progresso sumiu`);
    // Duas escritas produziram duas revisões, não uma.
    assert.equal(
      final.value.revision >= run.revision + 2,
      true,
      `rodada ${rodada}: revisão ${String(final.value.revision)} indica escrita perdida ` +
        `(base ${String(run.revision)})`,
    );
  }
});

test('orquestrador vs cancelamento: o cancelamento NUNCA desaparece', async () => {
  const project = projeto();

  for (let rodada = 1; rodada <= RODADAS; rodada += 1) {
    const run = novaExecucao(project);
    const resultados = await corrida(project, run.runId, ['progress:etapa', 'cancel'], rodada);
    for (const resultado of resultados) {
      assert.equal(resultado.code, 0, `escritor "${resultado.acao}": ${resultado.saida}`);
    }

    const final = loadRun(project.id, run.runId);
    assert.equal(
      final.value.cancelRequested,
      true,
      `rodada ${rodada}: o cancelamento foi apagado por uma escrita concorrente`,
    );
    assert.equal(final.value.currentPromptId, 'etapa');
    assert.equal(final.value.revision >= run.revision + 2, true);
  }
});

test('pausa vs cancelamento: as duas intenções sobrevivem juntas', async () => {
  const project = projeto();

  for (let rodada = 1; rodada <= RODADAS; rodada += 1) {
    const run = novaExecucao(project);
    const resultados = await corrida(project, run.runId, ['pause', 'cancel'], rodada);
    for (const resultado of resultados) {
      assert.equal(resultado.code, 0, `escritor "${resultado.acao}": ${resultado.saida}`);
    }

    const final = loadRun(project.id, run.runId);
    assert.equal(final.value.pauseRequested, true, `rodada ${rodada}: a pausa sumiu`);
    assert.equal(final.value.cancelRequested, true, `rodada ${rodada}: o cancelamento sumiu`);
    /* Precedência: quem lê o estado precisa concluir CANCELAMENTO, que é o
       pedido mais forte. As duas marcas coexistirem é o que permite isso. */
  }
});

test('progresso vs progresso: nenhuma escrita é perdida silenciosamente', async () => {
  const project = projeto();

  for (let rodada = 1; rodada <= RODADAS; rodada += 1) {
    const run = novaExecucao(project);
    const resultados = await corrida(
      project,
      run.runId,
      ['progress:alfa', 'progress:beta', 'progress:gama'],
      rodada,
    );
    for (const resultado of resultados) {
      assert.equal(resultado.code, 0, `escritor "${resultado.acao}": ${resultado.saida}`);
    }

    const final = loadRun(project.id, run.runId);
    /*
     * Três escritas => três revisões. Se duas tivessem partido do mesmo ponto e
     * uma sobrescrito a outra, a revisão final ficaria abaixo disto — que é
     * precisamente o sintoma de escrita perdida.
     */
    assert.equal(
      final.value.revision,
      run.revision + 3,
      `rodada ${rodada}: revisão final ${String(final.value.revision)} — esperada ` +
        `${String(run.revision + 3)}. Uma escrita foi perdida.`,
    );
    assert.equal(['alfa', 'beta', 'gama'].includes(final.value.currentPromptId), true);
  }
});

test('doze escritores simultâneos produzem doze revisões distintas', async () => {
  const project = projeto();
  const run = novaExecucao(project);

  const acoes = [];
  for (let i = 0; i < 10; i += 1) acoes.push(`progress:p${String(i)}`);
  acoes.push('pause');
  acoes.push('cancel');

  const resultados = await corrida(project, run.runId, acoes, 99);
  for (const resultado of resultados) {
    assert.equal(resultado.code, 0, `escritor "${resultado.acao}": ${resultado.saida}`);
  }

  const final = loadRun(project.id, run.runId);
  assert.equal(
    final.value.revision,
    run.revision + acoes.length,
    `revisão final ${String(final.value.revision)} — esperada ${String(run.revision + acoes.length)}`,
  );
  assert.equal(final.value.pauseRequested, true);
  assert.equal(final.value.cancelRequested, true);

  /* Cada escritor relatou uma revisão própria: nenhum par colidiu. */
  const revisoes = resultados
    .map((r) => {
      const match = /"revision":(\d+)/.exec(r.saida);
      return match ? Number(match[1]) : null;
    })
    .filter((value) => value !== null);
  assert.equal(revisoes.length, acoes.length);
  assert.equal(
    new Set(revisoes).size,
    revisoes.length,
    `revisões duplicadas entre escritores: ${revisoes.join(', ')}`,
  );
});

test('o lock de estado é liberado mesmo quando a operação falha', () => {
  const project = projeto();
  const run = novaExecucao(project);
  const lockPath = path.join(
    HOME,
    'data',
    'projects',
    project.id,
    'state',
    `${run.runId}.json.lock`,
  );

  const { mutateRun } = require('../../dist/state/run-state');
  const falhou = mutateRun(project.id, run.runId, () => ({
    ok: false,
    error: { code: 'INTERNAL', message: 'falha injetada dentro do lock' },
  }));
  assert.equal(falhou.ok, false);
  assert.equal(fs.existsSync(lockPath), false, 'o lock ficou para trás após a falha');

  /* E o estado continua gravável. */
  const depois = saveRun({ ...loadRun(project.id, run.runId).value, currentPromptId: 'ok' });
  assert.equal(depois.ok, true, depois.ok ? '' : JSON.stringify(depois.error));
});
