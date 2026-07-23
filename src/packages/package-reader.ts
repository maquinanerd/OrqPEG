import * as path from 'node:path';
import type {
  BranchStrategy,
  CuratedPackage,
  PackageExecutionPlan,
  PackageRound,
  Result,
  RoundSkillDeclaration,
} from '../types';
import { fail, ok } from '../utils/errors';
import { directoryExists, fileExists, listDirectoriesSync, listFilesSync, readJsonSync, readTextSync } from '../utils/fs-atomic';
import { naturalCompare } from '../utils/natural-sort';
import { validateAbsolutePath, validateIdentifier } from '../security/path-guard';
import { stableHash, contentHash } from '../execution/fingerprints';

/**
 * Leitura e validação de um pacote curado.
 *
 * REGRA CENTRAL: este módulo valida e RECUSA. Ele não completa seções
 * ausentes, não reescreve roadmap, não inventa dependências, não escolhe
 * estratégia de PR e não conserta arquivo inválido. Um pacote quebrado produz
 * "PACOTE INVÁLIDO" com a lista de problemas — nunca "pacote corrigido
 * automaticamente", que seria o OrqPEG decidindo o que o autor quis dizer.
 *
 * A validação é exaustiva de propósito: relata TODOS os problemas de uma vez,
 * em vez de parar no primeiro. Quem está montando um pacote precisa da lista
 * inteira para corrigir de uma vez, não de uma descoberta por tentativa.
 */

const REQUIRED_DOCUMENTS = ['PROJECT-CONTEXT.md', 'ROADMAP.md', 'VALIDATION.md'] as const;
const PLAN_FILE = 'execution-plan.json';
const ROUNDS_DIR = 'rounds';
const ROUND_FILE = 'round.json';
const PROMPTS_DIR = 'prompts';

const BRANCH_STRATEGIES: ReadonlySet<string> = new Set(['per_run', 'fixed', 'per_prompt']);

export interface PackageProblem {
  /** Caminho relativo dentro do pacote, para a pessoa saber onde olhar. */
  where: string;
  message: string;
}

/** Erro de pacote inválido, com a lista completa de problemas. */
export function invalidPackage(rootPath: string, problems: PackageProblem[]): Result<never> {
  const lines = problems.map((p) => `  - ${p.where}: ${p.message}`).join('\n');
  return fail(
    'VALIDATION_FAILED',
    `PACOTE INVÁLIDO — ${String(problems.length)} problema(s) em ${rootPath}:\n${lines}\n\n` +
      'Nada foi importado e nada foi alterado. Corrija o pacote na origem e importe de novo: ' +
      'o OrqPEG não completa nem reescreve arquivos de pacote.',
    { rootPath, problems },
  );
}

/**
 * Lê e valida um pacote a partir de uma pasta local.
 *
 * Devolve o pacote completo em memória — inclusive os documentos — para que a
 * importação seja uma cópia de algo já verificado, e não uma leitura em duas
 * etapas onde o arquivo pode mudar no meio.
 */
export function readCuratedPackage(rootPathRaw: string): Result<CuratedPackage> {
  const rootCheck = validateAbsolutePath(rootPathRaw, 'pasta do pacote');
  if (!rootCheck.ok) return rootCheck;
  const rootPath = rootCheck.value;

  if (!directoryExists(rootPath)) {
    return fail('CONFIG_NOT_FOUND', `A pasta do pacote não existe: ${rootPath}`, { rootPath });
  }

  const problems: PackageProblem[] = [];

  /* --- Documentos obrigatórios ----------------------------------------- */
  const documents: Record<string, string> = {};
  for (const name of REQUIRED_DOCUMENTS) {
    const filePath = path.join(rootPath, name);
    if (!fileExists(filePath)) {
      problems.push({ where: name, message: 'arquivo obrigatório ausente' });
      continue;
    }
    const read = readTextSync(filePath);
    if (!read.ok) {
      problems.push({ where: name, message: 'não foi possível ler o arquivo' });
      continue;
    }
    if (read.value.trim().length === 0) {
      problems.push({ where: name, message: 'arquivo vazio' });
      continue;
    }
    documents[name] = read.value;
  }

  /* --- Plano de execução ------------------------------------------------ */
  const planPath = path.join(rootPath, PLAN_FILE);
  if (!fileExists(planPath)) {
    problems.push({ where: PLAN_FILE, message: 'arquivo obrigatório ausente' });
    return invalidPackage(rootPath, problems);
  }
  const planRaw = readJsonSync<unknown>(planPath);
  if (!planRaw.ok) {
    problems.push({ where: PLAN_FILE, message: 'JSON inválido ou ilegível' });
    return invalidPackage(rootPath, problems);
  }

  const plan = validatePlan(planRaw.value, problems);

  /* --- Rodadas ---------------------------------------------------------- */
  const roundsRoot = path.join(rootPath, ROUNDS_DIR);
  const rounds: PackageRound[] = [];

  if (!directoryExists(roundsRoot)) {
    problems.push({ where: ROUNDS_DIR, message: 'pasta de rodadas ausente' });
  } else {
    const dirs = listDirectoriesSync(roundsRoot).sort(naturalCompare);
    if (dirs.length === 0) {
      problems.push({ where: ROUNDS_DIR, message: 'o pacote precisa de pelo menos uma rodada' });
    }
    for (const dir of dirs) {
      const round = validateRound(roundsRoot, dir, problems);
      if (round) rounds.push(round);
    }
  }

  if (plan) validateCoherence(plan, rounds, problems);

  if (problems.length > 0) return invalidPackage(rootPath, problems);
  if (!plan) return invalidPackage(rootPath, [{ where: PLAN_FILE, message: 'plano inválido' }]);

  /* O hash cobre plano, rodadas e documentos: é o que congela o pacote e o
     que detecta que a origem mudou entre a importação e a execução. */
  const packageHash = stableHash({
    plan,
    rounds,
    documents: Object.fromEntries(
      Object.entries(documents).map(([name, text]) => [name, contentHash(text)]),
    ),
  });

  return ok({
    rootPath,
    plan,
    rounds: [...rounds].sort((a, b) => a.order - b.order || naturalCompare(a.id, b.id)),
    packageHash,
    documents: {
      projectContext: documents['PROJECT-CONTEXT.md'] ?? '',
      roadmap: documents['ROADMAP.md'] ?? '',
      validation: documents['VALIDATION.md'] ?? '',
    },
  });
}

/* ------------------------------------------------------------------------- */

function validatePlan(value: unknown, problems: PackageProblem[]): PackageExecutionPlan | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    problems.push({ where: PLAN_FILE, message: 'o conteúdo precisa ser um objeto JSON' });
    return null;
  }
  const raw = value as Record<string, unknown>;
  const before = problems.length;

  if (raw['schemaVersion'] !== 1) {
    problems.push({ where: PLAN_FILE, message: 'schemaVersion precisa ser 1' });
  }

  const packageId = asIdentifier(raw['packageId'], 'packageId', PLAN_FILE, problems);
  const name = asText(raw['name'], 'name', PLAN_FILE, problems);
  const description = asText(raw['description'], 'description', PLAN_FILE, problems);

  /* --- Validação manual: o portão que autoriza executar ----------------- */
  const validationRaw = raw['validation'];
  let validation = null as PackageExecutionPlan['validation'] | null;
  if (!validationRaw || typeof validationRaw !== 'object') {
    problems.push({ where: `${PLAN_FILE}/validation`, message: 'seção obrigatória ausente' });
  } else {
    const v = validationRaw as Record<string, unknown>;
    const status = v['status'];
    if (status !== 'approved') {
      problems.push({
        where: `${PLAN_FILE}/validation.status`,
        message:
          `precisa ser "approved" para executar (encontrado: ${JSON.stringify(status)}). ` +
          'Um pacote não validado não é executado.',
      });
    }
    const sha = v['validatedCommitSha'];
    if (typeof sha !== 'string' || !/^[0-9a-f]{7,40}$/i.test(sha)) {
      problems.push({
        where: `${PLAN_FILE}/validation.validatedCommitSha`,
        message: 'precisa ser o SHA do commit contra o qual o pacote foi validado',
      });
    }
    const at = asText(v['validatedAt'], 'validation.validatedAt', PLAN_FILE, problems);
    const by = asText(v['validatedBy'], 'validation.validatedBy', PLAN_FILE, problems);
    if (status === 'approved' && typeof sha === 'string' && at && by) {
      validation = {
        status: 'approved',
        validatedCommitSha: sha,
        validatedAt: at,
        validatedBy: by,
        ...(typeof v['notes'] === 'string' ? { notes: v['notes'] } : {}),
      };
    }
  }

  const branchStrategy = raw['branchStrategy'];
  if (typeof branchStrategy !== 'string' || !BRANCH_STRATEGIES.has(branchStrategy)) {
    problems.push({
      where: `${PLAN_FILE}/branchStrategy`,
      message: `precisa ser um de: ${[...BRANCH_STRATEGIES].join(', ')}`,
    });
  }

  const prRaw = raw['pullRequest'];
  let pullRequest = null as PackageExecutionPlan['pullRequest'] | null;
  if (!prRaw || typeof prRaw !== 'object') {
    problems.push({ where: `${PLAN_FILE}/pullRequest`, message: 'seção obrigatória ausente' });
  } else {
    const pr = prRaw as Record<string, unknown>;
    const perRound = asBool(pr['perRound'], 'pullRequest.perRound', PLAN_FILE, problems);
    const draft = asBool(pr['draftDuringExecution'], 'pullRequest.draftDuringExecution', PLAN_FILE, problems);
    const wait = asBool(pr['waitForChecks'], 'pullRequest.waitForChecks', PLAN_FILE, problems);
    if (perRound !== null && draft !== null && wait !== null) {
      pullRequest = { perRound, draftDuringExecution: draft, waitForChecks: wait };
    }
  }

  /* Ausência significa o padrão seguro (`false`), não erro: encadear rodadas
     é a exceção, não a regra. */
  const continueBetween =
    raw['continueBetweenRounds'] === undefined ? false : raw['continueBetweenRounds'];
  if (typeof continueBetween !== 'boolean') {
    problems.push({
      where: `${PLAN_FILE}/continueBetweenRounds`,
      message: 'precisa ser booleano quando declarado',
    });
  }

  const roundsList = raw['rounds'];
  const planRounds: Array<{ id: string; order: number; dependsOn: string[] }> = [];
  if (!Array.isArray(roundsList) || roundsList.length === 0) {
    problems.push({ where: `${PLAN_FILE}/rounds`, message: 'precisa listar ao menos uma rodada' });
  } else {
    roundsList.forEach((entry, index) => {
      const where = `${PLAN_FILE}/rounds[${String(index)}]`;
      if (!entry || typeof entry !== 'object') {
        problems.push({ where, message: 'cada rodada precisa ser um objeto' });
        return;
      }
      const r = entry as Record<string, unknown>;
      const id = asIdentifier(r['id'], 'id', where, problems);
      const order = r['order'];
      if (typeof order !== 'number' || !Number.isInteger(order) || order < 1) {
        problems.push({ where: `${where}.order`, message: 'precisa ser inteiro >= 1' });
      }
      const deps = asStringArray(r['dependsOn'], 'dependsOn', where, problems);
      if (id && typeof order === 'number' && deps) {
        planRounds.push({ id, order, dependsOn: deps });
      }
    });
  }

  if (problems.length > before) return null;
  if (!validation || !pullRequest || !packageId || !name || description === null) return null;

  const plan: PackageExecutionPlan = {
    schemaVersion: 1,
    packageId,
    name,
    description,
    validation,
    branchStrategy: branchStrategy as BranchStrategy,
    pullRequest,
    continueBetweenRounds: continueBetween as boolean,
    rounds: planRounds,
    ...(raw['loopGuard'] && typeof raw['loopGuard'] === 'object'
      ? { loopGuard: raw['loopGuard'] as PackageExecutionPlan['loopGuard'] }
      : {}),
  };
  return plan;
}

function validateRound(
  roundsRoot: string,
  dirName: string,
  problems: PackageProblem[],
): PackageRound | null {
  const where = `${ROUNDS_DIR}/${dirName}`;
  const dir = path.join(roundsRoot, dirName);

  const roundPath = path.join(dir, ROUND_FILE);
  if (!fileExists(roundPath)) {
    problems.push({ where: `${where}/${ROUND_FILE}`, message: 'arquivo obrigatório ausente' });
    return null;
  }
  const raw = readJsonSync<Record<string, unknown>>(roundPath);
  if (!raw.ok) {
    problems.push({ where: `${where}/${ROUND_FILE}`, message: 'JSON inválido ou ilegível' });
    return null;
  }

  const before = problems.length;
  const r = raw.value;
  const id = asIdentifier(r['id'], 'id', `${where}/${ROUND_FILE}`, problems);
  const name = asText(r['name'], 'name', `${where}/${ROUND_FILE}`, problems);
  const objective = asText(r['objective'], 'objective', `${where}/${ROUND_FILE}`, problems);
  const deps = asStringArray(r['dependsOn'], 'dependsOn', `${where}/${ROUND_FILE}`, problems) ?? [];

  const order = r['order'];
  if (typeof order !== 'number' || !Number.isInteger(order) || order < 1) {
    problems.push({ where: `${where}/${ROUND_FILE}.order`, message: 'precisa ser inteiro >= 1' });
  }

  if (id !== null && id !== dirName) {
    problems.push({
      where: `${where}/${ROUND_FILE}.id`,
      message: `o id "${id}" precisa ser igual ao nome da pasta "${dirName}"`,
    });
  }

  /* --- Prompts ---------------------------------------------------------- */
  const promptsDir = path.join(dir, PROMPTS_DIR);
  const declared = asStringArray(r['prompts'], 'prompts', `${where}/${ROUND_FILE}`, problems);

  if (!directoryExists(promptsDir)) {
    problems.push({ where: `${where}/${PROMPTS_DIR}`, message: 'pasta de prompts ausente' });
  } else {
    const onDisk = listFilesSync(promptsDir).filter((f) => f.toLowerCase().endsWith('.md'));
    if (onDisk.length === 0) {
      problems.push({
        where: `${where}/${PROMPTS_DIR}`,
        message: 'a rodada precisa de pelo menos um prompt .md',
      });
    }
    if (declared) {
      if (declared.length === 0) {
        problems.push({
          where: `${where}/${ROUND_FILE}.prompts`,
          message: 'a lista de prompts não pode ser vazia',
        });
      }
      /* Declarado e disco precisam bater dos DOIS lados: um prompt no disco
         que ninguém declarou não seria executado e passaria despercebido. */
      for (const declaredName of declared) {
        if (!onDisk.includes(declaredName)) {
          problems.push({
            where: `${where}/${ROUND_FILE}.prompts`,
            message: `o prompt "${declaredName}" está declarado mas não existe em ${PROMPTS_DIR}/`,
          });
        }
      }
      for (const file of onDisk) {
        if (!declared.includes(file)) {
          problems.push({
            where: `${where}/${PROMPTS_DIR}/${file}`,
            message: 'existe em disco mas não está declarado em round.json; não seria executado',
          });
        }
      }
    }
  }

  const skills = validateSkillDeclaration(r['skills'], `${where}/${ROUND_FILE}`, problems);

  if (problems.length > before) return null;
  if (id === null || name === null || objective === null || !declared) return null;

  return {
    id,
    name,
    objective,
    order: order as number,
    dependsOn: deps,
    prompts: declared,
    skills,
  };
}

function validateSkillDeclaration(
  value: unknown,
  where: string,
  problems: PackageProblem[],
): RoundSkillDeclaration {
  const empty: RoundSkillDeclaration = { claude: [], codex: [] };
  if (value === undefined || value === null) return empty;
  if (typeof value !== 'object' || Array.isArray(value)) {
    problems.push({ where: `${where}.skills`, message: 'precisa ser um objeto com claude e codex' });
    return empty;
  }
  const raw = value as Record<string, unknown>;
  const out: RoundSkillDeclaration = { claude: [], codex: [] };

  for (const agent of ['claude', 'codex'] as const) {
    const list = raw[agent];
    if (list === undefined) continue;
    const parsed = asStringArray(list, `skills.${agent}`, where, problems);
    if (!parsed) continue;
    for (const ref of parsed) {
      /* `<id>@<versão>` é obrigatório: sem versão, atualizar a Skill mudaria
         silenciosamente o comportamento de uma rodada já validada. */
      if (!/^[a-z0-9][a-z0-9-]*@\d+\.\d+\.\d+$/i.test(ref)) {
        problems.push({
          where: `${where}.skills.${agent}`,
          message: `"${ref}" precisa estar no formato <id>@<versao> (ex.: typescript-strict@1.0.0)`,
        });
        continue;
      }
      out[agent].push(ref);
    }
  }
  return out;
}

/**
 * Coerência entre o plano e as rodadas em disco.
 *
 * Aqui moram as validações que nenhum arquivo isolado consegue fazer:
 * dependência inexistente, ciclo, ordem duplicada e divergência entre o que o
 * plano lista e o que existe em `rounds/`.
 */
function validateCoherence(
  plan: PackageExecutionPlan,
  rounds: PackageRound[],
  problems: PackageProblem[],
): void {
  const onDisk = new Set(rounds.map((r) => r.id));
  const planned = new Set(plan.rounds.map((r) => r.id));

  for (const entry of plan.rounds) {
    if (!onDisk.has(entry.id)) {
      problems.push({
        where: `${PLAN_FILE}/rounds`,
        message: `a rodada "${entry.id}" está no plano mas não existe em ${ROUNDS_DIR}/`,
      });
    }
  }
  for (const round of rounds) {
    if (!planned.has(round.id)) {
      problems.push({
        where: `${ROUNDS_DIR}/${round.id}`,
        message: 'existe em disco mas não está listada em execution-plan.json',
      });
    }
  }

  /* Dependências precisam existir. Apontar para uma rodada inexistente
     travaria a execução para sempre, esperando algo que nunca conclui. */
  const known = new Set([...onDisk, ...planned]);
  for (const round of rounds) {
    for (const dep of round.dependsOn) {
      if (!known.has(dep)) {
        problems.push({
          where: `${ROUNDS_DIR}/${round.id}/${ROUND_FILE}.dependsOn`,
          message: `a dependência "${dep}" não corresponde a nenhuma rodada do pacote`,
        });
      }
      if (dep === round.id) {
        problems.push({
          where: `${ROUNDS_DIR}/${round.id}/${ROUND_FILE}.dependsOn`,
          message: 'uma rodada não pode depender de si mesma',
        });
      }
    }
  }

  const cycle = findDependencyCycle(rounds);
  if (cycle) {
    problems.push({
      where: `${ROUNDS_DIR}`,
      message: `há um ciclo de dependências entre rodadas: ${cycle.join(' -> ')}. Nenhuma delas poderia começar.`,
    });
  }

  const orders = new Map<number, string[]>();
  for (const round of rounds) {
    const list = orders.get(round.order) ?? [];
    list.push(round.id);
    orders.set(round.order, list);
  }
  for (const [order, ids] of orders) {
    if (ids.length > 1) {
      problems.push({
        where: ROUNDS_DIR,
        message: `a ordem ${String(order)} está repetida em: ${ids.join(', ')}. A ordem precisa ser inequívoca.`,
      });
    }
  }

  /* Uma dependência que roda DEPOIS de quem depende dela é ordem inválida,
     mesmo sem ciclo. */
  const orderOf = new Map(rounds.map((r) => [r.id, r.order]));
  for (const round of rounds) {
    for (const dep of round.dependsOn) {
      const depOrder = orderOf.get(dep);
      if (depOrder !== undefined && depOrder >= round.order) {
        problems.push({
          where: `${ROUNDS_DIR}/${round.id}/${ROUND_FILE}.dependsOn`,
          message: `depende de "${dep}", que tem ordem ${String(depOrder)} — não anterior à sua (${String(round.order)})`,
        });
      }
    }
  }
}

/** Busca em profundidade que devolve o primeiro ciclo encontrado. */
function findDependencyCycle(rounds: readonly PackageRound[]): string[] | null {
  const graph = new Map(rounds.map((r) => [r.id, r.dependsOn]));
  const state = new Map<string, 'visiting' | 'done'>();
  const stack: string[] = [];

  const visit = (id: string): string[] | null => {
    const current = state.get(id);
    if (current === 'done') return null;
    if (current === 'visiting') return [...stack.slice(stack.indexOf(id)), id];

    state.set(id, 'visiting');
    stack.push(id);
    for (const dep of graph.get(id) ?? []) {
      if (!graph.has(dep)) continue;
      const found = visit(dep);
      if (found) return found;
    }
    stack.pop();
    state.set(id, 'done');
    return null;
  };

  for (const round of rounds) {
    const found = visit(round.id);
    if (found) return found;
  }
  return null;
}

/* --- Leitores de campo, todos com mensagem em português ------------------ */

function asText(value: unknown, field: string, where: string, problems: PackageProblem[]): string | null {
  if (typeof value !== 'string' || value.trim().length === 0) {
    problems.push({ where: `${where}.${field}`, message: 'texto obrigatório ausente ou vazio' });
    return null;
  }
  return value.trim();
}

function asIdentifier(
  value: unknown,
  field: string,
  where: string,
  problems: PackageProblem[],
): string | null {
  if (typeof value !== 'string') {
    problems.push({ where: `${where}.${field}`, message: 'identificador obrigatório ausente' });
    return null;
  }
  const check = validateIdentifier(value, field);
  if (!check.ok) {
    problems.push({ where: `${where}.${field}`, message: check.error.message });
    return null;
  }
  return check.value;
}

function asBool(value: unknown, field: string, where: string, problems: PackageProblem[]): boolean | null {
  if (typeof value !== 'boolean') {
    problems.push({ where: `${where}.${field}`, message: 'precisa ser booleano' });
    return null;
  }
  return value;
}

function asStringArray(
  value: unknown,
  field: string,
  where: string,
  problems: PackageProblem[],
): string[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    problems.push({ where: `${where}.${field}`, message: 'precisa ser uma lista de textos' });
    return null;
  }
  return value as string[];
}
