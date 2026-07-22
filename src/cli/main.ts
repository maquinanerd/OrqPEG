#!/usr/bin/env node
import { runCli } from './commands';

/**
 * Ponto de entrada da CLI do OrqPEG.
 *
 * Todos os wrappers `.cmd` chamam este arquivo. Nenhuma lógica de negócio vive
 * aqui: apenas o encaminhamento e o tratamento do código de saída.
 */

void runCli(process.argv.slice(2)).then(
  (exitCode) => {
    process.exitCode = exitCode;
  },
  (error: unknown) => {
    process.stderr.write(
      `\n  x Falha inesperada: ${error instanceof Error ? error.message : String(error)}\n\n`,
    );
    process.exitCode = 1;
  },
);
