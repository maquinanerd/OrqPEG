import type { ErrorCode, Err, Ok, OrqError, Result } from '../types';

export function ok<T>(value: T): Ok<T> {
  return { ok: true, value };
}

export function err<E = OrqError>(error: E): Err<E> {
  return { ok: false, error };
}

export function fail(
  code: ErrorCode,
  message: string,
  details?: Record<string, unknown>,
  cause?: unknown,
): Err<OrqError> {
  const error: OrqError = {
    code,
    message,
    ...(details ? { details } : {}),
    ...(cause !== undefined ? { cause: describeCause(cause) } : {}),
  };
  return { ok: false, error };
}

export function describeCause(cause: unknown): string {
  if (cause instanceof Error) {
    return cause.stack ? `${cause.name}: ${cause.message}` : String(cause);
  }
  if (typeof cause === 'string') return cause;
  try {
    return JSON.stringify(cause);
  } catch {
    return String(cause);
  }
}

export function isOk<T, E>(result: Result<T, E>): result is Ok<T> {
  return result.ok;
}

export function isErr<T, E>(result: Result<T, E>): result is Err<E> {
  return !result.ok;
}

/** Extrai o valor ou lança. Use apenas em fronteiras (CLI/servidor). */
export function unwrap<T>(result: Result<T, OrqError>): T {
  if (result.ok) return result.value;
  throw new OrqExecutionError(result.error);
}

export class OrqExecutionError extends Error {
  readonly orqError: OrqError;

  constructor(orqError: OrqError) {
    super(`[${orqError.code}] ${orqError.message}`);
    this.name = 'OrqExecutionError';
    this.orqError = orqError;
  }
}

export function formatError(error: OrqError): string {
  const parts = [`[${error.code}] ${error.message}`];
  if (error.details && Object.keys(error.details).length > 0) {
    parts.push(`  detalhes: ${safeStringify(error.details)}`);
  }
  if (error.cause) {
    parts.push(`  causa: ${error.cause.split('\n')[0] ?? ''}`);
  }
  return parts.join('\n');
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
