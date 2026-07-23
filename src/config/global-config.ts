import * as path from 'node:path';
import type { GlobalConfig, Result } from '../types';
import { fail, ok } from '../utils/errors';
import { fileExists, readJsonSync, writeJsonAtomicSync } from '../utils/fs-atomic';
import { ORQPEG_DIRS, ensureDir, orqpegRoot } from '../utils/paths';
import { BLOCKING_API_ENV_VARS, WARN_ENV_VARS } from '../security/api-guard';

export function globalConfigPath(): string {
  return path.join(ORQPEG_DIRS.config(), 'global.json');
}

export function globalConfigExamplePath(): string {
  return path.join(ORQPEG_DIRS.config(), 'global.example.json');
}

export function defaultGlobalConfig(): GlobalConfig {
  return {
    version: '1.0.0',
    panel: {
      host: '127.0.0.1',
      port: 8765,
      openBrowserOnStart: true,
    },
    agents: {
      claudeCommand: 'claude',
      codexCommand: 'codex',
      claudeTimeoutSeconds: 3600,
      codexTimeoutSeconds: 1800,
      defaultClaudeModel: null,
      defaultCodexModel: null,
    },
    security: {
      blockWhenApiKeysPresent: true,
      strippedEnvVars: [...BLOCKING_API_ENV_VARS],
      warnEnvVars: [...WARN_ENV_VARS],
    },
    git: {
      allowForcePush: false,
    },
    paths: {
      defaultWorktreeRoot: null,
    },
  };
}

/**
 * Carrega a configuração global, mesclando com os padrões.
 * Campos ausentes ou inválidos assumem o padrão, sem falhar a execução.
 */
export function loadGlobalConfig(): Result<GlobalConfig> {
  const configPath = globalConfigPath();
  const defaults = defaultGlobalConfig();

  if (!fileExists(configPath)) return ok(defaults);

  const read = readJsonSync<Partial<GlobalConfig>>(configPath);
  if (!read.ok) return read;

  return ok(mergeWithDefaults(read.value, defaults));
}

export function saveGlobalConfig(config: GlobalConfig): Result<void> {
  ensureDir(ORQPEG_DIRS.config());
  return writeJsonAtomicSync(globalConfigPath(), config);
}

/** Cria `config/global.json` e `config/global.example.json` se não existirem. */
export function ensureGlobalConfig(): Result<GlobalConfig> {
  ensureDir(ORQPEG_DIRS.config());
  const defaults = defaultGlobalConfig();

  if (!fileExists(globalConfigExamplePath())) {
    const written = writeJsonAtomicSync(globalConfigExamplePath(), defaults);
    if (!written.ok) return written;
  }

  if (!fileExists(globalConfigPath())) {
    const written = writeJsonAtomicSync(globalConfigPath(), defaults);
    if (!written.ok) return written;
    return ok(defaults);
  }

  return loadGlobalConfig();
}

export function validateGlobalConfig(config: GlobalConfig): Result<GlobalConfig> {
  if (config.panel.host !== '127.0.0.1' && config.panel.host !== 'localhost') {
    return fail(
      'CONFIG_INVALID',
      'O painel só pode escutar em 127.0.0.1 ou localhost. Escuta externa é proibida.',
      { host: config.panel.host },
    );
  }
  if (!Number.isInteger(config.panel.port) || config.panel.port < 1024 || config.panel.port > 65535) {
    return fail('CONFIG_INVALID', 'Porta do painel deve ser um inteiro entre 1024 e 65535.', {
      port: config.panel.port,
    });
  }
  if (config.git.allowForcePush !== false) {
    return fail('CONFIG_INVALID', 'force push é proibido pelo OrqPEG e não pode ser habilitado.');
  }
  if (config.agents.claudeTimeoutSeconds <= 0 || config.agents.codexTimeoutSeconds <= 0) {
    return fail('CONFIG_INVALID', 'Timeouts de agentes devem ser positivos.');
  }
  return ok(config);
}

function mergeWithDefaults(
  partial: Partial<GlobalConfig>,
  defaults: GlobalConfig,
): GlobalConfig {
  return {
    version: typeof partial.version === 'string' ? partial.version : defaults.version,
    panel: {
      host: pickString(partial.panel?.host, defaults.panel.host),
      port: pickNumber(partial.panel?.port, defaults.panel.port),
      openBrowserOnStart: pickBoolean(
        partial.panel?.openBrowserOnStart,
        defaults.panel.openBrowserOnStart,
      ),
    },
    agents: {
      claudeCommand: pickString(partial.agents?.claudeCommand, defaults.agents.claudeCommand),
      codexCommand: pickString(partial.agents?.codexCommand, defaults.agents.codexCommand),
      claudeTimeoutSeconds: pickNumber(
        partial.agents?.claudeTimeoutSeconds,
        defaults.agents.claudeTimeoutSeconds,
      ),
      codexTimeoutSeconds: pickNumber(
        partial.agents?.codexTimeoutSeconds,
        defaults.agents.codexTimeoutSeconds,
      ),
      defaultClaudeModel: pickNullableString(partial.agents?.defaultClaudeModel),
      defaultCodexModel: pickNullableString(partial.agents?.defaultCodexModel),
    },
    security: {
      blockWhenApiKeysPresent: pickBoolean(
        partial.security?.blockWhenApiKeysPresent,
        defaults.security.blockWhenApiKeysPresent,
      ),
      strippedEnvVars: pickStringArray(
        partial.security?.strippedEnvVars,
        defaults.security.strippedEnvVars,
      ),
      warnEnvVars: pickStringArray(partial.security?.warnEnvVars, defaults.security.warnEnvVars),
    },
    // `allowForcePush` é intencionalmente fixo: não é configurável.
    git: { allowForcePush: false },
    paths: {
      defaultWorktreeRoot: pickNullableString(partial.paths?.defaultWorktreeRoot),
    },
  };
}

function pickString(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim().length > 0 ? value : fallback;
}

function pickNullableString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function pickNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function pickBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function pickStringArray(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) return fallback;
  const filtered = value.filter((item): item is string => typeof item === 'string');
  return filtered.length > 0 ? filtered : fallback;
}

/** Caminho absoluto da raiz do OrqPEG, exposto para diagnóstico e painel. */
export function installationRoot(): string {
  return orqpegRoot();
}
