'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'orqpeg-scan-'));
process.env.ORQPEG_HOME = HOME;
process.env.ORQPEG_NO_FILE_LOG = '1';

const {
  buildFailureScanText,
  stripInstructionEcho,
  containsMarker,
} = require('../../dist/agents/failure-scan');
const { classifyClaudeFailure } = require('../../dist/agents/claude-agent');

/*
 * Regressão real e cara.
 *
 * O Codex CLI ecoa o prompt inteiro na stderr. O OrqPEG envia, dentro do pacote
 * de auditoria, o diff do PRÓPRIO código-fonte — e esse código contém, como
 * literais, os marcadores usados para detectar erro:
 *   "is not recognized as an internal or external command"  (process-runner)
 *   "usage limit", "not logged in", "unknown option"        (adaptadores)
 *
 * Ao varrer a stderr inteira, o adaptador lia a si mesmo e concluía que o Codex
 * não estava instalado. Numa auditoria real isso produziu a mensagem
 * "Codex CLI não foi encontrado no PATH" com o Codex instalado e funcionando.
 */

const MARCADORES_DO_PROPRIO_CODIGO = [
  "const CMD_NOT_RECOGNIZED_MARKERS = ['is not recognized as an internal or external command',",
  "const USAGE_LIMIT_MARKERS = ['usage limit', 'rate limit', 'quota exceeded'];",
  "const AUTH_REQUIRED_MARKERS = ['not logged in', 'please log in', 'authenticat'];",
  "const UNKNOWN_OPTION_MARKERS = ['unknown option', 'unrecognized option'];",
].join('\n');

test('o eco literal da instrução é removido do texto varrido', () => {
  const instruction = 'Audite este diff:\n' + MARCADORES_DO_PROPRIO_CODIGO;
  const scan = buildFailureScanText({
    stderr: 'Reading prompt from stdin...\nuser\n' + instruction + '\nerro: falha X',
    output: '',
    instruction,
    includeOutput: false,
  });

  assert.equal(
    containsMarker(scan, ['usage limit']),
    false,
    'marcador vindo do eco da instrução não pode sobreviver à limpeza',
  );
  assert.equal(containsMarker(scan, ['not logged in']), false);
  assert.equal(containsMarker(scan, ['unknown option']), false);
  assert.ok(scan.includes('erro: falha x'), 'o erro real precisa continuar visível');
});

test('um erro real de autenticação continua sendo detectado', () => {
  const instruction = 'Audite este diff:\n' + MARCADORES_DO_PROPRIO_CODIGO;
  const scan = buildFailureScanText({
    stderr: instruction + '\nFailed to authenticate: OAuth session expired',
    output: '',
    instruction,
    includeOutput: false,
  });
  assert.equal(
    containsMarker(scan, ['authenticat']),
    true,
    'o erro verdadeiro do CLI não pode ser removido junto com o eco',
  );
});

test('stripInstructionEcho remove instrução grande mesmo em pedaços', () => {
  const big = 'BLOCO-' + 'y'.repeat(9000);
  const text = 'prefixo\n' + big + '\nsufixo';
  const cleaned = stripInstructionEcho(text, big);
  assert.ok(cleaned.includes('prefixo'));
  assert.ok(cleaned.includes('sufixo'));
  assert.ok(cleaned.length < text.length / 2, 'o miolo ecoado deve sair');
});

test('stripInstructionEcho é inofensivo quando não há eco', () => {
  assert.equal(stripInstructionEcho('erro qualquer', 'instrucao diferente'), 'erro qualquer');
  assert.equal(stripInstructionEcho('', 'x'), '');
  assert.equal(stripInstructionEcho('texto', ''), 'texto');
});

test('a varredura é limitada mesmo quando o eco não bate literalmente', () => {
  // Cenário defensivo: o CLI reformata o eco, então a remoção literal falha.
  // A janela de início/fim precisa impedir que um marcador no MEIO do
  // megabyte ecoado contamine a classificação.
  const meio = 'x'.repeat(60_000) + ' usage limit ' + 'x'.repeat(60_000);
  const scan = buildFailureScanText({
    stderr: 'inicio do erro\n' + meio + '\nfim do erro',
    output: '',
    instruction: 'instrucao que nao aparece igual',
    includeOutput: false,
  });
  assert.equal(
    containsMarker(scan, ['usage limit']),
    false,
    'marcador enterrado no meio do eco não deve ser considerado',
  );
  assert.ok(scan.includes('inicio do erro'));
  assert.ok(scan.includes('fim do erro'));
});

test('texto curto não é recortado: o erro real aparece inteiro', () => {
  const scan = buildFailureScanText({
    stderr: 'You have reached your usage limit',
    output: '',
    instruction: 'qualquer',
    includeOutput: false,
  });
  assert.equal(containsMarker(scan, ['usage limit']), true);
});

test('cenário completo: diff do próprio OrqPEG ecoado não vira falso positivo', () => {
  const instruction =
    'Você é o auditor de merge. Analise o diff a seguir.\n' +
    MARCADORES_DO_PROPRIO_CODIGO.repeat(40);

  const scan = buildFailureScanText({
    stderr:
      'Reading prompt from stdin...\nOpenAI Codex v0.145.0\nsandbox: read-only\nuser\n' +
      instruction +
      '\n\nstream error: exceeded context window',
    output: '',
    instruction,
    includeOutput: true,
  });

  const classified = classifyClaudeFailure(scan);
  assert.equal(classified.usageLimitReached, false, 'não é limite de cota');
  assert.equal(classified.authRequired, false, 'não é falta de autenticação');
  assert.ok(scan.includes('exceeded context window'), 'o erro verdadeiro precisa sobreviver');
});
