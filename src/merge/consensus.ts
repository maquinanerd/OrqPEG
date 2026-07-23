import type {
  MergeConsensus,
  MergeReviewRecord,
  ProjectConfig,
  RunRecord,
} from '../types';

/**
 * Consenso entre as duas auditorias de merge.
 *
 * O OrqPEG só autoriza um merge quando as duas IAs, olhando exatamente o mesmo
 * commit, aprovam de forma independente. Este módulo é puro: não executa
 * processos, não lê disco e não faz rede. Ele apenas transforma os pareceres em
 * uma decisão auditável, com os motivos explicados em português.
 *
 * Assim como os gates, a política é *fail-closed*: qualquer ausência,
 * divergência ou dúvida resulta em `reached: false`.
 */

export interface ConsensusInput {
  project: ProjectConfig;
  currentHeadSha: string;
  claude: MergeReviewRecord | null;
  codex: MergeReviewRecord | null;
}

interface AuditorSide {
  label: string;
  record: MergeReviewRecord | null;
  required: boolean;
}

export function computeConsensus(input: ConsensusInput): MergeConsensus {
  const { project, currentHeadSha } = input;
  const minimumConfidence = project.merge.minimumConfidence;
  const reasons: string[] = [];

  const sides: AuditorSide[] = [
    { label: 'Claude', record: input.claude, required: project.merge.requireClaudeApproval },
    { label: 'Codex', record: input.codex, required: project.merge.requireCodexApproval },
  ];

  /* --- Pré-condições de configuração ----------------------------------- */

  if (project.merge.enabled !== true) {
    reasons.push('O merge automático está desabilitado na configuração do projeto.');
  }
  if (project.merge.mode !== 'dual_ai_consensus') {
    reasons.push(
      `O modo de merge do projeto é "${project.merge.mode}"; o consenso automático exige "dual_ai_consensus".`,
    );
  }
  if (!Number.isFinite(minimumConfidence)) {
    reasons.push('A confiança mínima configurada no projeto é inválida.');
  }
  if (currentHeadSha.trim().length === 0) {
    reasons.push('O head SHA atual é desconhecido; não há commit sobre o qual formar consenso.');
  }
  if (!sides.some((side) => side.required)) {
    reasons.push(
      'Nenhuma auditoria de IA é exigida pela configuração; sem exigência não existe consenso dual e o merge não é autorizado.',
    );
  }

  /* --- Avaliação de cada auditor --------------------------------------- */

  for (const side of sides) {
    const record = side.record;

    if (record === null) {
      if (side.required) {
        reasons.push(`A auditoria de merge do ${side.label} não está disponível.`);
      }
      continue;
    }

    if (record.invalidated) {
      reasons.push(
        `A auditoria do ${side.label} foi invalidada: ${record.invalidationReason ?? 'motivo não informado'}.`,
      );
      continue;
    }

    // Um parecer presente vale para bloquear mesmo quando o projeto não o exige:
    // se uma das IAs viu um problema, o merge não acontece.
    if (record.review.verdict !== 'APPROVED_FOR_MERGE') {
      reasons.push(
        `O auditor ${side.label} devolveu o veredito ${record.review.verdict}, e não APPROVED_FOR_MERGE.`,
      );
    }

    if (record.review.reviewedHeadSha !== currentHeadSha) {
      reasons.push(
        `O auditor ${side.label} revisou o commit ${shortSha(record.review.reviewedHeadSha)}, diferente do head atual ${shortSha(currentHeadSha)}.`,
      );
    }

    if (record.observedHeadSha !== currentHeadSha) {
      reasons.push(
        `A auditoria do ${side.label} foi disparada sobre o commit ${shortSha(record.observedHeadSha)}, diferente do head atual ${shortSha(currentHeadSha)}.`,
      );
    }

    const confidence = record.review.confidence;
    if (!Number.isFinite(confidence)) {
      reasons.push(`A confiança informada pelo auditor ${side.label} é inválida.`);
    } else if (Number.isFinite(minimumConfidence) && confidence < minimumConfidence) {
      reasons.push(
        `A confiança do ${side.label} (${formatConfidence(confidence)}) está abaixo do mínimo exigido (${formatConfidence(minimumConfidence)}).`,
      );
    }

    const blocking = countBlockingIssues(record);
    if (blocking > 0) {
      reasons.push(
        `O auditor ${side.label} registrou ${blocking} problema(s) bloqueador(es).`,
      );
    }
  }

  /* --- Divergência entre os auditores ---------------------------------- */

  const claudeRecord = input.claude;
  const codexRecord = input.codex;
  if (
    claudeRecord !== null &&
    codexRecord !== null &&
    claudeRecord.review.reviewedHeadSha !== codexRecord.review.reviewedHeadSha
  ) {
    reasons.push(
      `Os auditores revisaram commits diferentes: Claude em ${shortSha(claudeRecord.review.reviewedHeadSha)} e Codex em ${shortSha(codexRecord.review.reviewedHeadSha)}.`,
    );
  }

  const present = sides.filter((side) => side.record !== null);
  const sameHeadSha =
    present.length > 0 &&
    currentHeadSha.trim().length > 0 &&
    present.every((side) => side.record?.review.reviewedHeadSha === currentHeadSha);

  const consensus: MergeConsensus = {
    reached: reasons.length === 0,
    headSha: currentHeadSha,
    claude: describeSide(input.claude),
    codex: describeSide(input.codex),
    sameHeadSha,
    minimumConfidence,
    reasons,
  };

  return consensus;
}

function describeSide(record: MergeReviewRecord | null): MergeConsensus['claude'] {
  if (record === null) {
    return { verdict: null, confidence: null, reviewedHeadSha: null, available: false };
  }
  return {
    verdict: record.review.verdict,
    confidence: Number.isFinite(record.review.confidence) ? record.review.confidence : null,
    reviewedHeadSha: record.review.reviewedHeadSha,
    available: !record.invalidated,
  };
}

function countBlockingIssues(record: MergeReviewRecord): number {
  const blocking = record.review.blockingIssues.length;
  const misfiled = record.review.nonBlockingIssues.filter(
    (issue) => issue.severity === 'blocking',
  ).length;
  return blocking + misfiled;
}

/* ------------------------------------------------------------------------- */
/* Invalidação por mudança de head SHA                                        */
/* ------------------------------------------------------------------------- */

export interface InvalidationInput {
  run: RunRecord;
  observedHeadSha: string;
}

/**
 * Detecta se as auditorias registradas na execução deixaram de valer porque o
 * head SHA mudou. Um `true` significa que os pareceres precisam ser descartados
 * e a auditoria refeita sobre o novo commit.
 */
export function shouldInvalidate(input: InvalidationInput): {
  invalidate: boolean;
  reason: string;
} {
  const { run } = input;
  const observed = input.observedHeadSha.trim();

  if (observed.length === 0) {
    return {
      invalidate: true,
      reason: 'O head SHA observado é desconhecido; as auditorias existentes não podem ser mantidas.',
    };
  }

  const active = run.mergeReviews.filter((record) => !record.invalidated);
  if (active.length === 0) {
    return {
      invalidate: false,
      reason: 'Não há auditoria de merge válida a invalidar.',
    };
  }

  const divergent = active.filter(
    (record) =>
      record.review.reviewedHeadSha !== observed || record.observedHeadSha !== observed,
  );

  if (divergent.length > 0) {
    const detail = divergent
      .map((record) => `${record.auditor} revisou ${shortSha(record.review.reviewedHeadSha)}`)
      .join('; ');
    return {
      invalidate: true,
      reason: `O head SHA mudou para ${shortSha(observed)}: ${detail}. As auditorias foram invalidadas.`,
    };
  }

  const pr = run.pullRequest;
  if (pr !== null && pr.headSha !== observed) {
    return {
      invalidate: true,
      reason: `A pull request está em ${shortSha(pr.headSha)}, diferente do head observado ${shortSha(observed)}.`,
    };
  }

  return {
    invalidate: false,
    reason: `As auditorias continuam válidas para o commit ${shortSha(observed)}.`,
  };
}

/* ------------------------------------------------------------------------- */
/* Auxiliares                                                                 */
/* ------------------------------------------------------------------------- */

function shortSha(sha: string): string {
  const trimmed = sha.trim();
  if (trimmed.length === 0) return '(desconhecido)';
  return trimmed.length > 12 ? trimmed.slice(0, 12) : trimmed;
}

function formatConfidence(value: number): string {
  if (!Number.isFinite(value)) return '(inválida)';
  return value.toFixed(2).replace('.', ',');
}
