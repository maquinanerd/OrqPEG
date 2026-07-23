import type {
  EffectiveExecutionPolicySnapshot,
  EffectiveLoopGuardPolicy,
  GlobalConfig,
  LoopGuardConfig,
  ProjectConfig,
  Result,
  RoundSkillDeclaration,
  RunRecord,
} from '../types';
import { fail, ok } from '../utils/errors';
import { nowIso } from '../utils/time';
import {
  defaultLoopGuardConfig,
  loopGuardMinimumOf,
  normalizeLoopGuardConfig,
  validateLoopGuardConfig,
} from './loop-guard-config';
import { validateIdentifier } from '../security/path-guard';
import { parseSkillRef } from '../skills/skill-catalog';
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

/**
 * Camada de rodada. A origem é o corpo da requisição que cria a execução.
 *
 * A rodada é propriedade da execução, não do cadastro: dois disparos do mesmo
 * projeto na mesma tarde podem ter tetos diferentes sem que nada em disco mude.
 * É por isso que ela não é lida de arquivo — se fosse, editar o arquivo entre
 * dois disparos reescreveria retroativamente a intenção do primeiro.
 */
export interface RoundPolicyOverrides {
  roundId: string;
  loopGuard?: Partial<LoopGuardConfig>;
  maxAttemptsPerPrompt?: number;
  maxReviewerRetries?: number;
  continueAfterApproval?: boolean;
  stopOnBlocked?: boolean;
  /**
   * Skills que esta rodada ativa, por agente, em `<id>@<versão>`.
   *
   * Fica aqui, e não no cadastro do projeto, pelo mesmo motivo do resto da
   * rodada: a Skill vale para ESTA execução. A ativação é sempre explícita —
   * não existe Skill ligada por padrão, porque uma regra que entra sozinha no
   * prompt é uma regra que ninguém decidiu aplicar.
   */
  skills?: RoundSkillDeclaration;
}

/** Campos aceitos na raiz de `roundConfig`. */
const ROUND_KNOWN_KEYS: ReadonlySet<string> = new Set([
  'roundId',
  'loopGuard',
  'maxAttemptsPerPrompt',
  'maxReviewerRetries',
  'continueAfterApproval',
  'stopOnBlocked',
  'skills',
]);

/** Chaves de `loopGuard` em que `null` é declaração explícita de "sem teto". */
const NULLABLE_LOOP_GUARD_KEYS: ReadonlySet<string> = new Set([
  'maxChangedFilesPerPrompt',
  'maxChangedLinesPerPrompt',
]);

/* Mínimos dos campos de rodada que ficam fora de `loopGuard`. A recusa na
   fronteira e o `Math.max` da composição leem daqui pelo mesmo motivo da
   tabela em `loop-guard-config`: se divergissem, a fronteira aceitaria um
   valor que a composição depois corrigiria sem dizer nada. */
const ROUND_ATTEMPTS_MINIMUM = 1;
const ROUND_REVIEWER_RETRIES_MINIMUM = 0;

/**
 * Lê a camada de rodada vinda do corpo da requisição.
 *
 * Recusa em vez de corrigir, ao contrário de `normalizeLoopGuardConfig`. A
 * diferença é a origem: aquela lê disco, onde ninguém está presente para ser
 * avisado, e o mal menor é assumir o padrão; esta lê uma requisição que um
 * operador acabou de mandar, e clampar em silêncio congelaria uma política
 * diferente da que ele pediu — exatamente o que este módulo existe para evitar.
 *
 * Campo desconhecido também é recusado. Ele não teria efeito nenhum sobre a
 * política e ainda assim entraria em `roundConfigHash`, produzindo duas rodadas
 * com hashes distintos e comportamento idêntico.
 */
export function parseRoundPolicyOverrides(value: unknown): Result<RoundPolicyOverrides | null> {
  /* Ausência é ausência: "esta execução não tem rodada", não "rodada vazia". */
  if (value === undefined || value === null) return ok(null);

  if (typeof value !== 'object' || Array.isArray(value)) {
    return fail(
      'VALIDATION_FAILED',
      'roundConfig: esperado um objeto declarando ao menos "roundId".',
    );
  }
  const raw = value as Record<string, unknown>;

  const unknown = Object.keys(raw).filter((key) => !ROUND_KNOWN_KEYS.has(key));
  if (unknown.length > 0) {
    return fail(
      'VALIDATION_FAILED',
      `roundConfig: campo(s) não reconhecido(s): ${unknown.join(', ')}.`,
      { unknownKeys: unknown },
    );
  }

  const rawRoundId = raw['roundId'];
  if (typeof rawRoundId !== 'string') {
    return fail(
      'VALIDATION_FAILED',
      'roundConfig.roundId: obrigatório. Uma rodada sem identidade não é rastreável no relatório.',
    );
  }
  /* Mesmo alfabeto dos demais identificadores: o `roundId` aparece em nome de
     artefato e em log, e um valor livre aqui vazaria para o disco. */
  const roundId = validateIdentifier(rawRoundId, 'roundConfig.roundId');
  if (!roundId.ok) return roundId;

  const attempts = optionalRoundInteger(raw, 'maxAttemptsPerPrompt', ROUND_ATTEMPTS_MINIMUM);
  if (!attempts.ok) return attempts;
  const retries = optionalRoundInteger(raw, 'maxReviewerRetries', ROUND_REVIEWER_RETRIES_MINIMUM);
  if (!retries.ok) return retries;
  const continueAfterApproval = optionalRoundBoolean(raw, 'continueAfterApproval');
  if (!continueAfterApproval.ok) return continueAfterApproval;
  const stopOnBlocked = optionalRoundBoolean(raw, 'stopOnBlocked');
  if (!stopOnBlocked.ok) return stopOnBlocked;
  const loopGuard = parseRoundLoopGuard(raw['loopGuard']);
  if (!loopGuard.ok) return loopGuard;
  const skills = parseRoundSkills(raw['skills']);
  if (!skills.ok) return skills;

  /* Chave só entra quando foi declarada. `stableStringify` serializa
     `undefined` como `null`, então um campo presente-e-indefinido mudaria o
     hash sem mudar a política. */
  const round: RoundPolicyOverrides = { roundId: roundId.value };
  if (loopGuard.value !== undefined) round.loopGuard = loopGuard.value;
  if (skills.value !== undefined) round.skills = skills.value;
  if (attempts.value !== undefined) round.maxAttemptsPerPrompt = attempts.value;
  if (retries.value !== undefined) round.maxReviewerRetries = retries.value;
  if (continueAfterApproval.value !== undefined) {
    round.continueAfterApproval = continueAfterApproval.value;
  }
  if (stopOnBlocked.value !== undefined) round.stopOnBlocked = stopOnBlocked.value;

  return ok(round);
}

/**
 * Valida a declaração de Skills da rodada.
 *
 * Só a FORMA é conferida aqui: `<id>@<versão>`, sem duplicata, nas duas listas
 * conhecidas. Se a Skill existe no catálogo, se está aprovada e se é compatível
 * com o agente é pergunta para `resolveDeclaredSkills`, que tem o catálogo em
 * mãos — responder isso aqui exigiria ler o disco dentro de um validador de
 * requisição, e um catálogo indisponível viraria "requisição malformada".
 *
 * Declaração vazia nos dois lados vira `undefined`: `{}` e a ausência do campo
 * descrevem a mesma rodada e precisam produzir o mesmo `roundConfigHash`.
 */
function parseRoundSkills(value: unknown): Result<RoundSkillDeclaration | undefined> {
  if (value === undefined) return ok(undefined);
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return fail(
      'VALIDATION_FAILED',
      'roundConfig.skills: deve ser um objeto com as listas "claude" e/ou "codex".',
    );
  }

  const raw = value as Record<string, unknown>;
  const unknown = Object.keys(raw).filter((key) => key !== 'claude' && key !== 'codex');
  if (unknown.length > 0) {
    return fail(
      'VALIDATION_FAILED',
      `roundConfig.skills: agente(s) não reconhecido(s): ${unknown.join(', ')}.`,
      { unknownKeys: unknown },
    );
  }

  const out: RoundSkillDeclaration = { claude: [], codex: [] };

  for (const agent of ['claude', 'codex'] as const) {
    const list = raw[agent];
    if (list === undefined) continue;
    if (!Array.isArray(list)) {
      return fail('VALIDATION_FAILED', `roundConfig.skills.${agent}: deve ser uma lista.`);
    }

    const seen = new Set<string>();
    for (const entry of list) {
      if (typeof entry !== 'string') {
        return fail(
          'VALIDATION_FAILED',
          `roundConfig.skills.${agent}: cada item deve ser uma string "<id>@<versao>".`,
          { value: entry },
        );
      }
      const ref = parseSkillRef(entry);
      if (!ref.ok) return ref;

      /* Repetir a mesma Skill duplicaria o documento no prompt e mudaria o
         hash sem mudar as regras. */
      const key = `${ref.value.id}@${ref.value.version}`;
      if (seen.has(key)) {
        return fail(
          'VALIDATION_FAILED',
          `roundConfig.skills.${agent}: "${key}" aparece mais de uma vez.`,
          { duplicate: key },
        );
      }
      seen.add(key);
      out[agent].push(ref.value.id + '@' + ref.value.version);
    }
  }

  if (out.claude.length === 0 && out.codex.length === 0) return ok(undefined);
  return ok(out);
}

function optionalRoundInteger(
  raw: Record<string, unknown>,
  field: string,
  minimum: number,
): Result<number | undefined> {
  const entry = raw[field];
  if (entry === undefined) return ok(undefined);
  if (typeof entry !== 'number' || !Number.isInteger(entry) || entry < minimum) {
    return fail(
      'VALIDATION_FAILED',
      `roundConfig.${field}: deve ser um inteiro maior ou igual a ${String(minimum)}.`,
      { value: entry },
    );
  }
  return ok(entry);
}

function optionalRoundBoolean(
  raw: Record<string, unknown>,
  field: string,
): Result<boolean | undefined> {
  const entry = raw[field];
  if (entry === undefined) return ok(undefined);
  if (typeof entry !== 'boolean') {
    return fail('VALIDATION_FAILED', `roundConfig.${field}: deve ser true ou false.`, {
      value: entry,
    });
  }
  return ok(entry);
}

/**
 * Valida o `loopGuard` da rodada contra o formato do padrão do produto.
 *
 * O objeto vazio vira `undefined`: `{roundId}` e `{roundId, loopGuard: {}}`
 * descrevem a mesma política e precisam produzir o mesmo `roundConfigHash`.
 */
function parseRoundLoopGuard(value: unknown): Result<Partial<LoopGuardConfig> | undefined> {
  if (value === undefined) return ok(undefined);
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return fail('VALIDATION_FAILED', 'roundConfig.loopGuard: deve ser um objeto.');
  }

  const defaults = defaultLoopGuardConfig() as unknown as Record<string, unknown>;
  const out: Record<string, unknown> = {};

  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (entry === undefined) continue;
    if (!(key in defaults)) {
      return fail('VALIDATION_FAILED', `roundConfig.loopGuard.${key}: campo não reconhecido.`, {
        key,
      });
    }
    if (entry === null) {
      if (!NULLABLE_LOOP_GUARD_KEYS.has(key)) {
        return fail(
          'VALIDATION_FAILED',
          `roundConfig.loopGuard.${key}: não aceita null. Omita o campo para herdar a camada de baixo.`,
          { key },
        );
      }
      out[key] = null;
      continue;
    }
    const expected = typeof defaults[key];
    if (typeof entry !== expected) {
      return fail(
        'VALIDATION_FAILED',
        `roundConfig.loopGuard.${key}: esperado ${expected}, recebido ${typeof entry}.`,
        { key },
      );
    }
    if (expected === 'number') {
      /* O mínimo vem da MESMA tabela que a normalização usa para corrigir. Um
         mínimo próprio aqui aceitaria o valor que `normalizeLoopGuardConfig`
         depois corrigiria em silêncio — o clamp que esta fronteira existe para
         impedir. */
      const minimum = loopGuardMinimumOf(key) ?? 0;
      if (!Number.isInteger(entry) || (entry as number) < minimum) {
        return fail(
          'VALIDATION_FAILED',
          `roundConfig.loopGuard.${key}: deve ser um inteiro maior ou igual a ${String(minimum)}.`,
          { key, value: entry, minimum },
        );
      }
    }
    out[key] = entry;
  }

  if (Object.keys(out).length === 0) return ok(undefined);
  return ok(out as Partial<LoopGuardConfig>);
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
      ROUND_ATTEMPTS_MINIMUM,
      roundConfig?.maxAttemptsPerPrompt ?? execution.maxAttemptsPerPrompt,
    ),
    maxReviewerRetries: Math.max(
      ROUND_REVIEWER_RETRIES_MINIMUM,
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
    /* Derivadas do mesmo `loopGuard` já resolvido em camadas — não há uma
       segunda fonte de verdade para os limites de CI e de auditoria. */
    ci: {
      maxRepairCycles: loopGuard.maxCiRepairCycles,
      pollingInitialSeconds: loopGuard.ciPollIntervalSeconds,
      pollingMaxSeconds: loopGuard.ciPollMaxIntervalSeconds,
      waitTimeoutMinutes: loopGuard.ciWaitTimeoutMinutes,
      stopOnRepeatedFailure: true,
    },
    mergeAudit: { maxCorrectionCycles: loopGuard.maxMergeCorrectionCycles },
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
    ci: snapshot.ci,
    mergeAudit: snapshot.mergeAudit,
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
