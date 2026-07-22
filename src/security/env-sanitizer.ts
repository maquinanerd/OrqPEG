import { BLOCKING_API_ENV_VARS } from './api-guard';

/**
 * Construção do ambiente sanitizado para processos filhos de IA.
 *
 * O ambiente do Windows do usuário NÃO é alterado: a remoção ocorre apenas na
 * cópia entregue ao `spawn`. Isso satisfaz o requisito de "zero API" sem exigir
 * que o usuário desconfigure a própria máquina.
 */

export interface SanitizeOptions {
  /** Ambiente de origem. Padrão: `process.env`. */
  source?: NodeJS.ProcessEnv;
  /** Nomes a remover. Padrão: `BLOCKING_API_ENV_VARS`. */
  strip?: readonly string[];
  /** Variáveis adicionais a injetar no filho. */
  extra?: Readonly<Record<string, string>>;
}

export interface SanitizedEnv {
  env: NodeJS.ProcessEnv;
  /** Nomes efetivamente removidos (estavam presentes na origem). */
  removed: string[];
}

/**
 * Devolve uma cópia do ambiente sem as variáveis de API.
 *
 * A remoção é case-insensitive porque o Windows trata nomes de variáveis de
 * ambiente sem diferenciar maiúsculas: `anthropic_api_key` e `ANTHROPIC_API_KEY`
 * são a mesma variável para um processo filho.
 */
export function buildSanitizedEnv(options: SanitizeOptions = {}): SanitizedEnv {
  const source = options.source ?? process.env;
  const strip = options.strip ?? BLOCKING_API_ENV_VARS;
  const stripLower = new Set(strip.map((name) => name.toLowerCase()));

  const env: NodeJS.ProcessEnv = {};
  const removed: string[] = [];

  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (stripLower.has(key.toLowerCase())) {
      if (value.trim().length > 0) removed.push(key);
      continue;
    }
    env[key] = value;
  }

  // Marcador de proveniência: permite que hooks/scripts do usuário saibam que
  // estão rodando sob o OrqPEG sem expor qualquer segredo.
  env['ORQPEG_MANAGED'] = '1';

  if (options.extra) {
    for (const [key, value] of Object.entries(options.extra)) {
      env[key] = value;
    }
  }

  return { env, removed };
}

/**
 * Ambiente sanitizado para ferramentas que não são de IA (git, gh, npm).
 *
 * Estas ferramentas não consomem tokens de IA, mas ainda assim recebem o
 * ambiente limpo: se um comando de teste do projeto invocar indiretamente um
 * SDK de IA, ele não encontrará chave alguma.
 */
export function buildToolEnv(options: SanitizeOptions = {}): NodeJS.ProcessEnv {
  return buildSanitizedEnv(options).env;
}
