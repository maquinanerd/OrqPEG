import type { GlobalConfig, ProcessResult, ToolAvailability } from '../types';
import { buildToolEnv } from '../security/env-sanitizer';
import { redactText } from '../utils/redact';
import { runProcess } from './process-runner';

/**
 * Detecção das ferramentas locais das quais o OrqPEG depende.
 *
 * O produto não fala com nenhuma API de IA: toda a inteligência vem dos
 * executáveis `claude` e `codex` já autenticados na máquina do usuário. Este
 * módulo apenas verifica presença, versão e — quando existe um comando
 * confiável e não interativo — o estado de autenticação.
 *
 * Nenhum token é lido, exibido ou gravado: toda saída passa por `redactText`.
 */

/** Timeout das sondagens de versão. Ferramentas locais respondem em segundos. */
const PROBE_TIMEOUT_MS = 25_000;

/** Timeout da checagem de autenticação do gh, que faz uma chamada de rede. */
const AUTH_PROBE_TIMEOUT_MS = 40_000;

const PROBE_MAX_OUTPUT_BYTES = 256 * 1024;

export async function detectClaude(config: GlobalConfig): Promise<ToolAvailability> {
  const command = config.agents.claudeCommand;
  const probe = await probeVersion(command);

  if (!probe.available) {
    return {
      name: 'Claude Code',
      command,
      available: false,
      version: null,
      path: null,
      authenticated: false,
      detail:
        `O executável "${command}" não foi encontrado no PATH. ` +
        'Instale o Claude Code e faça login com a assinatura Claude Max ' +
        '(comando "claude" e, dentro dele, "/login"). Sem ele o OrqPEG não executa prompts.',
    };
  }

  return {
    name: 'Claude Code',
    command,
    available: true,
    version: probe.version,
    path: await resolveCommandPath(command),
    // Não existe comando não interativo confiável para consultar o estado de
    // login do Claude Code: a autenticação é da assinatura Claude Max e vive
    // no perfil do usuário. Reportar "true" seria inventar informação.
    authenticated: null,
    detail:
      `Detectado${probe.version ? ` versão ${probe.version}` : ''}. ` +
      'A autenticação é a da assinatura Claude Max, feita uma única vez com "/login" ' +
      'dentro do próprio CLI; o OrqPEG não consegue verificá-la sem interação e ' +
      'nunca usa chaves de API.',
  };
}

export async function detectCodex(config: GlobalConfig): Promise<ToolAvailability> {
  const command = config.agents.codexCommand;
  const probe = await probeVersion(command);

  if (!probe.available) {
    return {
      name: 'Codex CLI',
      command,
      available: false,
      version: null,
      path: null,
      authenticated: false,
      detail:
        `O Codex CLI ("${command}") não foi encontrado no PATH desta máquina. ` +
        'A revisão de prompt e a auditoria dupla de merge ficam BLOQUEADAS até que ele ' +
        'seja instalado e autenticado. Remediação: instale o Codex CLI, rode "codex login" ' +
        'e escolha "Sign in with ChatGPT" (assinatura ChatGPT Plus). ' +
        'O OrqPEG nunca usa chave de API e nunca aprova um merge sem o segundo auditor.',
    };
  }

  return {
    name: 'Codex CLI',
    command,
    available: true,
    version: probe.version,
    path: await resolveCommandPath(command),
    // Assim como o Claude, o Codex guarda a sessão no perfil do usuário e não
    // oferece consulta de status não interativa confiável.
    authenticated: null,
    detail:
      `Detectado${probe.version ? ` versão ${probe.version}` : ''}. ` +
      'A autenticação vem de "codex login" com "Sign in with ChatGPT"; ' +
      'se a sessão estiver expirada, a primeira execução falhará com pedido de login.',
  };
}

export async function detectGit(): Promise<ToolAvailability> {
  const command = 'git';
  const probe = await probeVersion(command);

  if (!probe.available) {
    return {
      name: 'Git',
      command,
      available: false,
      version: null,
      path: null,
      authenticated: null,
      detail:
        'O Git não foi encontrado no PATH. Instale o Git for Windows: sem ele o OrqPEG ' +
        'não cria branches, worktrees nem commits.',
    };
  }

  return {
    name: 'Git',
    command,
    available: true,
    version: probe.version,
    path: await resolveCommandPath(command),
    authenticated: null,
    detail: `Detectado${probe.version ? ` versão ${probe.version}` : ''}.`,
  };
}

export async function detectGh(): Promise<ToolAvailability> {
  const command = 'gh';
  const probe = await probeVersion(command);

  if (!probe.available) {
    return {
      name: 'GitHub CLI',
      command,
      available: false,
      version: null,
      path: null,
      authenticated: false,
      detail:
        'O GitHub CLI ("gh") não foi encontrado no PATH. Pull request, checagens de CI ' +
        'e merge ficam indisponíveis. Instale o gh e rode "gh auth login".',
    };
  }

  const auth = await runProcess(command, ['auth', 'status'], {
    cwd: process.cwd(),
    timeoutMs: AUTH_PROBE_TIMEOUT_MS,
    env: buildToolEnv(),
    maxOutputBytes: PROBE_MAX_OUTPUT_BYTES,
  });

  const authenticated = auth.status === 'COMPLETED' && auth.exitCode === 0;
  // A saída de "gh auth status" pode citar escopos e host; nunca pedimos o token
  // (--show-token) e ainda assim aplicamos a redação antes de exibir.
  const authSummary = summarizeAuthOutput(auth);

  return {
    name: 'GitHub CLI',
    command,
    available: true,
    version: probe.version,
    path: await resolveCommandPath(command),
    authenticated,
    detail: authenticated
      ? `Detectado${probe.version ? ` versão ${probe.version}` : ''} e autenticado. ${authSummary}`.trim()
      : `Detectado${probe.version ? ` versão ${probe.version}` : ''}, mas sem autenticação válida. ` +
        `Rode "gh auth login". ${authSummary}`.trim(),
  };
}

export async function detectNode(): Promise<ToolAvailability> {
  const command = 'node';
  const probe = await probeVersion(command);

  if (!probe.available) {
    return {
      name: 'Node.js',
      command,
      available: false,
      version: null,
      path: null,
      authenticated: null,
      detail:
        'O executável "node" não foi encontrado no PATH. O OrqPEG requer Node.js 20 ou superior.',
    };
  }

  const major = majorVersion(probe.version);
  const supported = major !== null && major >= 20;

  return {
    name: 'Node.js',
    command,
    available: true,
    version: probe.version,
    path: await resolveCommandPath(command),
    authenticated: null,
    detail: supported
      ? `Detectado versão ${probe.version ?? 'desconhecida'}.`
      : `Versão detectada (${probe.version ?? 'desconhecida'}) pode ser incompatível: ` +
        'o OrqPEG requer Node.js 20 ou superior.',
  };
}

/** Detecta todas as ferramentas em paralelo. */
export async function detectAllTools(config: GlobalConfig): Promise<ToolAvailability[]> {
  return Promise.all([
    detectNode(),
    detectGit(),
    detectGh(),
    detectClaude(config),
    detectCodex(config),
  ]);
}

/* ------------------------------------------------------------------------- */
/* Sondagem                                                                   */
/* ------------------------------------------------------------------------- */

interface VersionProbe {
  available: boolean;
  version: string | null;
}

async function probeVersion(command: string): Promise<VersionProbe> {
  const result = await runProcess(command, ['--version'], {
    cwd: process.cwd(),
    timeoutMs: PROBE_TIMEOUT_MS,
    env: buildToolEnv(),
    maxOutputBytes: PROBE_MAX_OUTPUT_BYTES,
  });

  if (result.status === 'COMMAND_NOT_FOUND') {
    return { available: false, version: null };
  }

  return { available: true, version: extractVersion(`${result.stdout}\n${result.stderr}`) };
}

/** Primeiro número de versão semântica encontrado na saída. */
function extractVersion(output: string): string | null {
  const match = /(\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.]+)?)/.exec(output);
  const captured = match?.[1];
  return captured === undefined ? null : captured;
}

function majorVersion(version: string | null): number | null {
  if (version === null) return null;
  const head = version.split('.')[0];
  if (head === undefined) return null;
  const parsed = Number.parseInt(head, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Resolve o caminho absoluto do executável usando o localizador do sistema
 * (`where` no Windows, `which` no restante). Falha silenciosa devolve `null`:
 * o caminho é informativo e nunca condiciona a execução.
 */
async function resolveCommandPath(command: string): Promise<string | null> {
  const locator = process.platform === 'win32' ? 'where.exe' : 'which';
  const result = await runProcess(locator, [command], {
    cwd: process.cwd(),
    timeoutMs: PROBE_TIMEOUT_MS,
    env: buildToolEnv(),
    maxOutputBytes: 64 * 1024,
  });

  if (result.status !== 'COMPLETED') return null;

  for (const rawLine of result.stdout.split('\n')) {
    const line = rawLine.trim();
    if (line.length > 0) return line;
  }
  return null;
}

/** Resume a saída de `gh auth status` em uma linha, já redigida. */
function summarizeAuthOutput(result: ProcessResult): string {
  const combined = `${result.stdout}\n${result.stderr}`;
  const lines = redactText(combined)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const first = lines[0];
  if (first === undefined) return '';
  const second = lines[1];
  const summary = second === undefined ? first : `${first} ${second}`;
  return summary.length > 240 ? `${summary.slice(0, 240)}…` : summary;
}
