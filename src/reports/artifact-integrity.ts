import * as path from 'node:path';
import type { RunRecord } from '../types';
import { listDirectoriesSync, readJsonSync } from '../utils/fs-atomic';
import { projectArtifactsDir } from '../utils/paths';

/**
 * Integridade dos artefatos de tentativa.
 *
 * Um defeito anterior fazia a retomada reiniciar a numeração das tentativas, e
 * `writeFileSync` truncava o `attempt-1` original sem avisar. A causa lógica já
 * foi corrigida e a proteção física existe, mas o dano feito continua em disco:
 * há execuções cujo `attempt-1` contém, na verdade, o conteúdo de uma tentativa
 * posterior.
 *
 * Este módulo não repara nada. Reparar exigiria adivinhar o que foi perdido —
 * e o artefato corrompido é, ele próprio, a evidência do bug. O que se faz aqui
 * é NOMEAR a inconsistência para que ninguém leia aquele diretório supondo que
 * ele descreve a primeira tentativa.
 */

export type ArtifactIntegrityCode =
  | 'LEGACY_ARTIFACT_CORRUPTION_DETECTED'
  | 'ATTEMPT_DIRECTORY_MISSING'
  | 'ATTEMPT_TIMELINE_OUT_OF_ORDER';

export interface ArtifactIntegrityFinding {
  code: ArtifactIntegrityCode;
  promptId: string;
  detail: string;
  evidence: Record<string, unknown>;
}

interface AttemptSummaryOnDisk {
  attempt?: number;
  startedAt?: string;
}

/**
 * Confronta o orçamento persistido com o que existe em disco.
 *
 * Dois sinais independentes, porque nenhum sozinho é conclusivo:
 *
 *  1. Contagem: `budget.attempts` maior que o número de diretórios significa
 *     que tentativas foram gravadas por cima umas das outras.
 *  2. Cronologia: `attempt-1` iniciado DEPOIS de `attempt-2` é impossível numa
 *     execução íntegra — é a assinatura exata da sobrescrita.
 */
export function inspectAttemptArtifacts(
  projectId: string,
  run: RunRecord,
): ArtifactIntegrityFinding[] {
  const findings: ArtifactIntegrityFinding[] = [];
  const runRoot = path.join(projectArtifactsDir(projectId), run.runId);

  for (const budget of run.budgets) {
    if (budget.attempts === 0) continue;

    const promptRoot = path.join(runRoot, budget.promptId);
    const dirs = listDirectoriesSync(promptRoot)
      .filter((name) => /^attempt-\d+$/.test(name))
      .map((name) => ({
        name,
        number: Number.parseInt(name.slice('attempt-'.length), 10),
      }))
      .filter((entry) => Number.isFinite(entry.number))
      .sort((a, b) => a.number - b.number);

    if (dirs.length === 0) continue;

    if (dirs.length < budget.attempts) {
      findings.push({
        code: 'LEGACY_ARTIFACT_CORRUPTION_DETECTED',
        promptId: budget.promptId,
        detail:
          `O orçamento registra ${String(budget.attempts)} tentativa(s), mas existem ` +
          `${String(dirs.length)} diretório(s) em disco. Tentativas foram sobrescritas por um defeito ` +
          'já corrigido; os artefatos preservados não correspondem à numeração original.',
        evidence: {
          recordedAttempts: budget.attempts,
          directoriesOnDisk: dirs.length,
          path: promptRoot,
        },
      });
    }

    /* Cronologia: cada tentativa deve ter começado depois da anterior. */
    let previousStart = Number.NEGATIVE_INFINITY;
    let previousName = '';
    for (const dir of dirs) {
      const summary = readJsonSync<AttemptSummaryOnDisk>(
        path.join(promptRoot, dir.name, 'attempt-summary.json'),
      );
      if (!summary.ok || typeof summary.value.startedAt !== 'string') continue;

      const startedMs = Date.parse(summary.value.startedAt);
      if (Number.isNaN(startedMs)) continue;

      if (startedMs < previousStart) {
        findings.push({
          code: 'ATTEMPT_TIMELINE_OUT_OF_ORDER',
          promptId: budget.promptId,
          detail:
            `${dir.name} declara início em ${summary.value.startedAt}, anterior ao início de ` +
            `${previousName}. Uma execução íntegra não produz esta ordem: o conteúdo de ` +
            `${previousName} foi gravado por uma tentativa posterior.`,
          evidence: {
            directory: dir.name,
            startedAt: summary.value.startedAt,
            previousDirectory: previousName,
            path: promptRoot,
          },
        });
      }
      previousStart = startedMs;
      previousName = dir.name;
    }
  }

  return findings;
}

/** Bloco Markdown do achado, para o relatório da execução. */
export function renderArtifactIntegrity(findings: readonly ArtifactIntegrityFinding[]): string {
  if (findings.length === 0) return '';

  const lines: string[] = [];
  lines.push('## Integridade dos artefatos');
  lines.push('');
  lines.push(
    'Foram detectadas inconsistências nos artefatos desta execução. Elas são ' +
      'consequência de um defeito já corrigido e **não foram reparadas de propósito**: ' +
      'o artefato inconsistente é a própria evidência do problema, e sobrescrevê-lo ' +
      'apagaria o que resta do histórico.',
  );
  lines.push('');
  lines.push('| Código | Prompt | Detalhe |');
  lines.push('| --- | --- | --- |');
  for (const finding of findings) {
    lines.push(`| \`${finding.code}\` | ${finding.promptId} | ${finding.detail} |`);
  }
  lines.push('');
  return lines.join('\n');
}
