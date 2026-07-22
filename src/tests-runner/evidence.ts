import type { TestCommandResult, TestSuiteResult } from '../types';

/**
 * Verificação de autenticidade da evidência de testes.
 *
 * Motivo de existir: numa auditoria real desta plataforma, o auditor recusou a
 * evidência de testes porque ela era internamente implausível — duração de 1 ms
 * para 175 testes, campos de início e fim vazios e uma saída padrão que não
 * correspondia ao formato realmente produzido pelo executor. A evidência tinha
 * sido montada à mão por um script auxiliar, em vez de capturada da execução.
 *
 * O auditor estava certo, e o OrqPEG passa a se defender disso: um resultado que
 * não pôde ter vindo de uma execução real é rejeitado ANTES de virar insumo de
 * gate ou de auditoria. Evidência sintética nunca deve contar a favor de um
 * merge — é preferível declarar "não verificado" a afirmar um falso "aprovado".
 */

export interface EvidenceProblem {
  field: string;
  message: string;
}

export interface EvidenceCheck {
  authentic: boolean;
  problems: EvidenceProblem[];
}

/** Abaixo disto, um processo externo não chegou nem a iniciar. */
const MIN_PLAUSIBLE_COMMAND_MS = 5;

export function verifyTestEvidence(suite: TestSuiteResult | null): EvidenceCheck {
  const problems: EvidenceProblem[] = [];

  if (suite === null) {
    return {
      authentic: false,
      problems: [{ field: 'suite', message: 'Nenhuma suíte de testes foi registrada.' }],
    };
  }

  if (suite.commands.length === 0) {
    problems.push({
      field: 'commands',
      message:
        'A suíte não registrou nenhum comando executado: não há evidência de que algo tenha rodado.',
    });
  }

  if (!isIsoTimestamp(suite.startedAt) || !isIsoTimestamp(suite.finishedAt)) {
    problems.push({
      field: 'startedAt/finishedAt',
      message:
        'A suíte não tem horários de início e fim válidos, o que é impossível numa execução real.',
    });
  }

  suite.commands.forEach((command, index) => {
    problems.push(...verifyCommand(command, index));
  });

  const sumOfCommands = suite.commands.reduce((total, c) => total + Math.max(0, c.durationMs), 0);
  if (suite.commands.length > 0 && suite.durationMs + 1 < sumOfCommands) {
    problems.push({
      field: 'durationMs',
      message:
        `A duração total da suíte (${String(suite.durationMs)} ms) é menor que a soma dos ` +
        `comandos (${String(sumOfCommands)} ms).`,
    });
  }

  // Coerência entre o status agregado e o dos comandos.
  const anyFailed = suite.commands.some((c) => c.status !== 'PASSED');
  if (suite.passed && anyFailed) {
    problems.push({
      field: 'passed',
      message: 'A suíte se declara aprovada, mas há comando com status diferente de PASSED.',
    });
  }
  if (suite.passed !== (suite.status === 'PASSED')) {
    problems.push({
      field: 'status',
      message: `O campo "passed" (${String(suite.passed)}) não confere com o status "${suite.status}".`,
    });
  }

  return { authentic: problems.length === 0, problems };
}

function verifyCommand(command: TestCommandResult, index: number): EvidenceProblem[] {
  const problems: EvidenceProblem[] = [];
  const where = `commands[${String(index)}] (${command.command || 'sem comando'})`;

  if (command.command.trim().length === 0) {
    problems.push({ field: where, message: 'Comando vazio.' });
  }

  if (command.status === 'NOT_RUN') return problems;

  if (!isIsoTimestamp(command.startedAt) || !isIsoTimestamp(command.finishedAt)) {
    problems.push({
      field: where,
      message: 'Sem horários de início e fim válidos: não é uma captura de execução real.',
    });
  }

  if (command.durationMs < MIN_PLAUSIBLE_COMMAND_MS) {
    problems.push({
      field: where,
      message:
        `Duração de ${String(command.durationMs)} ms é curta demais para um processo externo ` +
        `(mínimo plausível: ${String(MIN_PLAUSIBLE_COMMAND_MS)} ms).`,
    });
  }

  if (command.status === 'PASSED' && command.exitCode !== 0) {
    problems.push({
      field: where,
      message: `Declarado PASSED com código de saída ${String(command.exitCode)}.`,
    });
  }

  if (command.status === 'PASSED' && command.stdout.length === 0 && command.stderr.length === 0) {
    problems.push({
      field: where,
      message: 'Aprovado sem nenhuma saída capturada: não há o que auditar.',
    });
  }

  return problems;
}

function isIsoTimestamp(value: string): boolean {
  if (typeof value !== 'string' || value.length < 20) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && parsed > 0;
}

/** Texto pronto para log, painel e pacote de auditoria. */
export function describeEvidenceCheck(check: EvidenceCheck): string {
  if (check.authentic) return 'Evidência de testes consistente com uma execução real.';
  return [
    'EVIDÊNCIA DE TESTES REJEITADA — os dados apresentados não podem ter vindo de uma execução real:',
    ...check.problems.map((p) => `  - ${p.field}: ${p.message}`),
  ].join('\n');
}
