'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRunInput } = require('../helpers/policy');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'orqpeg-rep-'));
process.env.ORQPEG_HOME = HOME;
process.env.ORQPEG_NO_FILE_LOG = '1';

const { buildRunReport, writeRunReport, escapeHtml } = require('../../dist/reports/report-generator');
const { buildDryRunPlan, renderDryRunPlan } = require('../../dist/execution/dry-run');
const { renderPullRequestBody } = require('../../dist/execution/pr-body');
const { createProject } = require('../../dist/projects/project-store');
const { normalizeProjectConfig } = require('../../dist/projects/project-validator');
const { createRun, updatePromptProgress } = require('../../dist/state/run-state');
const { defaultGlobalConfig } = require('../../dist/config/global-config');
const { ensureDataLayout, projectPromptsDir } = require('../../dist/utils/paths');

ensureDataLayout();

let counter = 0;
function makeProject() {
  counter += 1;
  const id = `rep${counter}`;
  const repoPath = path.join(HOME, 'repos', id);
  fs.mkdirSync(repoPath, { recursive: true });
  const created = createProject(
    normalizeProjectConfig({
      id,
      name: `Relatório ${counter}`,
      repositoryPath: repoPath,
      githubRepository: 'maquinanerd/demo',
    }),
  );
  assert.equal(created.ok, true);
  return created.value;
}

function makeRun(project) {
  let run = createRun(
    createRunInput(project, [
      { id: '010-a', name: 'Fundação', fileName: '010-a.md', absolutePath: 'x', order: 10, sizeBytes: 1 },
    ]),
  );
  run = updatePromptProgress(run, '010-a', { status: 'APPROVED', commitSha: 'abc1234def56' });
  return {
    ...run,
    branchName: 'orqpeg/demo/run-1',
    baseCommitSha: '0000111122223333',
    commits: [
      { promptId: '010-a', sha: 'abc1234def56', message: 'orqpeg: demo', at: '2026-07-21T12:00:00.000Z' },
    ],
    finalTests: {
      status: 'PASSED',
      passed: true,
      startedAt: '2026-07-21T12:00:00.000Z',
      finishedAt: '2026-07-21T12:01:00.000Z',
      durationMs: 60000,
      commands: [
        {
          command: 'npm test',
          cwd: '.',
          status: 'PASSED',
          exitCode: 0,
          startedAt: '2026-07-21T12:00:00.000Z',
          finishedAt: '2026-07-21T12:01:00.000Z',
          durationMs: 60000,
          stdout: 'ok',
          stderr: '',
        },
      ],
      failedCommands: [],
    },
  };
}

/* ------------------------------------------------------------------------ */
/* Escapes                                                                   */
/* ------------------------------------------------------------------------ */

test('escapeHtml neutraliza injeção de HTML', () => {
  assert.equal(
    escapeHtml('<script>alert("x")</script>'),
    '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;',
  );
  assert.equal(escapeHtml("a & b ' c"), 'a &amp; b &#39; c');
});

/* ------------------------------------------------------------------------ */
/* Relatórios                                                                */
/* ------------------------------------------------------------------------ */

test('buildRunReport gera os três formatos', () => {
  const project = makeProject();
  const bundle = buildRunReport({ project, run: makeRun(project) });

  assert.equal(typeof bundle.json, 'string');
  assert.equal(typeof bundle.markdown, 'string');
  assert.equal(typeof bundle.html, 'string');

  const parsed = JSON.parse(bundle.json);
  assert.equal(parsed.product, 'OrqPEG');
  assert.equal(parsed.project.githubRepository, 'maquinanerd/demo');
  assert.equal(parsed.run.prompts[0].status, 'APPROVED');
});

test('o relatório Markdown traz prompts, commits e testes', () => {
  const project = makeProject();
  const bundle = buildRunReport({ project, run: makeRun(project) });

  assert.match(bundle.markdown, /Relatório de execução/);
  assert.match(bundle.markdown, /010-a/);
  assert.match(bundle.markdown, /APROVADO/);
  assert.match(bundle.markdown, /npm test/);
  assert.match(bundle.markdown, /abc1234def56/);
});

test('o relatório HTML é autocontido, sem recurso externo', () => {
  const project = makeProject();
  const bundle = buildRunReport({ project, run: makeRun(project) });

  assert.match(bundle.html, /^<!doctype html>/i);
  assert.match(bundle.html, /<style>/);
  assert.equal(/<script/i.test(bundle.html), false, 'o relatório não deve conter script');
  assert.equal(
    /https?:\/\/(?!github\.com)/.test(bundle.html.replace(/https?:\/\/www\.w3\.org/g, '')),
    false,
    'não pode referenciar CDN ou recurso externo',
  );
  assert.match(bundle.html, /prefers-color-scheme/);
});

test('conteúdo malicioso vindo da execução é escapado no HTML', () => {
  const project = makeProject();
  const run = makeRun(project);
  run.prompts[0].promptId = '<img src=x onerror=alert(1)>';

  const bundle = buildRunReport({ project, run });
  assert.equal(
    bundle.html.includes('<img src=x onerror=alert(1)>'),
    false,
    'HTML bruto não pode ser injetado no relatório',
  );
  assert.match(bundle.html, /&lt;img/);
});

test('writeRunReport grava os três arquivos em disco', () => {
  const project = makeProject();
  const run = makeRun(project);
  const written = writeRunReport({ project, run });

  assert.equal(written.ok, true);
  for (const key of ['jsonPath', 'markdownPath', 'htmlPath']) {
    assert.equal(fs.existsSync(written.value[key]), true, `faltou ${key}`);
    assert.ok(fs.statSync(written.value[key]).size > 0);
  }
});

/* ------------------------------------------------------------------------ */
/* Corpo da pull request                                                     */
/* ------------------------------------------------------------------------ */

test('o corpo da PR descreve prompts, testes, commits e gates', () => {
  const project = makeProject();
  const body = renderPullRequestBody({ project, run: makeRun(project) });

  assert.match(body, /010-a/);
  assert.match(body, /npm test/);
  assert.match(body, /abc1234def56/);
  assert.ok(body.length > 200);
});

/* ------------------------------------------------------------------------ */
/* Dry-run                                                                   */
/* ------------------------------------------------------------------------ */

test('o plano de dry-run lista os 20 gates e a política de merge', () => {
  const project = makeProject();
  fs.mkdirSync(projectPromptsDir(project.id), { recursive: true });
  fs.writeFileSync(
    path.join(projectPromptsDir(project.id), '010-a.md'),
    '# Objetivo\n\nfazer algo\n',
    'utf8',
  );

  const plan = buildDryRunPlan(project.id, defaultGlobalConfig());
  assert.equal(plan.ok, true, plan.ok ? '' : JSON.stringify(plan.error));

  assert.equal(plan.value.gates.length, 20);
  assert.equal(plan.value.promptCount, 1);
  assert.match(plan.value.branchName, /^orqpeg\//);
  assert.ok(plan.value.mergePolicy.some((line) => line.includes('dual_ai_consensus')));
  assert.ok(plan.value.gitPolicy.some((line) => line.includes('force push: PROIBIDO')));
});

test('o dry-run avisa quando não há prompt algum', () => {
  const project = makeProject();
  const plan = buildDryRunPlan(project.id, defaultGlobalConfig());
  assert.equal(plan.ok, true);
  assert.equal(plan.value.promptCount, 0);
  assert.ok(plan.value.warnings.some((w) => w.includes('Nenhum prompt')));
});

test('renderDryRunPlan produz texto legível com os 20 gates', () => {
  const project = makeProject();
  const plan = buildDryRunPlan(project.id, defaultGlobalConfig());
  const text = renderDryRunPlan(plan.value);

  assert.match(text, /DRY-RUN/);
  assert.match(text, /Nada será alterado/);
  assert.match(text, /GATES OBRIGATÓRIOS DO MERGE/);
  assert.match(text, /20\. O projeto permite dual_ai_consensus/);
});
