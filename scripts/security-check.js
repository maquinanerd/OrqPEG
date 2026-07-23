#!/usr/bin/env node
'use strict';

/**
 * Verificações de segurança do próprio repositório do OrqPEG.
 *
 * Node puro, sem nenhuma dependência. Executa seis verificações e sai com
 * código 1 quando qualquer uma delas falha, imprimindo exatamente o que falhou
 * e onde.
 *
 *   (a) nenhum arquivo chama endpoints de API de IA;
 *   (b) nenhum import de SDK de provedor de IA;
 *   (c) "dependencies" do package.json está vazio;
 *   (d) nenhum uso de shell, exec síncrono ou comando Git destrutivo em src/;
 *   (e) nenhum segredo aparente commitado;
 *   (f) o servidor do painel não escuta em endereço público.
 *
 * As verificações (d) e (f) analisam o código-fonte com os comentários
 * removidos, para que menções em documentação interna não gerem falso
 * positivo. As demais ignoram este próprio arquivo, que necessariamente cita os
 * padrões procurados.
 */

const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..');
const SELF_RELATIVE = path.join('scripts', 'security-check.js');

/** Diretórios nunca inspecionados: não são código versionado do produto. */
const SKIPPED_DIRECTORIES = new Set([
  '.git',
  'node_modules',
  'dist',
  'data',
  'coverage',
  'tmp',
  '.vscode',
  '.idea',
]);

/** Extensões consideradas texto para varredura. */
const TEXT_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.cjs',
  '.mjs',
  '.json',
  '.md',
  '.html',
  '.css',
  '.yml',
  '.yaml',
  '.cmd',
  '.bat',
  '.ps1',
  '.txt',
  '.gitignore',
]);

const MAX_FILE_BYTES = 4 * 1024 * 1024;

/* ------------------------------------------------------------------------- */
/* Coleta de arquivos                                                         */
/* ------------------------------------------------------------------------- */

/**
 * Lista recursivamente os arquivos de texto do repositório.
 * @param {string} startDir diretório inicial, absoluto
 * @returns {string[]} caminhos absolutos
 */
function listTextFiles(startDir) {
  const found = [];
  const pending = [startDir];

  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) break;

    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch (error) {
      process.stdout.write(
        `  aviso: nao foi possivel ler ${current}: ${describeError(error)}\n`,
      );
      continue;
    }

    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (SKIPPED_DIRECTORIES.has(entry.name)) continue;
        pending.push(full);
        continue;
      }
      if (!entry.isFile()) continue;

      const extension = path.extname(entry.name).toLowerCase();
      const isText =
        TEXT_EXTENSIONS.has(extension) || TEXT_EXTENSIONS.has(entry.name.toLowerCase());
      if (!isText) continue;

      let stats;
      try {
        stats = fs.statSync(full);
      } catch (error) {
        process.stdout.write(`  aviso: ${full}: ${describeError(error)}\n`);
        continue;
      }
      if (stats.size > MAX_FILE_BYTES) continue;

      found.push(full);
    }
  }

  found.sort();
  return found;
}

/**
 * @param {string} absolutePath
 * @returns {string} caminho relativo à raiz, com separador do sistema
 */
function relative(absolutePath) {
  return path.relative(REPO_ROOT, absolutePath);
}

/**
 * @param {string} absolutePath
 * @returns {string} conteúdo do arquivo, ou string vazia em caso de falha
 */
function readText(absolutePath) {
  try {
    return fs.readFileSync(absolutePath, 'utf8');
  } catch (error) {
    process.stdout.write(`  aviso: ${relative(absolutePath)}: ${describeError(error)}\n`);
    return '';
  }
}

/**
 * @param {unknown} error
 * @returns {string}
 */
function describeError(error) {
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * @param {string} absolutePath
 * @returns {boolean} verdadeiro quando o arquivo é este próprio script
 */
function isSelf(absolutePath) {
  return relative(absolutePath) === SELF_RELATIVE;
}

/* ------------------------------------------------------------------------- */
/* Remoção de comentários                                                     */
/* ------------------------------------------------------------------------- */

/**
 * Remove comentários de linha e de bloco preservando o conteúdo das strings e
 * o número de linhas. Literais de string permanecem intactos porque as
 * verificações precisam enxergar argumentos como '--force'.
 *
 * @param {string} source
 * @returns {string}
 */
function stripComments(source) {
  let output = '';
  let index = 0;
  const length = source.length;

  while (index < length) {
    const char = source[index];
    const next = index + 1 < length ? source[index + 1] : '';

    if (char === '/' && next === '/') {
      while (index < length && source[index] !== '\n') index += 1;
      continue;
    }

    if (char === '/' && next === '*') {
      index += 2;
      while (index < length) {
        if (source[index] === '*' && index + 1 < length && source[index + 1] === '/') {
          index += 2;
          break;
        }
        if (source[index] === '\n') output += '\n';
        index += 1;
      }
      continue;
    }

    if (char === "'" || char === '"' || char === '`') {
      const quote = char;
      output += char;
      index += 1;
      while (index < length) {
        const inner = source[index];
        output += inner;
        index += 1;
        if (inner === '\\') {
          if (index < length) {
            output += source[index];
            index += 1;
          }
          continue;
        }
        if (inner === quote) break;
      }
      continue;
    }

    output += char;
    index += 1;
  }

  return output;
}

/**
 * Devolve o número da linha (1-indexado) de uma posição no texto.
 * @param {string} text
 * @param {number} position
 * @returns {number}
 */
function lineNumberAt(text, position) {
  let line = 1;
  for (let i = 0; i < position && i < text.length; i += 1) {
    if (text[i] === '\n') line += 1;
  }
  return line;
}

/**
 * Procura todas as ocorrências de um padrão e devolve as violações formatadas.
 * @param {string} absolutePath
 * @param {string} haystack
 * @param {RegExp} pattern
 * @param {string} label
 * @returns {string[]}
 */
function collectMatches(absolutePath, haystack, pattern, label) {
  const violations = [];
  const scanner = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`);
  let match = scanner.exec(haystack);
  while (match !== null) {
    const line = lineNumberAt(haystack, match.index);
    violations.push(`${relative(absolutePath)}:${line} — ${label}: ${trim(match[0])}`);
    if (match.index === scanner.lastIndex) scanner.lastIndex += 1;
    match = scanner.exec(haystack);
  }
  return violations;
}

/**
 * @param {string} value
 * @returns {string}
 */
function trim(value) {
  const single = value.replace(/\s+/g, ' ').trim();
  return single.length > 80 ? `${single.slice(0, 77)}...` : single;
}

/* ------------------------------------------------------------------------- */
/* Verificações                                                               */
/* ------------------------------------------------------------------------- */

/**
 * (a) Nenhum arquivo pode chamar um endpoint de API de IA.
 * Os alvos são montados por concatenação para que este arquivo não seja, ele
 * próprio, um falso positivo em ferramentas externas.
 *
 * @param {string[]} files
 * @returns {string[]}
 */
function checkNoAiApiEndpoints(files) {
  const needles = ['api.' + 'anthropic.com', 'api.' + 'openai.com', 'api.' + 'x.ai'];
  const violations = [];

  for (const file of files) {
    if (isSelf(file)) continue;
    const content = readText(file);
    if (content.length === 0) continue;
    const lower = content.toLowerCase();
    for (const needle of needles) {
      let from = lower.indexOf(needle);
      while (from !== -1) {
        violations.push(
          `${relative(file)}:${lineNumberAt(content, from)} — chamada a endpoint de API de IA: ${needle}`,
        );
        from = lower.indexOf(needle, from + needle.length);
      }
    }
  }

  return violations;
}

/**
 * (b) Nenhum import de SDK de provedor de IA no código.
 * @param {string[]} files
 * @returns {string[]}
 */
function checkNoProviderSdkImports(files) {
  const modules = ['@anthropic' + '-ai/sdk', '@anthropic' + '-ai/bedrock-sdk', 'open' + 'ai'];
  const alternatives = modules.map((name) => name.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')).join('|');
  const pattern = new RegExp(
    `(?:from|import|require\\s*\\(|import\\s*\\()\\s*['"\`](?:${alternatives})['"\`]`,
  );
  const violations = [];

  for (const file of files) {
    if (isSelf(file)) continue;
    const extension = path.extname(file).toLowerCase();
    if (extension !== '.ts' && extension !== '.tsx' && extension !== '.js' && extension !== '.cjs' && extension !== '.mjs') {
      continue;
    }
    const content = readText(file);
    if (content.length === 0) continue;
    violations.push(...collectMatches(file, stripComments(content), pattern, 'import de SDK de IA'));
  }

  return violations;
}

/**
 * (c) O package.json não pode declarar dependências de runtime.
 * @returns {string[]}
 */
function checkNoRuntimeDependencies() {
  const manifestPath = path.join(REPO_ROOT, 'package.json');
  if (!fs.existsSync(manifestPath)) {
    return ['package.json — arquivo nao encontrado na raiz do repositorio'];
  }

  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    return [`package.json — JSON invalido: ${describeError(error)}`];
  }

  const violations = [];
  const dependencies = manifest && typeof manifest === 'object' ? manifest.dependencies : undefined;

  if (dependencies !== undefined) {
    if (dependencies === null || typeof dependencies !== 'object' || Array.isArray(dependencies)) {
      violations.push('package.json — "dependencies" deve ser um objeto vazio');
    } else {
      const names = Object.keys(dependencies);
      if (names.length > 0) {
        violations.push(
          `package.json — dependencias de runtime proibidas: ${names.join(', ')}`,
        );
      }
    }
  }

  const optional = manifest && typeof manifest === 'object' ? manifest.optionalDependencies : undefined;
  if (optional && typeof optional === 'object' && Object.keys(optional).length > 0) {
    violations.push(
      `package.json — optionalDependencies proibidas: ${Object.keys(optional).join(', ')}`,
    );
  }

  const bundled = manifest && typeof manifest === 'object' ? manifest.bundledDependencies : undefined;
  if (Array.isArray(bundled) && bundled.length > 0) {
    violations.push(`package.json — bundledDependencies proibidas: ${bundled.join(', ')}`);
  }

  return violations;
}

/**
 * (d) Nenhum uso de shell, exec síncrono ou comando Git destrutivo em src/.
 *
 * A análise ocorre sobre o código com comentários removidos. Os comandos Git
 * destrutivos são procurados na forma em que realmente apareceriam: tokens
 * citados dentro de um vetor de argumentos.
 *
 * @param {string[]} files
 * @returns {string[]}
 */
function checkNoDangerousProcessUsage(files) {
  const srcDir = path.join(REPO_ROOT, 'src');
  const rules = [
    { pattern: /shell\s*:\s*true/, label: 'uso de shell no spawn' },
    { pattern: /\bexecSync\s*\(/, label: 'uso de execSync' },
    { pattern: /\bexecFileSync\s*\(/, label: 'uso de execFileSync' },
    { pattern: /child_process['"`\s)\].]*\.\s*exec\s*\(/, label: 'uso de exec de child_process' },
    { pattern: /(['"`])--force(-with-lease)?\1/, label: 'argumento --force do git' },
    { pattern: /(['"`])push\1\s*,\s*(['"`])--force/, label: 'git push --force' },
    { pattern: /(['"`])reset\1\s*,\s*(['"`])--hard\2/, label: 'git reset --hard' },
    { pattern: /(['"`])clean\1\s*,\s*(['"`])-/, label: 'git clean' },
    { pattern: /(['"`])branch\1\s*,\s*(['"`])-D\2/, label: 'git branch -D' },
  ];

  const violations = [];

  for (const file of files) {
    if (isSelf(file)) continue;
    if (!file.startsWith(srcDir + path.sep)) continue;
    const extension = path.extname(file).toLowerCase();
    if (extension !== '.ts' && extension !== '.tsx') continue;

    const code = stripComments(readText(file));
    for (const rule of rules) {
      violations.push(...collectMatches(file, code, rule.pattern, rule.label));
    }
  }

  return violations;
}

/** Palavras que denunciam um valor de exemplo, nunca um segredo real. */
const PLACEHOLDER_WORDS = [
  'teste',
  'test',
  'exemplo',
  'example',
  'placeholder',
  'fake',
  'dummy',
  'sample',
  'secreto',
  'vazar',
  'vazamento',
  'xxxx',
  'aaaa',
  'seu-token',
  'your-token',
];

/**
 * Entropia de Shannon do texto, em bits por caractere.
 * @param {string} value
 * @returns {number}
 */
function shannonEntropy(value) {
  if (value.length === 0) return 0;
  const counts = new Map();
  for (const char of value) counts.set(char, (counts.get(char) ?? 0) + 1);
  let entropy = 0;
  for (const count of counts.values()) {
    const probability = count / value.length;
    entropy -= probability * Math.log2(probability);
  }
  return entropy;
}

/**
 * Distingue um segredo plausivelmente real de um valor de exemplo usado em
 * teste ou documentação. Um segredo real é aleatório: tem alta entropia e muitos
 * caracteres distintos.
 *
 * @param {string} token trecho que segue o prefixo conhecido
 * @returns {boolean}
 */
function looksLikeRealSecret(token) {
  const lower = token.toLowerCase();
  for (const word of PLACEHOLDER_WORDS) {
    if (lower.includes(word)) return false;
  }
  const distinct = new Set(token).size;
  if (distinct < 10) return false;
  return shannonEntropy(token) >= 3;
}

/**
 * (e) Nenhum segredo aparente commitado.
 *
 * Os padrões exigem um sufixo longo, de modo que citar o prefixo em documentação
 * não caracteriza violação. Valores de exemplo usados nos testes também são
 * descartados por baixa entropia — apenas material com aparência de credencial
 * real reprova a verificação.
 *
 * @param {string[]} files
 * @returns {string[]}
 */
function checkNoCommittedSecrets(files) {
  const rules = [
    { prefix: 'sk' + '-ant-', body: '[A-Za-z0-9_\\-]{24,}', label: 'chave Anthropic' },
    { prefix: 'sk' + '-proj-', body: '[A-Za-z0-9_\\-]{24,}', label: 'chave de projeto OpenAI' },
    { prefix: 'ghp' + '_', body: '[A-Za-z0-9]{30,}', label: 'token pessoal do GitHub' },
    { prefix: 'github' + '_pat_', body: '[A-Za-z0-9_]{30,}', label: 'token fine-grained do GitHub' },
    { prefix: 'gho' + '_', body: '[A-Za-z0-9]{30,}', label: 'token OAuth do GitHub' },
  ];

  const violations = [];

  for (const file of files) {
    if (isSelf(file)) continue;
    const content = readText(file);
    if (content.length === 0) continue;

    for (const rule of rules) {
      const scanner = new RegExp(`${rule.prefix}(${rule.body})`, 'g');
      let match = scanner.exec(content);
      while (match !== null) {
        const token = match[1] ?? '';
        if (looksLikeRealSecret(token)) {
          // O valor encontrado nunca é impresso: apenas arquivo, linha e tipo.
          violations.push(
            `${relative(file)}:${lineNumberAt(content, match.index)} — segredo aparente (${rule.label})`,
          );
        }
        if (match.index === scanner.lastIndex) scanner.lastIndex += 1;
        match = scanner.exec(content);
      }
    }
  }

  return violations;
}

/**
 * (f) O servidor do painel só pode escutar em loopback.
 * @param {string[]} files
 * @returns {string[]}
 */
function checkPanelBindsLoopbackOnly(files) {
  const srcDir = path.join(REPO_ROOT, 'src');
  const publicAddress = /(['"`])0\.0\.0\.0\1/;
  const violations = [];

  for (const file of files) {
    if (isSelf(file)) continue;
    if (!file.startsWith(srcDir + path.sep)) continue;
    const extension = path.extname(file).toLowerCase();
    if (extension !== '.ts' && extension !== '.tsx') continue;

    const code = stripComments(readText(file));
    violations.push(
      ...collectMatches(file, code, publicAddress, 'escuta em endereco publico'),
    );
  }

  const serverFile = path.join(REPO_ROOT, 'src', 'server', 'http-server.ts');
  if (fs.existsSync(serverFile)) {
    const code = stripComments(readText(serverFile));
    if (!/\.listen\s*\([^)]*(['"`])127\.0\.0\.1\1/.test(code)) {
      violations.push(
        `${relative(serverFile)} — o servidor precisa chamar listen() fixando o host 127.0.0.1`,
      );
    }
  }

  return violations;
}

/* ------------------------------------------------------------------------- */
/* Execução                                                                   */
/* ------------------------------------------------------------------------- */

function main() {
  process.stdout.write('\nOrqPEG — verificacoes de seguranca do repositorio\n');
  process.stdout.write(`Raiz: ${REPO_ROOT}\n\n`);

  const files = listTextFiles(REPO_ROOT);
  process.stdout.write(`Arquivos de texto inspecionados: ${files.length}\n\n`);

  const checks = [
    { id: 'a', title: 'Sem chamadas a endpoints de API de IA', run: () => checkNoAiApiEndpoints(files) },
    { id: 'b', title: 'Sem imports de SDK de provedor de IA', run: () => checkNoProviderSdkImports(files) },
    { id: 'c', title: 'Sem dependencias de runtime no package.json', run: () => checkNoRuntimeDependencies() },
    { id: 'd', title: 'Sem shell, exec sincrono ou git destrutivo em src/', run: () => checkNoDangerousProcessUsage(files) },
    { id: 'e', title: 'Sem segredos aparentes commitados', run: () => checkNoCommittedSecrets(files) },
    { id: 'f', title: 'Painel escuta apenas em loopback', run: () => checkPanelBindsLoopbackOnly(files) },
  ];

  let failures = 0;

  for (const check of checks) {
    const violations = check.run();
    if (violations.length === 0) {
      process.stdout.write(`  [OK]    (${check.id}) ${check.title}\n`);
      continue;
    }
    failures += 1;
    process.stdout.write(`  [FALHA] (${check.id}) ${check.title}\n`);
    for (const violation of violations) {
      process.stdout.write(`            ${violation}\n`);
    }
  }

  process.stdout.write('\n');

  if (failures > 0) {
    process.stdout.write(
      `${failures} verificacao(oes) de seguranca falharam. Corrija os pontos acima antes de prosseguir.\n\n`,
    );
    process.exitCode = 1;
    return;
  }

  process.stdout.write('Todas as 6 verificacoes de seguranca passaram.\n\n');
  process.exitCode = 0;
}

main();
