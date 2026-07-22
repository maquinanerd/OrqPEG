import type { LoopGuardConfig } from '../types';

/**
 * Configuração da proteção contra looping.
 *
 * Os padrões são deliberadamente conservadores: o custo de parar cedo demais é
 * uma decisão humana a mais; o custo de parar tarde demais é a assinatura do
 * usuário consumida em repetição improdutiva. Diante da dúvida, para antes.
 */

export function defaultLoopGuardConfig(): LoopGuardConfig {
  return {
    enabled: true,

    /* Três chamadas do executor cobrem implementação + duas correções. */
    maxClaudeCallsPerPrompt: 3,
    /* O revisor tem folga porque também absorve retentativa de formato. */
    maxCodexCallsPerPrompt: 5,
    maxTotalAgentCallsPerPrompt: 8,

    maxPromptDurationMinutes: 90,
    maxRunDurationMinutes: 480,

    /* Uma correção que não mudou o código já é sinal suficiente. */
    maxConsecutiveNoProgress: 1,
    maxRepeatedReviewFingerprints: 2,
    maxRepeatedTestFailureFingerprints: 2,

    detectDiffOscillation: true,
    detectReviewOscillation: true,
    stopOnPromptMutation: true,
    stopOnContextMutation: true,
    stopOnScopeViolation: true,

    maxChangedFilesPerPrompt: 80,
    maxChangedLinesPerPrompt: 15_000,

    maxManualOverridesPerPrompt: 1,
    maxCiRepairCycles: 2,
    maxMergeCorrectionCycles: 2,

    ciPollIntervalSeconds: 20,
    ciPollMaxIntervalSeconds: 60,
    ciWaitTimeoutMinutes: 60,

    maxReviewFormatRetries: 2,
  };
}

/**
 * Normaliza a configuração vinda do disco.
 *
 * Valores ausentes assumem o padrão. Valores fora de faixa são corrigidos para
 * o mínimo viável em vez de aceitos: um `maxClaudeCallsPerPrompt: 0` gravado à
 * mão não pode desativar silenciosamente a proteção nem travar a execução.
 */
export function normalizeLoopGuardConfig(value: unknown): LoopGuardConfig {
  const defaults = defaultLoopGuardConfig();
  if (!value || typeof value !== 'object') return defaults;
  const raw = value as Record<string, unknown>;

  return {
    enabled: bool(raw['enabled'], defaults.enabled),

    maxClaudeCallsPerPrompt: int(raw['maxClaudeCallsPerPrompt'], defaults.maxClaudeCallsPerPrompt, 1),
    maxCodexCallsPerPrompt: int(raw['maxCodexCallsPerPrompt'], defaults.maxCodexCallsPerPrompt, 1),
    maxTotalAgentCallsPerPrompt: int(
      raw['maxTotalAgentCallsPerPrompt'],
      defaults.maxTotalAgentCallsPerPrompt,
      2,
    ),

    maxPromptDurationMinutes: int(
      raw['maxPromptDurationMinutes'],
      defaults.maxPromptDurationMinutes,
      1,
    ),
    maxRunDurationMinutes: int(raw['maxRunDurationMinutes'], defaults.maxRunDurationMinutes, 1),

    maxConsecutiveNoProgress: int(
      raw['maxConsecutiveNoProgress'],
      defaults.maxConsecutiveNoProgress,
      1,
    ),
    maxRepeatedReviewFingerprints: int(
      raw['maxRepeatedReviewFingerprints'],
      defaults.maxRepeatedReviewFingerprints,
      2,
    ),
    maxRepeatedTestFailureFingerprints: int(
      raw['maxRepeatedTestFailureFingerprints'],
      defaults.maxRepeatedTestFailureFingerprints,
      2,
    ),

    detectDiffOscillation: bool(raw['detectDiffOscillation'], defaults.detectDiffOscillation),
    detectReviewOscillation: bool(raw['detectReviewOscillation'], defaults.detectReviewOscillation),
    stopOnPromptMutation: bool(raw['stopOnPromptMutation'], defaults.stopOnPromptMutation),
    stopOnContextMutation: bool(raw['stopOnContextMutation'], defaults.stopOnContextMutation),
    stopOnScopeViolation: bool(raw['stopOnScopeViolation'], defaults.stopOnScopeViolation),

    /* `null` é explícito e legítimo: desativa o teto para projetos que
       realmente precisam de uma etapa grande. Ausência usa o padrão. */
    maxChangedFilesPerPrompt: nullableInt(
      raw['maxChangedFilesPerPrompt'],
      defaults.maxChangedFilesPerPrompt,
      1,
    ),
    maxChangedLinesPerPrompt: nullableInt(
      raw['maxChangedLinesPerPrompt'],
      defaults.maxChangedLinesPerPrompt,
      1,
    ),

    maxManualOverridesPerPrompt: int(
      raw['maxManualOverridesPerPrompt'],
      defaults.maxManualOverridesPerPrompt,
      0,
    ),
    maxCiRepairCycles: int(raw['maxCiRepairCycles'], defaults.maxCiRepairCycles, 0),
    maxMergeCorrectionCycles: int(
      raw['maxMergeCorrectionCycles'],
      defaults.maxMergeCorrectionCycles,
      0,
    ),

    ciPollIntervalSeconds: int(raw['ciPollIntervalSeconds'], defaults.ciPollIntervalSeconds, 5),
    ciPollMaxIntervalSeconds: int(
      raw['ciPollMaxIntervalSeconds'],
      defaults.ciPollMaxIntervalSeconds,
      5,
    ),
    ciWaitTimeoutMinutes: int(raw['ciWaitTimeoutMinutes'], defaults.ciWaitTimeoutMinutes, 1),

    maxReviewFormatRetries: int(raw['maxReviewFormatRetries'], defaults.maxReviewFormatRetries, 0),
  };
}

/** Problemas que impedem o uso da configuração, em português, campo a campo. */
export function validateLoopGuardConfig(config: LoopGuardConfig): string[] {
  const issues: string[] = [];

  if (config.maxTotalAgentCallsPerPrompt < config.maxClaudeCallsPerPrompt) {
    issues.push(
      'execution.loopGuard.maxTotalAgentCallsPerPrompt: não pode ser menor que maxClaudeCallsPerPrompt.',
    );
  }
  if (config.maxTotalAgentCallsPerPrompt < config.maxCodexCallsPerPrompt) {
    issues.push(
      'execution.loopGuard.maxTotalAgentCallsPerPrompt: não pode ser menor que maxCodexCallsPerPrompt.',
    );
  }
  if (config.maxRunDurationMinutes < config.maxPromptDurationMinutes) {
    issues.push(
      'execution.loopGuard.maxRunDurationMinutes: não pode ser menor que maxPromptDurationMinutes.',
    );
  }
  if (config.ciPollMaxIntervalSeconds < config.ciPollIntervalSeconds) {
    issues.push(
      'execution.loopGuard.ciPollMaxIntervalSeconds: não pode ser menor que ciPollIntervalSeconds.',
    );
  }
  return issues;
}

/** Resumo legível da política, usado pelo dry-run e pelo painel. */
export function describeLoopGuardPolicy(config: LoopGuardConfig): Array<[string, string]> {
  const limit = (value: number | null): string => (value === null ? 'sem limite' : String(value));
  return [
    ['Proteção ativa', config.enabled ? 'sim' : 'não'],
    ['Máximo de chamadas Claude', String(config.maxClaudeCallsPerPrompt)],
    ['Máximo de chamadas Codex', String(config.maxCodexCallsPerPrompt)],
    ['Máximo total de chamadas', String(config.maxTotalAgentCallsPerPrompt)],
    ['Tempo máximo por prompt', `${String(config.maxPromptDurationMinutes)} min`],
    ['Tempo máximo da execução', `${String(config.maxRunDurationMinutes)} min`],
    ['Revisões repetidas', `bloquear após ${String(config.maxRepeatedReviewFingerprints)}`],
    ['Falhas repetidas', `bloquear após ${String(config.maxRepeatedTestFailureFingerprints)}`],
    ['Correção sem progresso', `bloquear após ${String(config.maxConsecutiveNoProgress)}`],
    ['Oscilação de código', config.detectDiffOscillation ? 'detectar' : 'ignorar'],
    ['Oscilação de revisão', config.detectReviewOscillation ? 'detectar' : 'ignorar'],
    ['Prompt alterado na execução', config.stopOnPromptMutation ? 'bloquear' : 'ignorar'],
    ['Contexto alterado', config.stopOnContextMutation ? 'bloquear' : 'ignorar'],
    ['Violação de escopo', config.stopOnScopeViolation ? 'bloquear' : 'ignorar'],
    ['Máximo de arquivos no diff', limit(config.maxChangedFilesPerPrompt)],
    ['Máximo de linhas no diff', limit(config.maxChangedLinesPerPrompt)],
    ['Override manual', `${String(config.maxManualOverridesPerPrompt)} por prompt`],
    ['Ciclos de reparo de CI', String(config.maxCiRepairCycles)],
    ['Ciclos após auditoria final', String(config.maxMergeCorrectionCycles)],
    ['Espera máxima do CI', `${String(config.ciWaitTimeoutMinutes)} min`],
    ['Retentativas de formato', String(config.maxReviewFormatRetries)],
  ];
}

function int(value: unknown, fallback: number, min: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.floor(value));
}

function nullableInt(value: unknown, fallback: number | null, min: number): number | null {
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.floor(value));
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}
