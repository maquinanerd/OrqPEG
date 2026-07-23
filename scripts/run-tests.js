#!/usr/bin/env node
'use strict';

/**
 * Executor da suíte de testes do OrqPEG.
 *
 * Por que existe em vez de passar um padrão glob direto para `node --test`:
 * a expansão de padrões glob pelo próprio test runner só chegou no Node 21, e o
 * shell do Windows não expande glob. Passar um padrão no Node 20 faz o runner
 * tentar carregar o literal e falhar. Aqui a descoberta é feita com `fs`, e o
 * runner recebe uma lista explícita de arquivos — o que funciona em qualquer
 * versão suportada (Node 20+) e em qualquer shell.
 *
 * Uso:
 *   node scripts/run-tests.js            # toda a suíte
 *   node scripts/run-tests.js unit       # apenas tests/unit
 *   node scripts/run-tests.js unit e2e   # subconjuntos
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const TESTS_ROOT = path.join(REPO_ROOT, 'tests');
const SUITES = ['unit', 'integration', 'security', 'e2e'];

function collectTestFiles(dir) {
  const found = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...collectTestFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.test.js')) {
      found.push(full);
    }
  }
  return found;
}

function main() {
  const requested = process.argv.slice(2).filter((arg) => !arg.startsWith('-'));
  const suites = requested.length > 0 ? requested : SUITES;

  const unknown = suites.filter((suite) => !SUITES.includes(suite));
  if (unknown.length > 0) {
    process.stderr.write(
      `Suíte desconhecida: ${unknown.join(', ')}. Use uma de: ${SUITES.join(', ')}.\n`,
    );
    process.exit(2);
  }

  const files = [];
  for (const suite of suites) {
    files.push(...collectTestFiles(path.join(TESTS_ROOT, suite)));
  }
  files.sort();

  if (files.length === 0) {
    process.stderr.write(`Nenhum arquivo *.test.js encontrado em ${TESTS_ROOT}.\n`);
    process.exit(1);
  }

  const distMain = path.join(REPO_ROOT, 'dist', 'index.js');
  if (!fs.existsSync(distMain)) {
    process.stderr.write(
      'dist/ não encontrado. Rode "npm run build" antes dos testes: a suíte exercita o código compilado.\n',
    );
    process.exit(1);
  }

  process.stdout.write(
    `Executando ${files.length} arquivo(s) de teste em ${suites.join(', ')}.\n\n`,
  );

  const result = spawnSync(
    process.execPath,
    ['--test', '--test-reporter=spec', ...files],
    { cwd: REPO_ROOT, stdio: 'inherit' },
  );

  if (result.error) {
    process.stderr.write(`Falha ao iniciar o test runner: ${result.error.message}\n`);
    process.exit(1);
  }
  process.exit(result.status === null ? 1 : result.status);
}

main();
