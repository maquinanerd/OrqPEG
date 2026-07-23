import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import type {
  DiagnosticItem,
  DiagnosticReport,
  DiagnosticStatus,
  GlobalConfig,
  ToolAvailability,
} from '../types';
import { detectAllTools } from '../agents/agent-detect';
import { inspectApiEnvironment } from '../security/api-guard';
import { loadGlobalConfig, validateGlobalConfig } from '../config/global-config';
import { listProjects } from '../projects/project-store';
import { countPrompts } from '../prompts/prompt-store';
import { listLocks } from '../state/locks';
import { ORQPEG_DIRS, orqpegRoot } from '../utils/paths';
import { directoryExists, fileExists, readJsonSync, readTextSync } from '../utils/fs-atomic';
import type { JsonSchema } from '../config/schema-validator';
import { nowIso } from '../utils/time';

/**
 * Diagnóstico completo do ambiente. Classifica cada verificação em OK, AVISO ou
 * ERRO e nunca expõe o valor de credenciais.
 */

const REQUIRED_SCHEMAS = [
  'project.schema.json',
  'state.schema.json',
  'prompt-review.schema.json',
  'claude-merge-review.schema.json',
  'codex-merge-review.schema.json',
  'merge-consensus.schema.json',
];

const REQUIRED_WRAPPERS = [
  'ORQPEG.cmd',
  'INSTALAR-E-CONFIGURAR.cmd',
  'ABRIR-PAINEL.cmd',
  'INICIAR-PAINEL.cmd',
  'PARAR-PAINEL.cmd',
  'CADASTRAR-PROJETO.cmd',
  'EDITAR-PROJETO.cmd',
  'REMOVER-PROJETO.cmd',
  'LISTAR-PROJETOS.cmd',
  'EXECUTAR-DRY-RUN.cmd',
  'EXECUTAR.cmd',
  'PAUSAR.cmd',
  'RETOMAR.cmd',
  'STATUS.cmd',
  'DIAGNOSTICO.cmd',
  'CANCELAR-ETAPA.cmd',
];

export async function runDiagnostics(): Promise<DiagnosticReport> {
  const items: DiagnosticItem[] = [];

  const configResult = loadGlobalConfig();
  const config: GlobalConfig | null = configResult.ok ? configResult.value : null;

  items.push(...checkPlatform());
  items.push(...checkInstallation());

  if (!config) {
    items.push({
      id: 'config.load',
      category: 'Configuração',
      title: 'Configuração global',
      status: 'ERRO',
      detail: `Não foi possível carregar config/global.json: ${configResult.ok ? '' : configResult.error.message}`,
      remediation: 'Execute INSTALAR-E-CONFIGURAR.cmd para recriar a configuração padrão.',
    });
  } else {
    items.push(...checkConfig(config));
    items.push(...(await checkTools(config)));
    items.push(...(await checkPanelPort(config)));
  }

  items.push(...checkApiEnvironment(config));
  items.push(...checkSchemas());
  items.push(...checkWrappers());
  items.push(...checkProjects());
  items.push(...checkLocks());
  items.push(...checkDisk());

  const counts = {
    ok: items.filter((i) => i.status === 'OK').length,
    aviso: items.filter((i) => i.status === 'AVISO').length,
    erro: items.filter((i) => i.status === 'ERRO').length,
  };

  const overall: DiagnosticStatus = counts.erro > 0 ? 'ERRO' : counts.aviso > 0 ? 'AVISO' : 'OK';

  return {
    generatedAt: nowIso(),
    orqpegVersion: readVersion(),
    overall,
    counts,
    items,
  };
}

/* ------------------------------------------------------------------------- */

function checkPlatform(): DiagnosticItem[] {
  const items: DiagnosticItem[] = [];

  items.push({
    id: 'os.platform',
    category: 'Sistema',
    title: 'Sistema operacional',
    status: process.platform === 'win32' ? 'OK' : 'AVISO',
    detail: `${os.type()} ${os.release()} (${process.platform}, ${process.arch})`,
    ...(process.platform === 'win32'
      ? {}
      : {
          remediation:
            'O OrqPEG é otimizado para Windows 10/11. Em outros sistemas alguns wrappers .cmd não se aplicam.',
        }),
  });

  const major = Number.parseInt(process.versions.node.split('.')[0] ?? '0', 10);
  items.push({
    id: 'node.version',
    category: 'Sistema',
    title: 'Node.js',
    status: major >= 20 ? 'OK' : 'ERRO',
    detail: `Node ${process.version}`,
    ...(major >= 20 ? {} : { remediation: 'Instale o Node.js LTS 20 ou superior.' }),
  });

  return items;
}

function checkInstallation(): DiagnosticItem[] {
  const root = orqpegRoot();
  const items: DiagnosticItem[] = [];

  items.push({
    id: 'install.root',
    category: 'Instalação',
    title: 'Pasta de instalação',
    status: directoryExists(root) ? 'OK' : 'ERRO',
    detail: root,
    ...(directoryExists(root) ? {} : { remediation: 'Reinstale o OrqPEG em C:\\OrqPEG.' }),
  });

  const distMain = path.join(root, 'dist', 'cli', 'main.js');
  items.push({
    id: 'install.build',
    category: 'Instalação',
    title: 'Build TypeScript',
    status: fileExists(distMain) ? 'OK' : 'ERRO',
    detail: fileExists(distMain) ? `Compilado em ${distMain}` : 'dist/cli/main.js não encontrado.',
    ...(fileExists(distMain) ? {} : { remediation: 'Execute INSTALAR-E-CONFIGURAR.cmd ou "npm run build".' }),
  });

  for (const dir of [
    ORQPEG_DIRS.data(),
    ORQPEG_DIRS.projects(),
    ORQPEG_DIRS.state(),
    ORQPEG_DIRS.locks(),
    ORQPEG_DIRS.logs(),
  ]) {
    if (!directoryExists(dir)) {
      items.push({
        id: `install.dir.${path.basename(dir)}`,
        category: 'Instalação',
        title: `Diretório ${path.basename(dir)}`,
        status: 'AVISO',
        detail: `Ausente: ${dir}`,
        remediation: 'Será criado automaticamente na primeira execução.',
      });
    }
  }

  const publicIndex = path.join(ORQPEG_DIRS.publicDir(), 'index.html');
  items.push({
    id: 'install.panel',
    category: 'Instalação',
    title: 'Arquivos do painel',
    status: fileExists(publicIndex) ? 'OK' : 'ERRO',
    detail: fileExists(publicIndex) ? 'public/index.html presente.' : 'public/index.html ausente.',
    ...(fileExists(publicIndex) ? {} : { remediation: 'Reinstale o OrqPEG: os arquivos do painel estão faltando.' }),
  });

  return items;
}

function checkConfig(config: GlobalConfig): DiagnosticItem[] {
  const validated = validateGlobalConfig(config);
  return [
    {
      id: 'config.valid',
      category: 'Configuração',
      title: 'Configuração global',
      status: validated.ok ? 'OK' : 'ERRO',
      detail: validated.ok
        ? `Painel em ${config.panel.host}:${config.panel.port}; comandos "${config.agents.claudeCommand}" e "${config.agents.codexCommand}".`
        : validated.error.message,
      ...(validated.ok ? {} : { remediation: 'Corrija config/global.json ou apague-o para regerar o padrão.' }),
    },
    {
      id: 'config.panel.host',
      category: 'Segurança',
      title: 'Escuta do painel',
      status: config.panel.host === '127.0.0.1' || config.panel.host === 'localhost' ? 'OK' : 'ERRO',
      detail: `O painel escuta em ${config.panel.host}. Escuta em 0.0.0.0 é proibida.`,
      ...(config.panel.host === '127.0.0.1' || config.panel.host === 'localhost'
        ? {}
        : { remediation: 'Defina panel.host como 127.0.0.1 em config/global.json.' }),
    },
  ];
}

async function checkTools(config: GlobalConfig): Promise<DiagnosticItem[]> {
  const tools = await detectAllTools(config);
  return tools.map((tool) => toolToItem(tool));
}

function toolToItem(tool: ToolAvailability): DiagnosticItem {
  const critical = tool.name === 'Node.js' || tool.name === 'Git';
  let status: DiagnosticStatus;
  if (tool.available) {
    status = tool.authenticated === false ? 'AVISO' : 'OK';
  } else {
    status = critical ? 'ERRO' : 'AVISO';
  }

  const item: DiagnosticItem = {
    id: `tool.${tool.command}`,
    category: 'Ferramentas',
    title: tool.name,
    status,
    detail: tool.detail,
  };

  if (!tool.available) {
    return {
      ...item,
      remediation: remediationForTool(tool.command),
    };
  }
  if (tool.authenticated === false) {
    return {
      ...item,
      remediation:
        tool.command === 'gh'
          ? 'Execute "gh auth login" para autenticar o GitHub CLI.'
          : 'Autentique a ferramenta antes de executar o OrqPEG.',
    };
  }
  return item;
}

function remediationForTool(command: string): string {
  switch (command) {
    case 'claude':
      return 'Instale o Claude Code (npm i -g @anthropic-ai/claude-code) e autentique com a assinatura Claude Max.';
    case 'codex':
      return 'Instale o Codex CLI e autentique com "Sign in with ChatGPT". Sem ele, o merge por consenso permanece BLOQUEADO.';
    case 'gh':
      return 'Instale o GitHub CLI (https://cli.github.com) e execute "gh auth login".';
    case 'git':
      return 'Instale o Git for Windows (https://git-scm.com/download/win).';
    default:
      return 'Instale a ferramenta e garanta que esteja no PATH.';
  }
}

async function checkPanelPort(config: GlobalConfig): Promise<DiagnosticItem[]> {
  const free = await isPortFree(config.panel.host, config.panel.port);
  return [
    {
      id: 'panel.port',
      category: 'Painel',
      title: `Porta ${config.panel.port}`,
      status: free ? 'OK' : 'AVISO',
      detail: free
        ? `Porta ${config.panel.port} disponível em ${config.panel.host}.`
        : `Porta ${config.panel.port} já está em uso — provavelmente o painel já está rodando.`,
      ...(free
        ? {}
        : {
            remediation:
              'Use PARAR-PAINEL.cmd para encerrar a instância atual, ou altere panel.port em config/global.json.',
          }),
    },
  ];
}

function isPortFree(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => {
      server.close(() => resolve(true));
    });
    server.listen(port, host);
  });
}

function checkApiEnvironment(config: GlobalConfig | null): DiagnosticItem[] {
  const guard = inspectApiEnvironment(config ? { config } : {});
  const items: DiagnosticItem[] = [];

  items.push({
    id: 'security.apikeys',
    category: 'Segurança',
    title: 'Variáveis de API de IA',
    status: guard.presentKeys.length === 0 ? 'OK' : 'AVISO',
    detail:
      guard.presentKeys.length === 0
        ? 'Nenhuma variável de API detectada. O OrqPEG usa apenas os CLIs locais claude e codex.'
        : `Detectadas (valores nunca são lidos): ${guard.presentKeys.join(', ')}. Serão removidas do ambiente de todo processo filho.`,
    ...(guard.presentKeys.length === 0
      ? {}
      : {
          remediation:
            'A execução de IA é bloqueada por padrão. Rode com ambiente sanitizado ou remova as variáveis da sua sessão.',
        }),
  });

  if (guard.warnKeys.length > 0) {
    items.push({
      id: 'security.routing',
      category: 'Segurança',
      title: 'Variáveis de roteamento',
      status: 'AVISO',
      detail: `Ativas: ${guard.warnKeys.join(', ')}. Podem redirecionar o CLI para um gateway.`,
      remediation: 'Confirme que o roteamento é intencional e coberto pela sua assinatura.',
    });
  }

  return items;
}

function checkSchemas(): DiagnosticItem[] {
  const items: DiagnosticItem[] = [];
  const dir = ORQPEG_DIRS.schemas();

  for (const name of REQUIRED_SCHEMAS) {
    const full = path.join(dir, name);
    if (!fileExists(full)) {
      items.push({
        id: `schema.${name}`,
        category: 'Schemas',
        title: name,
        status: 'ERRO',
        detail: `Schema ausente: ${full}`,
        remediation: 'Reinstale o OrqPEG: os schemas de validação estão faltando.',
      });
      continue;
    }
    const parsed = readJsonSync<JsonSchema>(full);
    if (!parsed.ok) {
      items.push({
        id: `schema.${name}`,
        category: 'Schemas',
        title: name,
        status: 'ERRO',
        detail: `JSON inválido: ${parsed.error.message}`,
        remediation: 'Restaure o arquivo a partir do repositório.',
      });
      continue;
    }
    // Auto-verificação: o schema precisa ser um objeto com "type" ou "properties".
    const schema = parsed.value;
    const usable =
      typeof schema === 'object' &&
      schema !== null &&
      (schema.type !== undefined || schema.properties !== undefined);
    items.push({
      id: `schema.${name}`,
      category: 'Schemas',
      title: name,
      status: usable ? 'OK' : 'ERRO',
      detail: usable ? 'Schema carregado e utilizável.' : 'Schema sem "type" nem "properties".',
      ...(usable ? {} : { remediation: 'Restaure o arquivo a partir do repositório.' }),
    });
  }

  return items;
}

function checkWrappers(): DiagnosticItem[] {
  const root = orqpegRoot();
  const missing = REQUIRED_WRAPPERS.filter((name) => !fileExists(path.join(root, name)));
  return [
    {
      id: 'wrappers',
      category: 'Instalação',
      title: 'Wrappers .cmd',
      status: missing.length === 0 ? 'OK' : 'ERRO',
      detail:
        missing.length === 0
          ? `Todos os ${REQUIRED_WRAPPERS.length} wrappers estão presentes.`
          : `Ausentes: ${missing.join(', ')}`,
      ...(missing.length === 0
        ? {}
        : { remediation: 'Reinstale o OrqPEG: os atalhos de duplo clique estão faltando.' }),
    },
  ];
}

function checkProjects(): DiagnosticItem[] {
  const result = listProjects();
  if (!result.ok) {
    return [
      {
        id: 'projects',
        category: 'Projetos',
        title: 'Cadastro de projetos',
        status: 'ERRO',
        detail: result.error.message,
        remediation: 'Verifique data/projects e o conteúdo dos arquivos project.json.',
      },
    ];
  }

  const projects = result.value;
  const items: DiagnosticItem[] = [
    {
      id: 'projects.count',
      category: 'Projetos',
      title: 'Projetos cadastrados',
      status: projects.length === 0 ? 'AVISO' : 'OK',
      detail: `${projects.length} projeto(s) cadastrado(s).`,
      ...(projects.length === 0
        ? { remediation: 'Use CADASTRAR-PROJETO.cmd para registrar o primeiro projeto.' }
        : {}),
    },
  ];

  for (const project of projects) {
    const exists = directoryExists(project.repositoryPath);
    const isRepo = exists && directoryExists(path.join(project.repositoryPath, '.git'));
    const prompts = countPrompts(project.id);

    items.push({
      id: `project.${project.id}`,
      category: 'Projetos',
      title: project.name,
      status: !exists ? 'ERRO' : !isRepo ? 'ERRO' : prompts === 0 ? 'AVISO' : 'OK',
      detail: !exists
        ? `Pasta não encontrada: ${project.repositoryPath}`
        : !isRepo
          ? `Não é um repositório Git: ${project.repositoryPath}`
          : `${prompts} prompt(s) · ${project.githubRepository} · base ${project.baseBranch}`,
      ...(!exists
        ? { remediation: 'Atualize repositoryPath com EDITAR-PROJETO.cmd.' }
        : !isRepo
          ? { remediation: 'Inicialize o repositório Git ou corrija o caminho.' }
          : prompts === 0
            ? { remediation: `Adicione arquivos .md em data/projects/${project.id}/prompts.` }
            : {}),
    });
  }

  return items;
}

function checkLocks(): DiagnosticItem[] {
  const locks = listLocks();
  if (locks.length === 0) {
    return [
      {
        id: 'locks',
        category: 'Execução',
        title: 'Locks',
        status: 'OK',
        detail: 'Nenhum lock ativo.',
      },
    ];
  }
  return [
    {
      id: 'locks',
      category: 'Execução',
      title: 'Locks',
      status: 'AVISO',
      detail: locks
        .map(
          (lock) =>
            `${lock.scope}/${lock.key} — pid ${lock.pid}@${lock.hostname}, ${lock.operation}, desde ${lock.acquiredAt}`,
        )
        .join(' | '),
      remediation:
        'Se nenhuma execução estiver em curso, o lock será liberado automaticamente por expiração; use STATUS.cmd para confirmar.',
    },
  ];
}

function checkDisk(): DiagnosticItem[] {
  try {
    const stats = fs.statfsSync(orqpegRoot());
    const freeBytes = stats.bavail * stats.bsize;
    const freeGb = freeBytes / 1024 ** 3;
    return [
      {
        id: 'disk.free',
        category: 'Sistema',
        title: 'Espaço em disco',
        status: freeGb < 1 ? 'ERRO' : freeGb < 5 ? 'AVISO' : 'OK',
        detail: `${freeGb.toFixed(1).replace('.', ',')} GB livres em ${orqpegRoot()}`,
        ...(freeGb < 5
          ? { remediation: 'Libere espaço: worktrees, logs e artefatos consomem disco.' }
          : {}),
      },
    ];
  } catch {
    return [
      {
        id: 'disk.free',
        category: 'Sistema',
        title: 'Espaço em disco',
        status: 'AVISO',
        detail: 'Não foi possível medir o espaço livre nesta plataforma.',
      },
    ];
  }
}

function readVersion(): string {
  const versionFile = readTextSync(path.join(orqpegRoot(), 'VERSION'));
  if (versionFile.ok) return versionFile.value.trim();
  const pkg = readJsonSync<{ version?: string }>(path.join(orqpegRoot(), 'package.json'));
  return pkg.ok && pkg.value.version ? pkg.value.version : '0.0.0';
}

/* ------------------------------------------------------------------------- */

export function renderDiagnosticReport(report: DiagnosticReport): string {
  const lines: string[] = [];
  const rule = '─'.repeat(72);

  lines.push(rule);
  lines.push(`  DIAGNÓSTICO DO ORQPEG ${report.orqpegVersion}`);
  lines.push(`  ${report.generatedAt}`);
  lines.push(rule);
  lines.push('');

  const byCategory = new Map<string, DiagnosticItem[]>();
  for (const item of report.items) {
    const list = byCategory.get(item.category) ?? [];
    list.push(item);
    byCategory.set(item.category, list);
  }

  for (const [category, items] of byCategory) {
    lines.push(`  ${category.toUpperCase()}`);
    for (const item of items) {
      lines.push(`    [${item.status.padEnd(5, ' ')}] ${item.title}`);
      lines.push(`             ${item.detail}`);
      if (item.remediation) lines.push(`             → ${item.remediation}`);
    }
    lines.push('');
  }

  lines.push(rule);
  lines.push(
    `  RESULTADO: ${report.overall}  ·  ${report.counts.ok} OK, ${report.counts.aviso} AVISO, ${report.counts.erro} ERRO`,
  );
  lines.push(rule);

  return lines.join('\n');
}
