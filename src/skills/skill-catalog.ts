import * as path from 'node:path';
import type { LoadedSkill, Result, RoundSkillDeclaration, SkillManifest, SkillSnapshot } from '../types';
import { fail, ok } from '../utils/errors';
import { directoryExists, fileExists, listDirectoriesSync, readJsonSync, readTextSync } from '../utils/fs-atomic';
import { orqpegRoot } from '../utils/paths';
import { contentHash } from '../execution/fingerprints';
import { nowIso } from '../utils/time';

/**
 * Catálogo LOCAL e declarativo de Skills.
 *
 * O que uma Skill é nesta versão: um documento que entra no prompt do agente.
 * Nada além disso.
 *
 * O que uma Skill NÃO é, deliberadamente:
 *  - não é instalável: não há download, marketplace nem descoberta automática;
 *  - não executa script: `executeScripts: true` é recusado na leitura, porque
 *    seria um vetor para rodar código arbitrário sob a assinatura do usuário;
 *  - não amplia escopo, não substitui política e não reduz teste: ela informa
 *    o agente, e quem decide continua sendo o Loop Guard e os gates.
 *
 * Ativação é sempre EXPLÍCITA: a rodada declara `<id>@<versão>`. Skill ausente,
 * versão divergente ou conteúdo alterado durante a execução bloqueiam — uma
 * rodada validada sob um conjunto de regras não pode rodar sob outro.
 */

const CATALOG_DIR = 'skills';
const MANIFEST_FILE = 'skill.json';

export function skillsRoot(): string {
  return path.join(orqpegRoot(), CATALOG_DIR);
}

/** Referência `<id>@<versão>` decomposta. */
export interface SkillRef {
  id: string;
  version: string;
}

export function parseSkillRef(raw: string): Result<SkillRef> {
  const match = /^([a-z0-9][a-z0-9-]*)@(\d+\.\d+\.\d+)$/i.exec(raw.trim());
  if (!match || !match[1] || !match[2]) {
    return fail(
      'VALIDATION_FAILED',
      `Referência de Skill inválida: "${raw}". O formato é <id>@<versao>, por exemplo typescript-strict@1.0.0.`,
      { raw },
    );
  }
  return ok({ id: match[1], version: match[2] });
}

/**
 * Lê o catálogo inteiro. Skills inválidas são REPORTADAS, não ignoradas.
 *
 * Ignorar em silêncio faria uma rodada falhar depois com "Skill ausente",
 * quando o problema real é um manifesto malformado — e a pessoa procuraria no
 * lugar errado.
 */
export function loadSkillCatalog(): { skills: LoadedSkill[]; problems: string[] } {
  const root = skillsRoot();
  const skills: LoadedSkill[] = [];
  const problems: string[] = [];

  if (!directoryExists(root)) return { skills, problems };

  for (const category of listDirectoriesSync(root)) {
    const categoryDir = path.join(root, category);
    for (const id of listDirectoriesSync(categoryDir)) {
      const dir = path.join(categoryDir, id);
      const loaded = loadSkill(category, id, dir);
      if (loaded.ok) skills.push(loaded.value);
      else problems.push(loaded.error.message);
    }
  }

  return { skills, problems };
}

function loadSkill(category: string, dirName: string, dir: string): Result<LoadedSkill> {
  const manifestPath = path.join(dir, MANIFEST_FILE);
  const where = `${CATALOG_DIR}/${category}/${dirName}`;

  if (!fileExists(manifestPath)) {
    return fail('CONFIG_NOT_FOUND', `${where}: ${MANIFEST_FILE} ausente.`, { dir });
  }
  const raw = readJsonSync<Record<string, unknown>>(manifestPath);
  if (!raw.ok) return fail('CONFIG_INVALID', `${where}: ${MANIFEST_FILE} com JSON inválido.`, { dir });

  const manifest = raw.value;
  const id = typeof manifest['id'] === 'string' ? manifest['id'] : '';
  const version = typeof manifest['version'] === 'string' ? manifest['version'] : '';

  if (!/^[a-z0-9][a-z0-9-]*$/i.test(id)) {
    return fail('CONFIG_INVALID', `${where}: campo "id" ausente ou inválido.`, { dir });
  }
  if (id !== dirName) {
    return fail(
      'CONFIG_INVALID',
      `${where}: o id "${id}" precisa ser igual ao nome da pasta "${dirName}".`,
      { dir },
    );
  }
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    return fail('CONFIG_INVALID', `${where}: campo "version" precisa ser X.Y.Z.`, { dir });
  }

  /* Recusa dura: nesta versão a Skill é documento. Aceitar o manifesto e
     apenas "não executar" deixaria a promessa dependendo de quem chama. */
  if (manifest['executeScripts'] === true) {
    return fail(
      'VALIDATION_FAILED',
      `${where}: "executeScripts" precisa ser false. Skills que executam script não são suportadas nesta versão.`,
      { dir },
    );
  }
  if (manifest['networkAccess'] === true) {
    return fail(
      'VALIDATION_FAILED',
      `${where}: "networkAccess" precisa ser false. Skills não acessam a rede nesta versão.`,
      { dir },
    );
  }

  const status = manifest['status'];
  if (status !== 'approved' && status !== 'draft' && status !== 'deprecated') {
    return fail('CONFIG_INVALID', `${where}: "status" precisa ser approved, draft ou deprecated.`, { dir });
  }

  const agents = manifest['compatibleAgents'];
  if (!Array.isArray(agents) || agents.some((a) => a !== 'claude' && a !== 'codex')) {
    return fail('CONFIG_INVALID', `${where}: "compatibleAgents" precisa listar claude e/ou codex.`, { dir });
  }

  const entrypoint = typeof manifest['entrypoint'] === 'string' ? manifest['entrypoint'] : 'SKILL.md';
  /* O entrypoint não pode escapar da pasta da Skill. */
  if (entrypoint.includes('..') || path.isAbsolute(entrypoint)) {
    return fail('PATH_UNSAFE', `${where}: "entrypoint" precisa ser um arquivo dentro da pasta da Skill.`, { dir });
  }

  const contentPath = path.join(dir, entrypoint);
  if (!fileExists(contentPath)) {
    return fail('CONFIG_NOT_FOUND', `${where}: o entrypoint "${entrypoint}" não existe.`, { dir });
  }
  const content = readTextSync(contentPath);
  if (!content.ok) return fail('IO_FAILED', `${where}: não foi possível ler "${entrypoint}".`, { dir });
  if (content.value.trim().length === 0) {
    return fail('CONFIG_INVALID', `${where}: o entrypoint "${entrypoint}" está vazio.`, { dir });
  }

  const parsed: SkillManifest = {
    id,
    name: typeof manifest['name'] === 'string' ? manifest['name'] : id,
    version,
    description: typeof manifest['description'] === 'string' ? manifest['description'] : '',
    status,
    compatibleAgents: agents as Array<'claude' | 'codex'>,
    roles: Array.isArray(manifest['roles'])
      ? (manifest['roles'] as unknown[]).filter((r): r is string => typeof r === 'string')
      : [],
    entrypoint,
    executeScripts: false,
    networkAccess: false,
  };

  return ok({
    manifest: parsed,
    category,
    directory: dir,
    content: content.value,
    contentHash: contentHash(content.value),
  });
}

export interface ResolveSkillsInput {
  declaration: RoundSkillDeclaration;
  catalog: readonly LoadedSkill[];
}

export interface ResolvedSkills {
  claude: LoadedSkill[];
  codex: LoadedSkill[];
}

/**
 * Resolve as Skills declaradas por uma rodada.
 *
 * Falha — nunca degrada. Uma Skill ausente ou em versão diferente da declarada
 * significa que a rodada rodaria sob regras diferentes das que foram validadas,
 * e isso é indistinguível de não ter validado.
 */
export function resolveDeclaredSkills(input: ResolveSkillsInput): Result<ResolvedSkills> {
  const problems: string[] = [];
  const out: ResolvedSkills = { claude: [], codex: [] };

  for (const agent of ['claude', 'codex'] as const) {
    for (const raw of input.declaration[agent]) {
      const ref = parseSkillRef(raw);
      if (!ref.ok) {
        problems.push(ref.error.message);
        continue;
      }

      const found = input.catalog.find((skill) => skill.manifest.id === ref.value.id);
      if (!found) {
        problems.push(
          `Skill "${ref.value.id}" declarada para ${agent} não existe no catálogo local (${skillsRoot()}).`,
        );
        continue;
      }
      if (found.manifest.version !== ref.value.version) {
        problems.push(
          `Skill "${ref.value.id}": a rodada declara a versão ${ref.value.version}, mas o catálogo tem ${found.manifest.version}. ` +
            'Versão divergente bloqueia: a rodada foi validada sob a versão declarada.',
        );
        continue;
      }
      if (found.manifest.status !== 'approved') {
        problems.push(
          `Skill "${ref.value.id}" está com status "${found.manifest.status}" e não pode ser ativada.`,
        );
        continue;
      }
      if (!found.manifest.compatibleAgents.includes(agent)) {
        problems.push(
          `Skill "${ref.value.id}" não declara compatibilidade com ${agent}.`,
        );
        continue;
      }
      out[agent].push(found);
    }
  }

  if (problems.length > 0) {
    return fail(
      'VALIDATION_FAILED',
      `Skills declaradas não puderam ser ativadas:\n- ${problems.join('\n- ')}`,
      { problems },
    );
  }
  return ok(out);
}

/** Congela as Skills resolvidas: id, versão e hash do documento. */
export function snapshotSkills(resolved: ResolvedSkills): SkillSnapshot {
  const map = (list: readonly LoadedSkill[]) =>
    list.map((skill) => ({
      id: skill.manifest.id,
      version: skill.manifest.version,
      contentHash: skill.contentHash,
    }));

  return { capturedAt: nowIso(), claude: map(resolved.claude), codex: map(resolved.codex) };
}

/**
 * Confere que as Skills em disco continuam idênticas ao snapshot.
 *
 * Chamado a cada retomada e antes de cada chamada de agente. Editar uma Skill
 * no meio de uma execução mudaria as regras entre uma tentativa e a seguinte —
 * a mesma classe de problema que `PROMPT_CHANGED_DURING_RUN` cobre.
 */
export function assertSkillsUnchanged(
  snapshot: SkillSnapshot,
  catalog: readonly LoadedSkill[],
): Result<void> {
  const problems: string[] = [];

  for (const agent of ['claude', 'codex'] as const) {
    for (const frozen of snapshot[agent]) {
      const current = catalog.find((skill) => skill.manifest.id === frozen.id);
      if (!current) {
        problems.push(`Skill "${frozen.id}" foi removida do catálogo durante a execução.`);
        continue;
      }
      if (current.manifest.version !== frozen.version) {
        problems.push(
          `Skill "${frozen.id}": versão mudou de ${frozen.version} para ${current.manifest.version} durante a execução.`,
        );
        continue;
      }
      if (current.contentHash !== frozen.contentHash) {
        problems.push(
          `Skill "${frozen.id}" foi editada durante a execução: o conteúdo não corresponde ao congelado.`,
        );
      }
    }
  }

  if (problems.length > 0) {
    return fail(
      'VALIDATION_FAILED',
      `Skills alteradas durante a execução:\n- ${problems.join('\n- ')}\n\n` +
        'A execução foi interrompida: as tentativas anteriores rodaram sob outras regras.',
      { problems },
    );
  }
  return ok(undefined);
}

/**
 * Monta o bloco que entra no prompt do agente.
 *
 * Os limites são declarados DENTRO do texto, para o agente, e não só no
 * código: a Skill precisa saber que não pode ampliar escopo nem dispensar
 * teste, porque é ela que está sendo lida no momento da decisão.
 */
export function renderSkillsForAgent(skills: readonly LoadedSkill[]): string {
  if (skills.length === 0) return '';

  const blocks = skills.map((skill) =>
    [
      `### ${skill.manifest.name} (${skill.manifest.id}@${skill.manifest.version})`,
      '',
      skill.content.trim(),
    ].join('\n'),
  );

  return [
    '## Skills ativas nesta rodada',
    '',
    'As Skills abaixo foram declaradas pela rodada e congeladas no início da',
    'execução. Elas orientam COMO trabalhar. Elas não ampliam o escopo do',
    'prompt, não substituem as políticas do projeto e não dispensam nenhum',
    'teste obrigatório. Em caso de conflito, o prompt e as políticas vencem.',
    '',
    blocks.join('\n\n'),
  ].join('\n');
}
