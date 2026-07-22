#!/usr/bin/env node
'use strict';

/**
 * OrqPEG - limpeza da saida de compilacao.
 *
 * Usado por "npm run clean". Remove SOMENTE a pasta dist/.
 *
 * Nao remove node_modules, e nunca toca em data/ nem em config/:
 *   - data/   guarda projetos, prompts, estado, locks, logs e relatorios;
 *   - config/ guarda a configuracao global da instalacao.
 *
 * Zero dependencias: apenas modulos nativos do Node.
 * Texto sem acentos de proposito, para nao depender do codepage do console.
 */

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const distDir = path.join(root, 'dist');

/** Conta arquivos e pastas dentro de um diretorio, recursivamente. */
function countEntries(dir) {
  let files = 0;
  let directories = 0;
  let entries;

  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return { files, directories };
  }

  for (const entry of entries) {
    if (entry.isDirectory()) {
      directories += 1;
      const nested = countEntries(path.join(dir, entry.name));
      files += nested.files;
      directories += nested.directories;
    } else {
      files += 1;
    }
  }

  return { files, directories };
}

function main() {
  // Rede de seguranca: so apagamos a pasta "dist" filha direta da raiz.
  if (path.basename(distDir) !== 'dist' || path.dirname(distDir) !== root) {
    process.stderr.write(`  ERRO  Caminho inesperado, nada foi removido: ${distDir}\n`);
    return 1;
  }

  if (!fs.existsSync(distDir)) {
    process.stdout.write(`  OK    Nada a fazer: a pasta dist ja nao existe.\n`);
    process.stdout.write(`        Caminho verificado: ${distDir}\n`);
    return 0;
  }

  const totals = countEntries(distDir);

  try {
    fs.rmSync(distDir, { recursive: true, force: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`  ERRO  Nao foi possivel remover a pasta dist: ${message}\n`);
    process.stderr.write(`        Feche editores, terminais e o painel que usem esses arquivos.\n`);
    return 1;
  }

  process.stdout.write(`  OK    Pasta dist removida: ${distDir}\n`);
  process.stdout.write(
    `        ${totals.files} arquivo(s) e ${totals.directories} subpasta(s) apagados.\n`,
  );
  process.stdout.write(`        data e config nao foram tocados.\n`);
  process.stdout.write(`        Rode "npm run build" para compilar de novo.\n`);
  return 0;
}

process.exitCode = main();
