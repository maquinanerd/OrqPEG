import type {
  EffectiveExecutionPolicySnapshot,
  EffectiveLoopGuardPolicy,
  GlobalConfig,
  LoopGuardConfig,
  ProjectConfig,
  Result,
  RunRecord,
} from '../types';
import { fail, ok } from '../utils/errors';
import { nowIso } from '../utils/time';
import { normalizeLoopGuardConfig, validateLoopGuardConfig } from './loop-guard-config';
import { stableHash } from './fingerprints';

/**
 * Política efetiva — resolvida uma única vez, congelada, nunca recalculada.
 *
 * O problema que este módulo existe para eliminar: enquanto cada consumidor
 * derivava seus próprios limites de `getProject()`, uma edição no cadastro
 * mudava retroativamente uma execução já iniciada. O painel passava a mostrar
 * "3 / 5" sobre numeradores de uma execução que rodou com teto 3, o relatório
 * reescrevia a coluna "Limite", e — o caso grave — aumentar
 * `maxManualOverridesPerPrompt` concedia mais overrides a uma parada que já
 * havia consumido o seu.
 *
 * Duas regras, deliberadamente separadas:
 *
 *  1. A execução SEMPRE usa a política congelada.
 *  2. Alteração nas fontes durante a execução pode PARAR a execução, mas nunca
 *     modifica silenciosamente a política congelada.
 *
 * A regra 2 é responsabilidade do Loop Guard (`PROJECT_CONFIG_CHANGED`); a
 * regra 1 é responsabilidade deste módulo e de quem lê `run.effectivePolicy`.
 */

/**
 * Precedência, do mais forte para o mais fraco:
 *
 *     rodada > projeto > global > padrões do produto
 *
 * Uma camada só sobrepõe o campo que ela realmente declara. Ausência é
 * ausência, não zero: `undefined` cai para a camada de baixo, e é por isso que
 * as camadas superiores são `Partial`.
 */
export interface ResolvePolicyInput {
  globalConfig: GlobalConfig;
  projectConfig: ProjectConfig;
  /**
   * Campos de `loopGuard` que o `project.json` declara de fato.
   *
   * `projectConfig` chega normalizado, com todo campo preenchido pelo padrão
   * do produto. Sem esta lista, a camada do projeto pareceria declarar tudo e
   * a camada global jamais valeria. Ausência aqui é interpretada como "não sei
   * o que foi declarado" e o comportamento cai para o conservador: o projeto
   * inteiro sobrepõe o global.
   */
  declaredProjectLoopGuard?: Partial<LoopGuardConfig>;
  /** `null` significa "esta fase não tem rodada", não "rodada vazia". */
  roundConfig: RoundPolicyOverrides | null;
}

/** Camada de rodada. Ainda não há origem para ela; o formato nasce pronto. */
export interface RoundPolicyOverrides {
  roundId: string;
  loopGuard?: Partial<LoopGuardConfig>;
  maxAttemptsPerPrompt?: number;
  maxReviewerRetries?: number;
  continueAfterApproval?: boolean;
  stopOnBlocked?: boolean;
}

/**
 * Campos do cadastro que, alterados, mudam o comportamento da execução.
 *
 * A lista é explícita porque o inverso — hashear o objeto inteiro e remover
 * exceções — falha para o lado errado: um campo novo puramente visual passaria
 * a interromper execuções em curso. Aqui, um campo novo é ignorado até que
 * alguém o declare relevante.
 */
export interface ExecutionRelevantProjectConfig {
  id: string;
  repositoryPath: string;
  githubRepository: string;
  remote: string;
  baseBranch: string;
  branchStrategy: string;
  worktree: unknown;
  commands: unknown;
  execution: unknown;
  git: unknown;
  pullRequest: unknown;
  merge: unknown;
  agents: unknown;
}

export function canonicalizeExecutionRelevantProjectConfig(
  project: ProjectConfig,
): ExecutionRelevantProjectConfig {
  return {
    id: project.id,
    repositoryPath: normalizePathForHash(project.repositoryPath),
    githubRepository: project.githubRepository,
    remote: project.remote,
    baseBranch: project.baseBranch,
    branchStrategy: project.branchStrategy,
    worktree: {
      enabled: project.worktree.enabled,
      rootPath:
        project.worktree.rootPath === null
          ? null
          : normalizePathForHash(project.worktree.rootPath),
      reuseWhenSafe: project.worktree.reuseWhenSafe,
    },
    commands: project.commands,
    execution: project.execution,
    git: project.git,
    pullRequest: project.pullRequest,
    merge: project.merge,
    agents: project.agents,
  };
}

/**
 * Hash canônico do cadastro.
 *
 * `name`, `editor`, `createdAt` e `updatedAt` ficam de fora: renomear um
 * projeto ou salvá-lo sem mudar nada não pode interromper uma execução em
 * curso. Caminhos são normalizados porque `C:\Repo` e `C:/Repo/` são o mesmo
 * alvo e a diferença é só de digitação.
 */
export function executionRelevantProjectConfigHash(project: ProjectConfig): string {
  return stableHash(canonicalizeExecutionRelevantProjectConfig(project));
}

/** Hash da configuração global, restrito ao que afeta a execução. */
export function executionRelevantGlobalConfigHash(config: GlobalConfig): string {
  return stableHash({
    agents: config.agents,
    security: config.security,
    git: config.git,
    paths: config.paths,
    loopGuard: config.loopGuard ?? null,
  });
}

export function roundConfigHashOf(round: RoundPolicyOverrides | null): string | null {
  return round === null ? null : stableHash(round);
}

/**
 * Compõe as quatro camadas e devolve a política efetiva já validada.
 *
 * Falha quando a composição produz uma combinação incoerente — por exemplo, um
 * teto total de chamadas menor que o teto do Claude. Recusar aqui é melhor que
 * corrigir em silêncio: a execução ainda não começou, e o operador precisa
 * saber que o cadastro não descreve o que ele pensa que descreve.
 */
export function resolveEffectiveExecutionPolicy(
  input: ResolvePolicyInput,
): Result<EffectiveExecutionPolicySnapshot> {
  const { globalConfig, projectConfig, roundConfig } = input;

  /* Camadas 1→4. `normalizeLoopGuardConfig(undefined)` produz os padrões do
     produto; cada camada acima só sobrepõe o que ela mesma declara. */
  const projectLayer =
    input.declaredProjectLoopGuard === undefined
      ? projectConfig.execution.loopGuard
      : input.declaredProjectLoopGuard;

  const layered: Record<string, unknown> = {
    ...(normalizeLoopGuardConfig(undefined) as unknown as Record<string, unknown>),
    ...definedOnly(globalConfig.loopGuard),
    ...definedOnly(projectLayer),
    ...definedOnly(roundConfig?.loopGuard),
  };
  const loopGuardConfig = normalizeLoopGuardConfig(layered);

  const execution = projectConfig.execution;
  const loopGuard: EffectiveLoopGuardPolicy = {
    ...loopGuardConfig,
    maxAttemptsPerPrompt: Math.max(
      1,
      roundConfig?.maxAttemptsPerPrompt ?? execution.maxAttemptsPerPrompt,
    ),
    maxReviewerRetries: Math.max(
      0,
      roundConfig?.maxReviewerRetries ?? execution.maxReviewerRetries,
    ),
    continueAfterApproval:
      roundConfig?.continueAfterApproval ?? execution.continueAfterApproval,
    stopOnBlocked: roundConfig?.stopOnBlocked ?? execution.stopOnBlocked,
  };

  const issues = validateLoopGuardConfig(loopGuard);
  if (issues.length > 0) {
    return fail(
      'VALIDATION_FAILED',
      `A política efetiva desta execução é incoerente e não pode ser congelada:\n- ${issues.join('\n- ')}`,
      { issues },
    );
  }

  const snapshot: EffectiveExecutionPolicySnapshot = {
    schemaVersion: 1,
    capturedAt: nowIso(),
    sources: {
      globalConfigHash: executionRelevantGlobalConfigHash(globalConfig),
      projectConfigHash: executionRelevantProjectConfigHash(projectConfig),
      roundConfigHash: roundConfigHashOf(roundConfig),
    },
    effectiveHash: '',
    integrityHash: '',
    loopGuard,
    commands: projectConfig.commands,
    /* Modelo já resolvido contra o padrão global: se a resolução ficasse no
       consumidor, trocar o padrão global entre a parada e a retomada mudaria o
       modelo da execução sem que nada registrasse a troca. */
    agents: {
      claudeModel: projectConfig.agents.claudeModel ?? globalConfig.agents.defaultClaudeModel,
      codexModel: projectConfig.agents.codexModel ?? globalConfig.agents.defaultCodexModel,
    },
    git: projectConfig.git,
    pullRequest: projectConfig.pullRequest,
    merge: projectConfig.merge,
    repository: {
      repositoryPath: projectConfig.repositoryPath,
      githubRepository: projectConfig.githubRepository,
      remote: projectConfig.remote,
      baseBranch: projectConfig.baseBranch,
      branchStrategy: projectConfig.branchStrategy,
    },
    worktree: projectConfig.worktree,
    sourceMetadata: {
      projectId: projectConfig.id,
      roundId: roundConfig?.roundId ?? null,
      projectUpdatedAt: projectConfig.updatedAt ?? null,
    },
  };

  return ok(sealSnapshot(snapshot));
}

/**
 * Fecha o snapshot com os dois hashes.
 *
 * `effectiveHash` é a IDENTIDADE da política: cobre só a política resolvida, e
 * por isso duas execuções sob a mesma política têm o mesmo valor, mesmo que
 * `capturedAt` e as origens difiram. Serve para comparar e para exibir.
 *
 * `integrityHash` é a PROVA de que o registro não foi adulterado: cobre o
 * snapshot inteiro, inclusive `sourceMetadata`. Sem ele, a procedência de um
 * snapshot materializado — as marcas que o declaram uma aproximação e não a
 * política original — podia ser apagada no disco sem que nada percebesse, e o
 * snapshot passaria a se apresentar como congelamento histórico legítimo.
 */
export function sealSnapshot(
  snapshot: EffectiveExecutionPolicySnapshot,
): EffectiveExecutionPolicySnapshot {
  const withEffective = { ...snapshot, effectiveHash: effectiveHashOf(snapshot), integrityHash: '' };
  return { ...withEffective, integrityHash: integrityHashOf(withEffective) };
}

export function effectiveHashOf(snapshot: EffectiveExecutionPolicySnapshot): string {
  return stableHash({
    loopGuard: snapshot.loopGuard,
    commands: snapshot.commands,
    agents: snapshot.agents,
    git: snapshot.git,
    pullRequest: snapshot.pullRequest,
    merge: snapshot.merge,
    repository: snapshot.repository,
    worktree: snapshot.worktree,
  });
}

/** Hash do snapshot inteiro, exceto o próprio `integrityHash`. */
export function integrityHashOf(snapshot: EffectiveExecutionPolicySnapshot): string {
  return stableHash({ ...snapshot, integrityHash: '' });
}

/* ------------------------------------------------------------------------- */
/* Leitura pelos consumidores                                                 */
/* ------------------------------------------------------------------------- */

/**
 * Devolve a política congelada, ou falha nomeando o motivo.
 *
 * Todo consumidor de limite passa por aqui. Não existe fallback para
 * `getProject()`: um fallback silencioso é exatamente o defeito que este
 * módulo remove, e reintroduzi-lo em um único caminho reabre o buraco inteiro.
 */
export function requireEffectivePolicy(
  run: RunRecord,
): Result<EffectiveExecutionPolicySnapshot> {
  const snapshot = run.effectivePolicy;
  if (!snapshot || typeof snapshot !== 'object') {
    return fail(
      'POLICY_SNAPSHOT_MISSING',
      `A execução ${run.runId} foi criada antes do congelamento de política e não registra sob quais limites rodou. ` +
        'Retomá-la usando o cadastro atual reescreveria a história da execução. ' +
        'Inicie uma execução nova, ou materialize um snapshot legado assumindo explicitamente que ele não é a política original.',
      { runId: run.runId, projectId: run.projectId },
    );
  }
  if (snapshot.schemaVersion !== 1) {
    return fail(
      'STATE_CORRUPT',
      `A política congelada da execução ${run.runId} está em um schema não suportado (${String(snapshot.schemaVersion)}).`,
      { runId: run.runId, schemaVersion: snapshot.schemaVersion },
    );
  }
  return ok(snapshot);
}

/**
 * Verificação de integridade usada por `prepare()`.
 *
 * `prepare()` só confere. Ele não recalcula, não substitui, não atualiza e não
 * recaptura: era exatamente isso que apagava a evidência de que o cadastro
 * havia sido editado entre a parada e a retomada.
 */
export function assertEffectivePolicySnapshot(run: RunRecord): Result<EffectiveExecutionPolicySnapshot> {
  const required = requireEffectivePolicy(run);
  if (!required.ok) return required;
  const snapshot = required.value;

  if (snapshot.sourceMetadata.projectId !== run.projectId) {
    return fail(
      'STATE_CORRUPT',
      `A política congelada da execução ${run.runId} pertence ao projeto ${snapshot.sourceMetadata.projectId}, não a ${run.projectId}.`,
      { runId: run.runId, expected: run.projectId, found: snapshot.sourceMetadata.projectId },
    );
  }

  const recomputed = effectiveHashOf(snapshot);
  if (recomputed !== snapshot.effectiveHash) {
    return fail(
      'STATE_CORRUPT',
      `A política congelada da execução ${run.runId} foi adulterada no disco: o hash da política não corresponde ao conteúdo.`,
      { runId: run.runId, expected: snapshot.effectiveHash, recomputed },
    );
  }

  /* Cobre o que o `effectiveHash` deixa de fora: a procedência. Um snapshot
     materializado sem as suas marcas de materialização se passaria por original
     — e é essa fraude que o congelamento existe para impedir. */
  const recomputedIntegrity = integrityHashOf(snapshot);
  if (recomputedIntegrity !== snapshot.integrityHash) {
    return fail(
      'STATE_CORRUPT',
      `A política congelada da execução ${run.runId} foi adulterada no disco: a procedência não corresponde ao selo de integridade.`,
      { runId: run.runId, expected: snapshot.integrityHash, recomputed: recomputedIntegrity },
    );
  }

  return ok(snapshot);
}

export function hasPolicySnapshot(run: RunRecord): boolean {
  return run.effectivePolicy !== null && run.effectivePolicy !== undefined;
}

/**
 * Materializa um snapshot para uma execução legada, com confirmação humana.
 *
 * O resultado NÃO é reconstrução histórica e se declara como tal: a política
 * original daquela execução se perdeu, e o que se congela aqui é o cadastro de
 * hoje. Existe para não deixar trabalho preservado inacessível para sempre —
 * não para fingir que o registro está completo.
 */
export function materializeLegacyPolicySnapshot(input: {
  run: RunRecord;
  globalConfig: GlobalConfig;
  projectConfig: ProjectConfig;
  confirmedBy: string;
}): Result<EffectiveExecutionPolicySnapshot> {
  if (hasPolicySnapshot(input.run)) {
    return fail(
      'VALIDATION_FAILED',
      `A execução ${input.run.runId} já possui política congelada. Materializar outra a sobrescreveria.`,
      { runId: input.run.runId },
    );
  }

  const resolved = resolveEffectiveExecutionPolicy({
    globalConfig: input.globalConfig,
    projectConfig: input.projectConfig,
    roundConfig: null,
  });
  if (!resolved.ok) return resolved;

  const snapshot: EffectiveExecutionPolicySnapshot = {
    ...resolved.value,
    /* `capturedAt` continua sendo o instante da captura — que é depois do
       início da execução, e é justamente o que a flag abaixo denuncia. */
    sourceMetadata: {
      ...resolved.value.sourceMetadata,
      materializedFromLegacyRun: true,
      materializedAt: nowIso(),
      materializedBy: input.confirmedBy.trim() || 'operador local',
    },
  };
  /* Reselar: as marcas de materialização entram na `sourceMetadata` e portanto
     precisam entrar no `integrityHash`, senão poderiam ser removidas depois. */
  return ok(sealSnapshot(snapshot));
}

/* ------------------------------------------------------------------------- */

/** Remove chaves `undefined` para que uma camada só sobreponha o que declara. */
function definedOnly(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object') return {};
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (entry !== undefined) out[key] = entry;
  }
  return out;
}

/** Caminhos comparáveis: separador único, sem barra final, caixa preservada. */
function normalizePathForHash(value: string): string {
  const unified = value.replace(/\\/g, '/').replace(/\/+$/, '');
  /* Windows é insensível a caixa em caminhos; comparar com caixa faria
     `C:/Repo` e `c:/repo` divergirem sem nenhuma mudança real. */
  return process.platform === 'win32' ? unified.toLowerCase() : unified;
}
