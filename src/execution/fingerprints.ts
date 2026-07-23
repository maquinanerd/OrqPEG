import * as crypto from 'node:crypto';
import type { PromptReview, ReviewIssue, TestSuiteResult } from '../types';

/**
 * Assinaturas normalizadas de diff, revisão e falha de teste.
 *
 * O Loop Guard precisa responder a uma pergunta simples: "isto já aconteceu
 * antes?". Comparar textos crus não serve — duas execuções do mesmo teste
 * diferem em timestamp, duração, caminho temporário e número de porta; duas
 * revisões do mesmo problema diferem em pontuação e ordem dos itens. A
 * normalização remove essa variação incidental e preserva só o que identifica
 * o conteúdo, para que repetição real seja detectada e variação cosmética não
 * produza falso "progresso".
 */

const HASH_LENGTH = 16;

function sha(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex').slice(0, HASH_LENGTH);
}

/* ------------------------------------------------------------------------- */
/* Diff                                                                       */
/* ------------------------------------------------------------------------- */

/**
 * Normaliza um patch unificado antes do hash.
 *
 * Removemos os cabeçalhos que mudam sem que o código mude — `index abc..def`,
 * as âncoras de linha de `@@` e as datas de `---`/`+++` — e mantemos apenas os
 * caminhos e as linhas adicionadas ou removidas. Assim, um mesmo conjunto de
 * alterações produz sempre a mesma assinatura, mesmo aplicado sobre outra base.
 */
export function normalizeDiff(patch: string): string {
  if (typeof patch !== 'string' || patch.length === 0) return '';

  const kept: string[] = [];
  for (const rawLine of patch.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+$/, '');

    if (line.startsWith('index ')) continue;
    if (line.startsWith('similarity index')) continue;
    if (line.startsWith('@@')) {
      // Mantém o marcador, descarta os números de linha.
      kept.push('@@');
      continue;
    }
    if (line.startsWith('--- ') || line.startsWith('+++ ')) {
      kept.push(line.replace(/\t.*$/, ''));
      continue;
    }
    if (line.startsWith('diff --git ')) {
      kept.push(line);
      continue;
    }
    if (line.startsWith('+') || line.startsWith('-')) {
      kept.push(line);
      continue;
    }
    // Linhas de contexto não entram: elas mudam quando o arquivo ao redor muda.
  }

  return kept.join('\n');
}

export function diffFingerprint(patch: string): string {
  const normalized = normalizeDiff(patch);
  return normalized.length === 0 ? 'empty' : sha(normalized);
}

/** Conta arquivos e linhas efetivamente alteradas em um patch unificado. */
export function measureDiff(patch: string): { files: number; lines: number } {
  if (typeof patch !== 'string' || patch.length === 0) return { files: 0, lines: 0 };
  let files = 0;
  let lines = 0;
  for (const rawLine of patch.split(/\r?\n/)) {
    if (rawLine.startsWith('diff --git ')) {
      files += 1;
      continue;
    }
    if (rawLine.startsWith('+++ ') || rawLine.startsWith('--- ')) continue;
    if (rawLine.startsWith('+') || rawLine.startsWith('-')) lines += 1;
  }
  return { files, lines };
}

/* ------------------------------------------------------------------------- */
/* Revisão                                                                    */
/* ------------------------------------------------------------------------- */

/**
 * Normaliza um texto livre vindo de uma IA: caixa, acentos, pontuação e
 * espaços saem; sobra a substância. Sem isso, "Falta teste." e "falta teste"
 * seriam problemas diferentes e a repetição passaria despercebida.
 */
export function normalizeText(value: unknown): string {
  if (typeof value !== 'string') return '';
  return (
    value
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9\s/._-]/g, ' ')
      /*
       * `.` `/` `_` `-` são preservados porque carregam sentido dentro de um
       * caminho (`src/app.ts`), mas só quando estão ENTRE alfanuméricos. Solto,
       * o caractere é pontuação de prosa: sem esta regra, "adicione um teste."
       * e "adicione um teste" seriam problemas diferentes e a repetição
       * passaria despercebida.
       */
      .replace(/(?<![a-z0-9])[._/-]|[._/-](?![a-z0-9])/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  );
}

function normalizeIssue(issue: ReviewIssue): string {
  const parts = [
    normalizeText(issue.severity),
    normalizeText(issue.file ?? ''),
    // A linha exata muda quando o arquivo cresce; a faixa é estável o bastante.
    issue.line === undefined || issue.line === null ? '' : String(Math.floor(issue.line / 10)),
    normalizeText(issue.title),
    normalizeText(issue.description).slice(0, 240),
  ];
  return parts.join('|');
}

/**
 * Assinatura do CONJUNTO de problemas de uma revisão.
 *
 * Os itens são ordenados antes do hash: a mesma lista em ordem diferente é o
 * mesmo conjunto de problemas, e trocar a ordem não é progresso.
 */
export function reviewFingerprint(review: PromptReview | null): string | null {
  if (!review) return null;

  const issues = [
    ...(Array.isArray(review.blockingIssues) ? review.blockingIssues : []),
    ...(Array.isArray(review.nonBlockingIssues) ? review.nonBlockingIssues : []),
  ]
    .filter((issue) => issue && issue.severity === 'blocking')
    .map(normalizeIssue);

  const actions = (Array.isArray(review.requiredActions) ? review.requiredActions : [])
    .map((action) => normalizeText(action).slice(0, 200))
    .filter((action) => action.length > 0);

  const material = [...issues, ...actions].sort();
  if (material.length === 0) {
    // Sem bloqueador e sem ação: a assinatura é do próprio veredito.
    return sha(`verdict:${normalizeText(review.verdict)}`);
  }
  return sha(material.join('\n'));
}

/* ------------------------------------------------------------------------- */
/* Falha de teste                                                             */
/* ------------------------------------------------------------------------- */

/**
 * Remove da saída de teste tudo que muda a cada execução sem que a falha mude.
 * Sem esta limpeza, a mesma falha nunca teria a mesma assinatura e o gatilho de
 * repetição jamais dispararia.
 */
export function normalizeTestOutput(value: string): string {
  if (typeof value !== 'string') return '';
  return value
    /* Datas e horas. */
    .replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})?/g, '<TS>')
    /* Durações. */
    .replace(/\b\d+(\.\d+)?\s?(ms|s|seconds|segundos)\b/gi, '<DUR>')
    /* Caminhos temporários do Windows e POSIX. */
    .replace(/[A-Za-z]:\\[^\s:*?"<>|]*[Tt]emp[^\s:*?"<>|]*/g, '<TMP>')
    .replace(/\/tmp\/[^\s:]+/g, '<TMP>')
    /* Portas efêmeras e PIDs. */
    .replace(/\b(port|porta|pid)\s*[:=]?\s*\d{2,6}\b/gi, '$1 <NUM>')
    /* Identificadores aleatórios: uuid e hex longo. */
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<UUID>')
    .replace(/\b[0-9a-f]{16,}\b/gi, '<HEX>')
    /* Números de linha em stack traces. */
    .replace(/:(\d+):(\d+)\)/g, ':<L>:<C>)')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * Assinatura da falha de uma suíte.
 *
 * Considera apenas os comandos que falharam, e de cada um: o comando, o código
 * de saída e um trecho normalizado da saída. Uma suíte aprovada não tem
 * assinatura de falha.
 */
export function testFailureFingerprint(suite: TestSuiteResult | null): string | null {
  if (!suite || suite.passed === true) return null;

  const failures = (Array.isArray(suite.commands) ? suite.commands : [])
    .filter((command) => command && command.status !== 'PASSED' && command.status !== 'NOT_RUN')
    .map((command) => {
      const output = normalizeTestOutput(
        `${command.stderr ?? ''}\n${command.stdout ?? ''}`,
      ).slice(0, 1200);
      return [
        normalizeText(command.command),
        command.status,
        String(command.exitCode ?? 'null'),
        output,
      ].join('|');
    })
    .sort();

  if (failures.length === 0) return sha(`suite:${normalizeText(suite.status)}`);
  return sha(failures.join('\n'));
}

/* ------------------------------------------------------------------------- */
/* Conteúdo canônico                                                          */
/* ------------------------------------------------------------------------- */

/** Hash de um documento (prompt, contexto). Só o conteúdo importa. */
export function contentHash(value: string): string {
  if (typeof value !== 'string') return 'absent';
  return sha(value.replace(/\r\n/g, '\n').trim());
}

/**
 * Hash da configuração do projeto, ignorando campos que mudam sem alterar a
 * semântica da execução — `updatedAt` é o caso óbvio: gravar o projeto sem
 * mudar nada não pode invalidar uma execução em curso.
 */
export function projectConfigHash(config: unknown): string {
  if (!config || typeof config !== 'object') return 'absent';
  const clone = JSON.parse(JSON.stringify(config)) as Record<string, unknown>;
  delete clone['updatedAt'];
  delete clone['createdAt'];
  return sha(stableStringify(clone));
}

/**
 * Hash de um objeto por conteúdo, insensível à ordem das chaves.
 *
 * A ordem das propriedades no JSON e o espaçamento do arquivo não têm
 * significado; um hash que reagisse a eles interromperia execuções por
 * reformatação.
 */
export function stableHash(value: unknown): string {
  return sha(stableStringify(value));
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`;
}

/* ------------------------------------------------------------------------- */
/* Oscilação                                                                  */
/* ------------------------------------------------------------------------- */

/**
 * Detecta o padrão A → B → A no histórico.
 *
 * É o sintoma de duas soluções concorrentes: o Claude aplica uma, o Codex pede
 * a outra, e o ciclo se repete sem convergir. Contar tentativas não pegaria
 * isso, porque cada volta parece "progresso" quando olhada isoladamente.
 */
export function detectOscillation(history: readonly string[]): boolean {
  if (history.length < 3) return false;
  const size = history.length;
  const last = history[size - 1];
  const middle = history[size - 2];
  const first = history[size - 3];
  if (last === undefined || middle === undefined || first === undefined) return false;
  return last === first && last !== middle;
}

/** Quantas vezes o valor mais recente aparece em sequência no fim do histórico. */
export function trailingRepeatCount(history: readonly string[]): number {
  if (history.length === 0) return 0;
  const last = history[history.length - 1];
  let count = 0;
  for (let i = history.length - 1; i >= 0; i -= 1) {
    if (history[i] !== last) break;
    count += 1;
  }
  return count;
}

/** Acrescenta ao histórico mantendo um limite fixo — nada cresce sem teto. */
export function pushBounded(history: readonly string[], value: string, limit = 5): string[] {
  const next = [...history, value];
  return next.length <= limit ? next : next.slice(next.length - limit);
}
