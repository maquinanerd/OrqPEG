import * as path from 'node:path';
import type { LogLevel, LogRecord, Logger } from '../types';
import { appendLineSync } from './fs-atomic';
import { redactObject, redactText } from './redact';
import { ORQPEG_DIRS } from './paths';
import { nowIso } from './time';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface LoggerOptions {
  scope: string;
  minLevel?: LogLevel;
  /** Arquivo JSONL de destino. `null` desativa a gravação em disco. */
  filePath?: string | null;
  /** Escreve no console. Padrão: true para warn/error, controlado por `quiet`. */
  console?: boolean;
  quiet?: boolean;
}

class StructuredLogger implements Logger {
  private readonly scope: string;
  private readonly minLevel: LogLevel;
  private readonly filePath: string | null;
  private readonly useConsole: boolean;
  private readonly quiet: boolean;

  constructor(options: LoggerOptions) {
    this.scope = options.scope;
    this.minLevel = options.minLevel ?? resolveDefaultLevel();
    this.filePath = options.filePath === undefined ? defaultLogFile() : options.filePath;
    this.useConsole = options.console ?? true;
    this.quiet = options.quiet ?? false;
  }

  debug(message: string, data?: Record<string, unknown>): void {
    this.write('debug', message, data);
  }

  info(message: string, data?: Record<string, unknown>): void {
    this.write('info', message, data);
  }

  warn(message: string, data?: Record<string, unknown>): void {
    this.write('warn', message, data);
  }

  error(message: string, data?: Record<string, unknown>): void {
    this.write('error', message, data);
  }

  child(scope: string): Logger {
    return new StructuredLogger({
      scope: `${this.scope}:${scope}`,
      minLevel: this.minLevel,
      filePath: this.filePath,
      console: this.useConsole,
      quiet: this.quiet,
    });
  }

  private write(level: LogLevel, message: string, data?: Record<string, unknown>): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.minLevel]) return;

    const record: LogRecord = {
      timestamp: nowIso(),
      level,
      scope: this.scope,
      message: redactText(message),
      ...(data ? { data: redactObject(data) } : {}),
    };

    if (this.filePath) {
      try {
        appendLineSync(this.filePath, JSON.stringify(record));
      } catch {
        /* logging nunca deve derrubar a execução */
      }
    }

    if (!this.useConsole) return;
    if (this.quiet && (level === 'debug' || level === 'info')) return;

    const line = `${symbolFor(level)} ${record.message}`;
    if (level === 'error') process.stderr.write(`${line}\n`);
    else if (level === 'warn') process.stderr.write(`${line}\n`);
    else process.stdout.write(`${line}\n`);
  }
}

function symbolFor(level: LogLevel): string {
  switch (level) {
    case 'debug':
      return '  ·';
    case 'info':
      return '  •';
    case 'warn':
      return '  !';
    case 'error':
      return '  x';
    default:
      return '  •';
  }
}

function resolveDefaultLevel(): LogLevel {
  const raw = (process.env['ORQPEG_LOG_LEVEL'] ?? '').toLowerCase();
  if (raw === 'debug' || raw === 'info' || raw === 'warn' || raw === 'error') return raw;
  return 'info';
}

function defaultLogFile(): string | null {
  if (process.env['ORQPEG_NO_FILE_LOG'] === '1') return null;
  const day = nowIso().slice(0, 10);
  return path.join(ORQPEG_DIRS.logs(), `orqpeg-${day}.jsonl`);
}

export function createLogger(options: LoggerOptions): Logger {
  return new StructuredLogger(options);
}

/** Logger silencioso, usado em testes e em caminhos que não devem poluir stdout. */
export function nullLogger(scope = 'null'): Logger {
  return new StructuredLogger({ scope, filePath: null, console: false });
}
