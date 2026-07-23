import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import type { Result } from '../types';
import { fail, ok } from '../utils/errors';
import { ensureDir, projectStateDir } from '../utils/paths';
import { nowIso } from '../utils/time';
import { validateIdentifier } from '../security/path-guard';

/**
 * Diário durável de intenção de commit.
 *
 * O buraco que ele fecha: entre `git commit` e a gravação do SHA no
 * `RunRecord` existe uma janela. Se o processo cair ali — queda de energia,
 * Ctrl+C, disco recusando a escrita — o commit EXISTE na branch e NÃO existe no
 * registro. Na retomada, a guarda de duplicidade consulta `run.commits`, não
 * encontra nada, e o prompt é reexecutado e commitado de novo. A branch que vai
 * para o merge fica com trabalho duplicado.
 *
 * A ordem que resolve é a de um write-ahead log:
 *
 *     1. gravar a INTENÇÃO no diário (com `fsync`), antes de tocar no Git;
 *     2. commitar, carimbando no commit o identificador da operação;
 *     3. registrar o SHA no `RunRecord`;
 *     4. marcar a entrada do diário como conciliada.
 *
 * Uma queda em qualquer ponto deixa uma entrada PENDENTE. A retomada procura no
 * histórico da branch um commit que carregue aquele identificador; se achar,
 * adota o commit em vez de refazê-lo.
 *
 * O identificador é aleatório de 128 bits e vive só no disco local do OrqPEG:
 * forjar o carimbo exigiria adivinhá-lo. Ainda assim, a conciliação não confia
 * apenas no carimbo — quem a executa também exige que o commit esteja
 * alcançável a partir do HEAD da branch da execução e que ele altere ao menos
 * um arquivo.
 */

/** Chave do carimbo de execução no rodapé do commit. */
export const TRAILER_RUN_ID = 'OrqPEG-Run-Id';
/** Chave do carimbo de prompt no rodapé do commit. */
export const TRAILER_PROMPT_ID = 'OrqPEG-Prompt-Id';
/** Chave do carimbo de tentativa no rodapé do commit. */
export const TRAILER_ATTEMPT = 'OrqPEG-Attempt';
/** Chave do identificador único da operação no rodapé do commit. */
export const TRAILER_OPERATION_ID = 'OrqPEG-Operation-Id';

export interface CommitJournalEntry {
  /** Identificador único desta tentativa de commit. Nunca reaproveitado. */
  operationId: string;
  runId: string;
  projectId: string;
  /** `promptId` do laço, ou a chave sintética de reparo/correção. */
  promptId: string;
  attempt: number;
  message: string;
  startedAt: string;
  /** SHA registrado depois do sucesso. `null` enquanto pendente. */
  commitSha: string | null;
  /** Momento da conciliação (sucesso normal ou adoção após queda). */
  settledAt: string | null;
  /** Como a entrada foi encerrada. `null` enquanto pendente. */
  outcome: 'COMMITTED' | 'ADOPTED' | 'ABANDONED' | null;
}

function journalPath(projectId: string, runId: string): string {
  return path.join(projectStateDir(projectId), `${runId}.commit-journal.json`);
}

function validate(projectId: string, runId: string): Result<{ projectId: string; runId: string }> {
  const projectCheck = validateIdentifier(projectId, 'id do projeto');
  if (!projectCheck.ok) return projectCheck;
  const runCheck = validateIdentifier(runId, 'id da execução');
  if (!runCheck.ok) return runCheck;
  return ok({ projectId: projectCheck.value, runId: runCheck.value });
}

/** Identificador de operação: 128 bits aleatórios, em hexadecimal. */
export function newOperationId(): string {
  return crypto.randomBytes(16).toString('hex');
}

export function readCommitJournal(projectId: string, runId: string): CommitJournalEntry[] {
  const checked = validate(projectId, runId);
  if (!checked.ok) return [];

  try {
    const raw: unknown = JSON.parse(
      fs.readFileSync(journalPath(checked.value.projectId, checked.value.runId), 'utf8'),
    );
    if (!Array.isArray(raw)) return [];
    return raw.filter(isEntry);
  } catch {
    /* Ausente ou ilegível: nada pendente que possamos provar. A conciliação
       trata isso como "sem diário", que é o comportamento anterior. */
    return [];
  }
}

/** Entradas ainda não conciliadas — as que uma queda pode ter deixado para trás. */
export function pendingCommitEntries(projectId: string, runId: string): CommitJournalEntry[] {
  return readCommitJournal(projectId, runId).filter((entry) => entry.outcome === null);
}

/**
 * Grava o diário com `fsync` explícito.
 *
 * `fsync` não é zelo excessivo aqui: sem ele, a intenção pode ficar só no cache
 * do sistema operacional, e uma queda de energia entre o commit e o flush
 * devolveria exatamente o cenário que o diário existe para eliminar.
 */
function writeJournal(
  projectId: string,
  runId: string,
  entries: CommitJournalEntry[],
): Result<void> {
  const filePath = journalPath(projectId, runId);
  const tempPath = `${filePath}.${String(process.pid)}.tmp`;
  let handle: number | null = null;

  try {
    ensureDir(path.dirname(filePath));
    handle = fs.openSync(tempPath, 'w');
    fs.writeFileSync(handle, `${JSON.stringify(entries, null, 2)}\n`, 'utf8');
    fs.fsyncSync(handle);
    fs.closeSync(handle);
    handle = null;
    fs.renameSync(tempPath, filePath);
    return ok(undefined);
  } catch (error) {
    if (handle !== null) {
      try {
        fs.closeSync(handle);
      } catch {
        /* já fechado */
      }
    }
    try {
      if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    } catch {
      /* melhor esforço */
    }
    return fail('IO_FAILED', `Falha ao gravar o diário de commits em ${filePath}.`, { filePath }, error);
  }
}

export interface OpenCommitInput {
  projectId: string;
  runId: string;
  promptId: string;
  attempt: number;
  message: string;
}

/**
 * Abre a intenção de commit ANTES de o Git ser chamado.
 *
 * Falhar aqui é motivo para NÃO commitar: commitar sem diário reabre a janela.
 */
export function openCommitIntent(input: OpenCommitInput): Result<CommitJournalEntry> {
  const checked = validate(input.projectId, input.runId);
  if (!checked.ok) return checked;

  const entry: CommitJournalEntry = {
    operationId: newOperationId(),
    runId: checked.value.runId,
    projectId: checked.value.projectId,
    promptId: input.promptId,
    attempt: input.attempt,
    message: input.message,
    startedAt: nowIso(),
    commitSha: null,
    settledAt: null,
    outcome: null,
  };

  const entries = [...readCommitJournal(checked.value.projectId, checked.value.runId), entry];
  const written = writeJournal(checked.value.projectId, checked.value.runId, entries);
  if (!written.ok) return written;
  return ok(entry);
}

/** Encerra a entrada, com o SHA que passou a existir (ou o abandono). */
export function settleCommitIntent(
  projectId: string,
  runId: string,
  operationId: string,
  outcome: 'COMMITTED' | 'ADOPTED' | 'ABANDONED',
  commitSha: string | null,
): Result<void> {
  const checked = validate(projectId, runId);
  if (!checked.ok) return checked;

  const entries = readCommitJournal(checked.value.projectId, checked.value.runId).map((entry) =>
    entry.operationId === operationId
      ? { ...entry, outcome, commitSha, settledAt: nowIso() }
      : entry,
  );
  return writeJournal(checked.value.projectId, checked.value.runId, entries);
}

/**
 * Acrescenta os carimbos de identidade ao rodapé da mensagem de commit.
 *
 * A mensagem humana NUNCA é usada como identidade: ela é derivada do prompt e
 * seria idêntica entre duas tentativas do mesmo trabalho. Só o `Operation-Id`
 * identifica a operação.
 */
export function withCommitTrailers(message: string, entry: CommitJournalEntry): string {
  const trailers = [
    `${TRAILER_RUN_ID}: ${entry.runId}`,
    `${TRAILER_PROMPT_ID}: ${entry.promptId}`,
    `${TRAILER_ATTEMPT}: ${String(entry.attempt)}`,
    `${TRAILER_OPERATION_ID}: ${entry.operationId}`,
  ].join('\n');
  return `${message.trimEnd()}\n\n${trailers}\n`;
}

/** Lê um carimbo do corpo do commit. `null` quando ausente. */
export function readTrailer(commitMessage: string, key: string): string | null {
  for (const line of commitMessage.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.toLowerCase().startsWith(`${key.toLowerCase()}:`)) continue;
    const value = trimmed.slice(key.length + 1).trim();
    if (value.length > 0) return value;
  }
  return null;
}

function isEntry(value: unknown): value is CommitJournalEntry {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const raw = value as Record<string, unknown>;
  return (
    typeof raw['operationId'] === 'string' &&
    typeof raw['runId'] === 'string' &&
    typeof raw['projectId'] === 'string' &&
    typeof raw['promptId'] === 'string' &&
    typeof raw['attempt'] === 'number' &&
    typeof raw['message'] === 'string' &&
    (raw['commitSha'] === null || typeof raw['commitSha'] === 'string') &&
    (raw['outcome'] === null ||
      raw['outcome'] === 'COMMITTED' ||
      raw['outcome'] === 'ADOPTED' ||
      raw['outcome'] === 'ABANDONED')
  );
}
