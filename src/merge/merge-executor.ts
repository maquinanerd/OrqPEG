import type {
  Err,
  Logger,
  MergeConsensus,
  MergeGateReport,
  MergeOutcome,
  MergeStrategy,
  OrqError,
  ProjectConfig,
  PullRequestInfo,
  Result,
  RunRecord,
} from '../types';
import { fail, ok } from '../utils/errors';
import { nowIso, sleep } from '../utils/time';
import {
  ghExec,
  ghFailure,
  ghSucceeded,
  parseRepoSlug,
  redactGhOutput,
  validatePullRequestNumber,
} from '../github/gh';
import { getPullRequest } from '../github/pull-request';

/**
 * Execução do merge.
 *
 * Este é o único ponto do OrqPEG que altera o repositório remoto de forma
 * irreversível. As proteções aplicadas aqui são cumulativas:
 *
 *  1. idempotência — uma PR já mergeada nunca é mergeada de novo;
 *  2. gates — nenhum merge acontece com relatório reprovado;
 *  3. consenso — nenhum merge acontece com apenas uma aprovação;
 *  4. TOCTOU — o head SHA é relido do GitHub imediatamente antes do comando;
 *  5. `--match-head-commit` — o próprio GitHub recusa o merge se o commit mudar
 *     entre a releitura e a execução;
 *  6. confirmação — a PR é relida depois do comando para provar o merge.
 *
 * Proibições permanentes:
 *  - `--admin` NUNCA é usado: ele ignora as proteções de branch do repositório,
 *    que são justamente a última barreira independente do OrqPEG;
 *  - `--auto` NUNCA é usado: o auto-merge nativo pode estar desabilitado no
 *    repositório e delegaria a decisão final ao GitHub, fora da janela em que o
 *    OrqPEG validou os gates. O merge do OrqPEG é sempre imediato e verificado.
 */

export interface ExecuteMergeInput {
  project: ProjectConfig;
  run: RunRecord;
  pr: PullRequestInfo;
  gateReport: MergeGateReport;
  consensus: MergeConsensus;
  cwd: string;
  logger: Logger;
}

/** Tempo máximo do comando de merge. */
const MERGE_TIMEOUT_MS = 300_000;

/** Tentativas de confirmação após o merge (o GitHub pode levar alguns instantes). */
const CONFIRMATION_ATTEMPTS = 4;
const CONFIRMATION_DELAY_MS = 1_500;

const COMMIT_SHA_PATTERN = /^[0-9a-fA-F]{7,64}$/;

export async function executeMerge(input: ExecuteMergeInput): Promise<Result<MergeOutcome>> {
  const { project, run, pr, gateReport, consensus, cwd } = input;
  const logger = input.logger.child('merge');
  const strategy = project.merge.strategy;

  logger.info(
    `Preparando merge da PR #${String(pr.number)} do projeto "${project.name}" (execução ${run.runId}).`,
    {
      prNumber: pr.number,
      repository: project.githubRepository,
      strategy,
      gateHeadSha: gateReport.headSha,
    },
  );

  /* --- 1. Idempotência -------------------------------------------------- */

  if (pr.merged || pr.state === 'MERGED') {
    const outcome = idempotentOutcome(
      pr,
      strategy,
      `A pull request #${String(pr.number)} já estava mergeada; nenhuma ação foi executada.`,
    );
    logger.info(describeMergeOutcome(outcome));
    return ok(outcome);
  }

  /* --- 2. Gates --------------------------------------------------------- */

  for (const gate of gateReport.gates) {
    const line = `Gate ${String(gate.index).padStart(2, '0')} ${gate.id}: ${gate.status} — ${gate.reason}`;
    if (gate.status === 'FAILED') logger.warn(line);
    else logger.debug(line);
  }

  if (!gateReport.allPassed) {
    const failed = gateReport.failedGates;
    const message =
      failed.length > 0
        ? `Merge bloqueado: ${String(failed.length)} gate(s) reprovado(s): ${failed.join(', ')}.`
        : 'Merge bloqueado: nem todos os gates puderam ser avaliados.';
    logger.error(message);
    return fail('MERGE_GATE_FAILED', message, {
      prNumber: pr.number,
      failedGates: failed,
      reasons: gateReport.gates
        .filter((gate) => gate.status === 'FAILED')
        .map((gate) => `${gate.id}: ${gate.reason}`),
    });
  }

  /* --- 3. Consenso ------------------------------------------------------ */

  if (!consensus.reached) {
    const message = `Merge bloqueado: não há consenso entre as duas IAs. ${consensus.reasons.join(' | ')}`;
    logger.error(message);
    return fail('MERGE_GATE_FAILED', message, {
      prNumber: pr.number,
      reasons: consensus.reasons,
      claudeVerdict: consensus.claude.verdict,
      codexVerdict: consensus.codex.verdict,
    });
  }

  /* --- 4. Política do projeto (defesa em profundidade) ------------------ */

  if (project.merge.enabled !== true || project.merge.mode !== 'dual_ai_consensus') {
    const message = `Merge bloqueado: o projeto não autoriza merge automático (habilitado=${String(project.merge.enabled)}, modo="${project.merge.mode}").`;
    logger.error(message);
    return fail('MERGE_GATE_FAILED', message, {
      prNumber: pr.number,
      enabled: project.merge.enabled,
      mode: project.merge.mode,
    });
  }

  /* --- 5. SHA validado pelos gates -------------------------------------- */

  const expectedSha = gateReport.headSha.trim();
  if (!COMMIT_SHA_PATTERN.test(expectedSha)) {
    return fail(
      'MERGE_GATE_FAILED',
      `Merge bloqueado: o head SHA validado pelos gates é inválido ("${expectedSha}").`,
      { prNumber: pr.number, headSha: gateReport.headSha },
    );
  }

  if (pr.headSha !== expectedSha) {
    return fail(
      'MERGE_GATE_FAILED',
      `Merge bloqueado: o relatório de gates validou o commit ${shortSha(expectedSha)}, mas a PR em memória está em ${shortSha(pr.headSha)}.`,
      { prNumber: pr.number, gateHeadSha: expectedSha, prHeadSha: pr.headSha },
    );
  }

  const slug = parseRepoSlug(project.githubRepository);
  if (!slug.ok) return slug;

  const prNumber = validatePullRequestNumber(pr.number);
  if (!prNumber.ok) return prNumber;

  /* --- 6. Rechecagem final (guarda TOCTOU) ------------------------------ */

  logger.info('Relendo a pull request no GitHub para confirmar o head SHA antes do merge.');
  const fresh = await getPullRequest({
    cwd,
    repo: slug.value.slug,
    prNumber: prNumber.value,
  });
  if (!fresh.ok) {
    logger.error(`Não foi possível reler a pull request antes do merge: ${fresh.error.message}`);
    return fresh;
  }

  const current = fresh.value;

  if (current.merged || current.state === 'MERGED') {
    const outcome = idempotentOutcome(
      current,
      strategy,
      `A pull request #${String(current.number)} foi mergeada por outro processo antes desta tentativa.`,
    );
    logger.info(describeMergeOutcome(outcome));
    return ok(outcome);
  }

  if (current.headSha !== expectedSha) {
    const message = `O head SHA mudou entre a validação e o merge: os gates aprovaram ${shortSha(expectedSha)} e a PR está agora em ${shortSha(current.headSha)}. O merge foi cancelado e as auditorias precisam ser refeitas.`;
    logger.error(message);
    return fail('MERGE_GATE_FAILED', message, {
      prNumber: current.number,
      validatedHeadSha: expectedSha,
      currentHeadSha: current.headSha,
    });
  }

  const revalidation = revalidatePullRequest(current, project, expectedSha);
  if (revalidation !== null) {
    logger.error(revalidation.error.message);
    return revalidation;
  }

  /* --- 7. Comando de merge --------------------------------------------- */

  const args = [
    'pr',
    'merge',
    String(prNumber.value),
    '--repo',
    slug.value.slug,
    strategyFlag(strategy),
    // Proteção por SHA: o GitHub recusa o merge se o head mudar entre esta
    // chamada e a execução no servidor. Suportado pelo gh 2.95.0.
    '--match-head-commit',
    expectedSha,
  ];
  // `--delete-branch` só quando o projeto pedir explicitamente (padrão: false).
  if (project.merge.deleteBranchAfterMerge === true) {
    args.push('--delete-branch');
  }
  // Intencionalmente ausentes e proibidos: `--admin` (ignora proteções de
  // branch) e `--auto` (delega o merge ao GitHub fora da janela validada).

  logger.info(
    `Executando merge (${strategy}) da PR #${String(prNumber.value)} preso ao commit ${shortSha(expectedSha)}.`,
    { args: args.filter((arg) => arg !== expectedSha) },
  );

  const exec = await ghExec(args, cwd, { timeoutMs: MERGE_TIMEOUT_MS });
  if (!exec.ok) {
    logger.error(`Falha ao executar o comando de merge: ${exec.error.message}`);
    return exec;
  }

  const proc = exec.value;
  const output = redactGhOutput(`${proc.stdout}\n${proc.stderr}`).trim();

  if (!ghSucceeded(proc)) {
    const lower = output.toLowerCase();

    if (lower.includes('already merged') || lower.includes('já foi mesclado')) {
      const after = await getPullRequest({
        cwd,
        repo: slug.value.slug,
        prNumber: prNumber.value,
      });
      if (after.ok && (after.value.merged || after.value.state === 'MERGED')) {
        const outcome = idempotentOutcome(
          after.value,
          strategy,
          `O GitHub informou que a pull request #${String(prNumber.value)} já estava mergeada.`,
        );
        logger.info(describeMergeOutcome(outcome));
        return ok(outcome);
      }
    }

    if (
      lower.includes('head commit') ||
      lower.includes('match-head-commit') ||
      lower.includes('expected head sha') ||
      lower.includes('base branch was modified') ||
      lower.includes('head branch was modified')
    ) {
      const message = `Merge recusado pelo GitHub: o commit da branch mudou depois da validação. Saída do gh: ${output}`;
      logger.error(message);
      return fail('MERGE_GATE_FAILED', message, {
        prNumber: prNumber.value,
        validatedHeadSha: expectedSha,
        output: output.slice(0, 2000),
      });
    }

    if (lower.includes('conflict') || lower.includes('not mergeable')) {
      const message = `Merge recusado por conflito com a branch base. Saída do gh: ${output}`;
      logger.error(message);
      return fail('MERGE_CONFLICT', message, {
        prNumber: prNumber.value,
        output: output.slice(0, 2000),
      });
    }

    logger.error(`Comando de merge falhou. Saída do gh: ${output}`);
    return ghFailure(proc, args);
  }

  /* --- 8. Confirmação --------------------------------------------------- */

  const confirmed = await confirmMerged(cwd, slug.value.slug, prNumber.value);
  if (!confirmed.ok) {
    const message = `O comando de merge terminou com sucesso, mas o GitHub não confirmou o merge da PR #${String(prNumber.value)}. Saída do gh: ${output}`;
    logger.error(message);
    return fail(
      'GH_FAILED',
      message,
      { prNumber: prNumber.value, output: output.slice(0, 2000) },
      confirmed.error.message,
    );
  }

  const outcome: MergeOutcome = {
    attempted: true,
    merged: true,
    mergeSha: confirmed.value.mergeCommitSha,
    strategy,
    matchedHeadSha: expectedSha,
    performedAt: nowIso(),
    reason: `Merge (${strategy}) da PR #${String(prNumber.value)} concluído com o head preso a ${shortSha(expectedSha)} após aprovação de todos os gates e consenso das duas IAs.`,
    idempotentSkip: false,
  };

  logger.info(describeMergeOutcome(outcome), {
    prNumber: prNumber.value,
    mergeSha: outcome.mergeSha,
    matchedHeadSha: outcome.matchedHeadSha,
    deleteBranch: project.merge.deleteBranchAfterMerge,
  });

  return ok(outcome);
}

/* ------------------------------------------------------------------------- */
/* Revalidação imediata                                                       */
/* ------------------------------------------------------------------------- */

/**
 * Repete, sobre o estado recém-lido da PR, as condições que autorizariam o
 * merge. Devolve `null` quando tudo continua válido.
 */
function revalidatePullRequest(
  current: PullRequestInfo,
  project: ProjectConfig,
  expectedSha: string,
): Err<OrqError> | null {
  if (current.state !== 'OPEN') {
    return fail(
      'MERGE_GATE_FAILED',
      `Merge cancelado: a pull request está com estado ${current.state} na releitura final.`,
      { prNumber: current.number, state: current.state },
    );
  }

  if (current.isDraft) {
    return fail(
      'MERGE_GATE_FAILED',
      'Merge cancelado: a pull request voltou a ser rascunho.',
      { prNumber: current.number },
    );
  }

  if (current.baseRefName !== project.baseBranch) {
    return fail(
      'MERGE_GATE_FAILED',
      `Merge cancelado: a base da PR é "${current.baseRefName}" e o projeto exige "${project.baseBranch}".`,
      { prNumber: current.number, base: current.baseRefName },
    );
  }

  if (current.mergeable === 'CONFLICTING') {
    return fail(
      'MERGE_CONFLICT',
      'Merge cancelado: a pull request passou a conflitar com a branch base.',
      { prNumber: current.number, mergeable: current.mergeable },
    );
  }

  if (current.mergeable === 'UNKNOWN') {
    return fail(
      'MERGE_GATE_FAILED',
      'Merge cancelado: o GitHub não sabe informar se a PR é mesclável (mergeable = UNKNOWN).',
      { prNumber: current.number, mergeable: current.mergeable },
    );
  }

  if (current.reviewDecision === 'CHANGES_REQUESTED') {
    return fail(
      'MERGE_GATE_FAILED',
      'Merge cancelado: uma revisão humana passou a solicitar mudanças.',
      { prNumber: current.number, reviewDecision: current.reviewDecision },
    );
  }

  if (current.unresolvedThreadCount !== 0) {
    return fail(
      'MERGE_GATE_FAILED',
      current.unresolvedThreadCount < 0
        ? 'Merge cancelado: não foi possível contar as conversas de revisão não resolvidas.'
        : `Merge cancelado: existem ${String(current.unresolvedThreadCount)} conversa(s) de revisão não resolvida(s).`,
      { prNumber: current.number, unresolvedThreadCount: current.unresolvedThreadCount },
    );
  }

  if (current.headSha !== expectedSha) {
    return fail(
      'MERGE_GATE_FAILED',
      `Merge cancelado: o head SHA mudou para ${shortSha(current.headSha)}.`,
      { prNumber: current.number, currentHeadSha: current.headSha, expectedSha },
    );
  }

  return null;
}

/* ------------------------------------------------------------------------- */
/* Confirmação pós-merge                                                      */
/* ------------------------------------------------------------------------- */

async function confirmMerged(
  cwd: string,
  repo: string,
  prNumber: number,
): Promise<Result<PullRequestInfo>> {
  let lastMessage = 'A pull request não aparece como mergeada.';

  for (let attempt = 1; attempt <= CONFIRMATION_ATTEMPTS; attempt += 1) {
    const read = await getPullRequest({ cwd, repo, prNumber });
    if (read.ok) {
      const info = read.value;
      if (info.merged || info.state === 'MERGED') return ok(info);
      lastMessage = `A pull request continua com estado ${info.state} após o comando de merge.`;
    } else {
      lastMessage = read.error.message;
    }

    if (attempt < CONFIRMATION_ATTEMPTS) {
      await sleep(CONFIRMATION_DELAY_MS);
    }
  }

  return fail('GH_FAILED', lastMessage, { prNumber, attempts: CONFIRMATION_ATTEMPTS });
}

/* ------------------------------------------------------------------------- */
/* Auxiliares                                                                 */
/* ------------------------------------------------------------------------- */

function idempotentOutcome(
  pr: PullRequestInfo,
  strategy: MergeStrategy,
  reason: string,
): MergeOutcome {
  return {
    attempted: false,
    merged: true,
    mergeSha: pr.mergeCommitSha,
    strategy,
    matchedHeadSha: pr.headSha.length > 0 ? pr.headSha : null,
    performedAt: null,
    reason,
    idempotentSkip: true,
  };
}

function strategyFlag(strategy: MergeStrategy): string {
  switch (strategy) {
    case 'squash':
      return '--squash';
    case 'merge':
      return '--merge';
    case 'rebase':
      return '--rebase';
    default:
      // Estratégia desconhecida cai no padrão mais conservador do produto.
      return '--squash';
  }
}

function shortSha(sha: string): string {
  const trimmed = sha.trim();
  if (trimmed.length === 0) return '(desconhecido)';
  return trimmed.length > 12 ? trimmed.slice(0, 12) : trimmed;
}

/** Texto legível do resultado do merge, em português. */
export function describeMergeOutcome(outcome: MergeOutcome): string {
  if (outcome.idempotentSkip) {
    const sha = outcome.mergeSha === null ? 'desconhecido' : shortSha(outcome.mergeSha);
    return `Merge não executado (idempotência): a PR já estava mergeada. Commit de merge: ${sha}. Motivo: ${outcome.reason}`;
  }

  if (!outcome.attempted) {
    return `Merge não tentado. Motivo: ${outcome.reason}`;
  }

  if (!outcome.merged) {
    return `Merge tentado e NÃO concluído (estratégia ${outcome.strategy}). Motivo: ${outcome.reason}`;
  }

  const sha = outcome.mergeSha === null ? 'não informado pelo GitHub' : shortSha(outcome.mergeSha);
  const head =
    outcome.matchedHeadSha === null ? 'não informado' : shortSha(outcome.matchedHeadSha);
  const at = outcome.performedAt ?? 'horário não registrado';
  return `Merge concluído com estratégia ${outcome.strategy} em ${at}. Head validado: ${head}. Commit de merge: ${sha}. ${outcome.reason}`;
}
