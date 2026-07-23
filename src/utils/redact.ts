/**
 * Redação de segredos.
 *
 * Todo texto que possa chegar a logs, relatórios, artefatos ou ao painel passa
 * por aqui. O objetivo é garantir que nenhum token, chave de API ou credencial
 * seja gravado em disco ou exibido.
 */

const REDACTED = '«REDACTED»';

/** Padrões de segredo conhecidos, verificados por valor. */
const SECRET_PATTERNS: RegExp[] = [
  /\bsk-ant-[A-Za-z0-9_\-]{16,}/g, // Anthropic API key
  /\bsk-proj-[A-Za-z0-9_\-]{16,}/g, // OpenAI project key
  /\bsk-[A-Za-z0-9]{32,}/g, // OpenAI legacy key
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g, // GitHub tokens
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g, // GitHub fine-grained PAT
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/g, // Slack tokens
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, // JWT
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key id
];

/** Nomes de variáveis/campos cujo valor nunca deve ser exibido. */
const SENSITIVE_NAME = /(api[_-]?key|token|secret|password|passwd|credential|authorization|bearer)/i;

/** Redige segredos por padrão conhecido dentro de um texto livre. */
export function redactText(input: string): string {
  if (!input) return input;
  let output = input;
  for (const pattern of SECRET_PATTERNS) {
    output = output.replace(pattern, REDACTED);
  }
  // `NOME=valor` onde NOME é sensível.
  output = output.replace(
    /\b([A-Za-z_][A-Za-z0-9_]*)\s*[=:]\s*("?)([^\s"']{6,})\2/g,
    (match, name: string, quote: string, _value: string) =>
      SENSITIVE_NAME.test(name) ? `${name}=${quote}${REDACTED}${quote}` : match,
  );
  return output;
}

/**
 * Redige valores conhecidos do ambiente atual. Chamado com a lista de nomes de
 * variáveis sensíveis: o valor real é procurado no texto e substituído.
 * O valor em si nunca é retornado nem registrado.
 */
export function redactKnownValues(input: string, envVarNames: readonly string[]): string {
  let output = input;
  for (const name of envVarNames) {
    const value = process.env[name];
    if (value && value.length >= 8) {
      output = output.split(value).join(REDACTED);
    }
  }
  return output;
}

/** Redige recursivamente um objeto destinado a log/relatório. */
export function redactObject<T>(value: T, depth = 0): T {
  if (depth > 12) return '«DEPTH_LIMIT»' as unknown as T;
  if (typeof value === 'string') return redactText(value) as unknown as T;
  if (Array.isArray(value)) {
    return value.map((item) => redactObject(item, depth + 1)) as unknown as T;
  }
  if (value && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(source)) {
      result[key] = SENSITIVE_NAME.test(key) ? REDACTED : redactObject(item, depth + 1);
    }
    return result as unknown as T;
  }
  return value;
}

export const REDACTION_PLACEHOLDER = REDACTED;
