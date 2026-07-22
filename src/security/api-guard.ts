import type { ApiGuardReport, GlobalConfig } from '../types';

/**
 * Guarda contra uso acidental de APIs pagas de IA.
 *
 * O OrqPEG opera exclusivamente com os executáveis locais `claude` e `codex`,
 * autenticados pelas assinaturas Claude Max e ChatGPT Plus. A presença de uma
 * variável de API indica risco de cobrança por token e, por padrão, bloqueia a
 * execução de IA.
 *
 * Regras invioláveis deste módulo:
 *  - o VALOR de uma variável de API nunca é lido, retornado, gravado ou logado;
 *  - apenas a existência (booleano) e o NOME são reportados;
 *  - a remoção acontece somente no ambiente do processo filho, jamais no
 *    ambiente persistente do Windows.
 */

/** Variáveis que bloqueiam a execução e são removidas do ambiente filho. */
export const BLOCKING_API_ENV_VARS: readonly string[] = [
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'CODEX_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'OPENAI_API_KEY_PATH',
  'ANTHROPIC_ADMIN_KEY',
];

/**
 * Variáveis apenas reportadas. Não bloqueiam porque podem fazer parte de uma
 * configuração corporativa legítima do próprio CLI, mas o usuário precisa saber
 * que estão ativas.
 */
export const WARN_ENV_VARS: readonly string[] = [
  'ANTHROPIC_BASE_URL',
  'OPENAI_BASE_URL',
  'ANTHROPIC_BEDROCK_BASE_URL',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'OPENAI_ORGANIZATION',
];

function isPresent(env: NodeJS.ProcessEnv, name: string): boolean {
  const value = env[name];
  return typeof value === 'string' && value.trim().length > 0;
}

export interface ApiGuardOptions {
  env?: NodeJS.ProcessEnv;
  config?: Pick<GlobalConfig, 'security'> | null;
}

/**
 * Inspeciona o ambiente e produz o relatório de guarda.
 * Nenhum valor de variável é incluído no retorno.
 */
export function inspectApiEnvironment(options: ApiGuardOptions = {}): ApiGuardReport {
  const env = options.env ?? process.env;
  const security = options.config?.security;

  const blockingNames = security?.strippedEnvVars?.length
    ? security.strippedEnvVars
    : [...BLOCKING_API_ENV_VARS];
  const warnNames = security?.warnEnvVars?.length ? security.warnEnvVars : [...WARN_ENV_VARS];
  const blockWhenPresent = security?.blockWhenApiKeysPresent ?? true;

  const presentKeys = blockingNames.filter((name) => isPresent(env, name));
  const warnKeys = warnNames.filter((name) => isPresent(env, name));

  return {
    presentKeys,
    warnKeys,
    blocked: blockWhenPresent && presentKeys.length > 0,
    strippedForChildren: [...blockingNames],
  };
}

/**
 * Verifica que nenhuma variável bloqueante sobreviveu no ambiente destinado a um
 * processo filho de IA. É a última linha de defesa antes do `spawn`.
 */
export function assertChildEnvIsClean(
  childEnv: NodeJS.ProcessEnv,
  strippedNames: readonly string[] = BLOCKING_API_ENV_VARS,
): { clean: boolean; leaked: string[] } {
  const leaked = strippedNames.filter((name) => isPresent(childEnv, name));
  return { clean: leaked.length === 0, leaked };
}

/** Mensagem legível de bloqueio, sem qualquer valor sensível. */
export function describeApiGuard(report: ApiGuardReport): string {
  if (report.presentKeys.length === 0 && report.warnKeys.length === 0) {
    return 'Nenhuma variável de API de IA detectada no ambiente.';
  }
  const lines: string[] = [];
  if (report.presentKeys.length > 0) {
    lines.push(
      `Variáveis de API detectadas (valores nunca são lidos): ${report.presentKeys.join(', ')}.`,
    );
    lines.push(
      report.blocked
        ? 'Execução de IA BLOQUEADA por padrão. Use --sanitize-env para rodar com ambiente filho sanitizado.'
        : 'Execução permitida: as variáveis serão removidas apenas do ambiente do processo filho.',
    );
  }
  if (report.warnKeys.length > 0) {
    lines.push(`Variáveis de roteamento detectadas (aviso): ${report.warnKeys.join(', ')}.`);
  }
  return lines.join('\n');
}
