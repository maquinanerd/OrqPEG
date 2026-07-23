'use strict';

/**
 * Auxiliares de política efetiva para os testes.
 *
 * `createRun` exige um snapshot de política resolvido pelo chamador — é isso
 * que impede que qualquer consumidor recomponha limites por conta própria. Os
 * testes usam o MESMO resolvedor da execução real: um atalho que montasse o
 * objeto à mão testaria uma composição que o produto não usa.
 */

const {
  resolveEffectiveExecutionPolicy,
} = require('../../dist/execution/effective-policy');
const { defaultGlobalConfig } = require('../../dist/config/global-config');
const { defaultLoopGuardConfig } = require('../../dist/execution/loop-guard-config');

/** Política efetiva de um projeto, com a configuração global padrão. */
function policyFor(project, overrides = {}) {
  const resolved = resolveEffectiveExecutionPolicy({
    globalConfig: overrides.globalConfig ?? defaultGlobalConfig(),
    projectConfig: project,
    roundConfig: overrides.roundConfig ?? null,
  });
  if (!resolved.ok) {
    throw new Error(`política efetiva inválida no teste: ${resolved.error.message}`);
  }
  return resolved.value;
}

/** Só a parte de Loop Guard, para `grantManualOverride` e `describeOverrides`. */
function loopGuardPolicyFor(project, overrides = {}) {
  return policyFor(project, overrides).loopGuard;
}

/**
 * Política sintética, sem projeto cadastrado.
 *
 * Para testes de unidade que só precisam de limites e não têm repositório.
 */
function syntheticLoopGuardPolicy(patch = {}) {
  return {
    ...defaultLoopGuardConfig(),
    maxAttemptsPerPrompt: 3,
    maxReviewerRetries: 2,
    continueAfterApproval: true,
    stopOnBlocked: true,
    ...patch,
  };
}

function sourceSnapshotsFor(project, promptIds = []) {
  const promptHashes = {};
  for (const id of promptIds) promptHashes[id] = `hash-${id}`;
  return {
    promptHashes,
    promptSetHash: `set-${promptIds.join('|')}`,
    projectContextHash: '',
    projectConfigHash: policyFor(project).sources.projectConfigHash,
    roundConfigHash: null,
  };
}

/** Argumentos completos de `createRun` para um projeto e uma lista de prompts. */
function createRunInput(project, prompts, extra = {}) {
  return {
    projectId: project.id,
    dryRun: false,
    prompts,
    effectivePolicy: policyFor(project, extra),
    sourceSnapshots: sourceSnapshotsFor(
      project,
      prompts.map((prompt) => prompt.id),
    ),
    ...(extra.dryRun === undefined ? {} : { dryRun: extra.dryRun }),
  };
}

module.exports = {
  policyFor,
  loopGuardPolicyFor,
  syntheticLoopGuardPolicy,
  sourceSnapshotsFor,
  createRunInput,
};
