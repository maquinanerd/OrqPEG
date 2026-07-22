# OrqPEG 1.0.0

Orquestrador local que coordena **Claude Code** e **Codex CLI** para executar,
revisar, testar e integrar trabalhos de desenvolvimento em múltiplos repositórios
Git já existentes no seu computador.

O OrqPEG não escreve código sozinho e não é um editor. Ele é o maestro: lê os
prompts que você escreveu, manda a IA executora trabalhar, roda os testes do seu
projeto, manda a segunda IA revisar, faz commit e push, abre a Pull Request,
espera o CI, pede uma auditoria final às duas IAs e só então — se **todos** os
gates passarem — executa o merge.

| Item | Valor |
| --- | --- |
| Versão | 1.0.0 |
| Pasta de instalação | `C:\OrqPEG` |
| Repositório | <https://github.com/maquinanerd/OrqPEG> |
| Branch padrão | `main` |
| Plataforma alvo | Windows 10/11 (Windows-first) |
| Runtime | Node.js 20 ou superior |
| Dependências de runtime | nenhuma (só módulos nativos do Node) |
| Painel | `http://127.0.0.1:8765` |

---

## Índice

1. [O que o produto faz](#o-que-o-produto-faz)
2. [Garantia de zero API de IA](#garantia-de-zero-api-de-ia)
3. [Requisitos](#requisitos)
4. [Instalação](#instalação)
5. [Cadastro de projetos](#cadastro-de-projetos)
6. [Formato dos prompts](#formato-dos-prompts)
7. [Worktrees](#worktrees)
8. [Fluxo operacional completo](#fluxo-operacional-completo)
9. [Painel](#painel)
10. [Os 20 gates de merge](#os-20-gates-de-merge)
11. [Invalidação de aprovações](#invalidação-de-aprovações)
12. [Pausa, retomada e cancelamento seguro](#pausa-retomada-e-cancelamento-seguro)
13. [Logs, relatórios e artefatos](#logs-relatórios-e-artefatos)
14. [Limites de assinatura](#limites-de-assinatura)
15. [Os 16 comandos `.cmd`](#os-16-comandos-cmd)
16. [Solução de problemas](#solução-de-problemas)

---

## O que o produto faz

O OrqPEG orquestra dois CLIs de IA que **já estão instalados e autenticados na sua
máquina**, usando duas funções distintas e não intercambiáveis:

| Papel | Agente | O que faz | Pode editar arquivos? |
| --- | --- | --- | --- |
| Executor | `claude` | Implementa o prompt dentro do worktree | Sim |
| Corretor | `claude` | Aplica as correções exigidas pela revisão | Sim |
| Revisor de prompt | `codex` | Julga se o prompt foi cumprido | Não (somente leitura) |
| Auditor de merge | `claude` | Auditoria final antes do merge | Não (somente leitura) |
| Auditor de merge | `codex` | Auditoria final antes do merge | Não (somente leitura) |

Princípios que o produto respeita sem exceção:

- **O código do seu projeto nunca é copiado.** O OrqPEG passa a orquestrar o
  repositório onde ele já está.
- **Nada destrutivo.** Não existe `push --force`, `reset --hard`, `git clean`,
  `branch -D` nem `worktree remove --force` em nenhum caminho de execução.
- **Duas IAs ou nada.** Um merge automático exige aprovação independente do
  Claude *e* do Codex sobre exatamente o mesmo commit.
- **Processos externos sempre com vetor de argumentos.** Nunca há `shell: true`
  nem concatenação de linha de comando — não há superfície para injeção.

---

## Garantia de zero API de IA

O OrqPEG fala **exclusivamente** com os executáveis locais `claude` e `codex`,
autenticados pelas assinaturas **Claude Max** e **ChatGPT Plus**.

Não existe, em nenhum ponto do código:

- SDK de provedor de IA (nem da Anthropic, nem da OpenAI);
- requisição HTTP para endpoints de API de IA;
- leitura do **valor** de qualquer variável de API;
- automação de navegador para contornar autenticação.

O `package.json` declara `"dependencies": {}` e o workflow de segurança do
repositório **falha o build** se alguém tentar introduzir uma dependência de
runtime, um SDK de IA ou uma chamada a endpoint de API.

### Como o ambiente filho é sanitizado

Sua máquina **não é alterada**. A remoção acontece apenas na cópia do ambiente
entregue ao `spawn` do processo filho.

```text
process.env  ──►  buildSanitizedEnv()  ──►  env do processo filho
                       remove (case-insensitive):
                         ANTHROPIC_API_KEY
                         OPENAI_API_KEY
                         CODEX_API_KEY
                         ANTHROPIC_AUTH_TOKEN
                         OPENAI_API_KEY_PATH
                         ANTHROPIC_ADMIN_KEY
                       ──►  assertChildEnvIsClean()  (última linha de defesa)
```

Comportamento em detalhe:

| Situação | O que o OrqPEG faz |
| --- | --- |
| Variável de API presente no ambiente | Reporta apenas o **nome**, nunca o valor, e **bloqueia** a execução por padrão |
| Você confirma a continuação | Roda com o ambiente do filho sanitizado; sua sessão do Windows permanece intacta |
| Variáveis de roteamento (`ANTHROPIC_BASE_URL`, `OPENAI_BASE_URL`, `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX`, ...) | Reporta como **aviso**: podem redirecionar o CLI para um gateway cobrado |
| Ferramentas não-IA (`git`, `gh`, `npm`) | Também recebem ambiente limpo, para que um teste do projeto não encontre chave alguma |

O bloqueio é configurável em `config/global.json` (`security.blockWhenApiKeysPresent`),
mas o padrão é bloquear.

---

## Requisitos

| Ferramenta | Mínimo | Detectado nesta instalação | Obrigatório? |
| --- | --- | --- | --- |
| Windows | 10/11 | Windows 11 Pro (10.0.26100) | Sim |
| Node.js | 20.0.0 | 24.14.0 | Sim |
| npm | 9 | 11.9.0 | Sim |
| Git | 2.30 | 2.55.0 | Sim |
| GitHub CLI (`gh`) | 2.x, autenticado | 2.95.0 | Sim, para PR / CI / merge |
| Claude Code (`claude`) | autenticado com Claude Max | 2.1.207 | Sim |
| Codex CLI (`codex`) | autenticado com ChatGPT Plus | **NÃO INSTALADO** | Sim, para merge automático |

### Aviso honesto sobre o Codex CLI

**Nesta máquina o Codex CLI não está instalado.** Consequência real e sem
rodeios:

- a execução de prompts com revisão do Codex **não roda**;
- a auditoria dupla de merge fica **BLOQUEADA**;
- o gate 14 `CODEX_MERGE_APPROVED` **reprova**;
- portanto **nenhum merge automático acontece**.

Isso é comportamento correto, não defeito: o OrqPEG **jamais** aprova um merge
com apenas uma IA. Para desbloquear, instale o Codex CLI e autentique com
**"Sign in with ChatGPT"** (assinatura ChatGPT Plus). Enquanto isso não
acontecer, use o produto em `--dry-run`, ou com `merge.mode` em `manual`, e faça
o merge você mesmo pelo GitHub depois de revisar.

Verifique a situação a qualquer momento:

```bat
DIAGNOSTICO.cmd
```

---

## Instalação

```bat
cd /d C:\OrqPEG
npm ci
npm run build
INSTALAR-E-CONFIGURAR.cmd
DIAGNOSTICO.cmd
```

O que cada passo faz:

| Passo | Efeito |
| --- | --- |
| `npm ci` | Instala apenas as dependências de desenvolvimento (TypeScript e `@types/node`) |
| `npm run build` | Compila `src/` em `dist/` com TypeScript estrito |
| `INSTALAR-E-CONFIGURAR.cmd` | Cria `config/global.json` e a árvore `data/` |
| `DIAGNOSTICO.cmd` | Verifica sistema, ferramentas, chaves de API, schemas, wrappers, porta e locks |

Estrutura criada na instalação:

```text
C:\OrqPEG
├── config\            global.json e global.example.json
├── data\
│   ├── projects\      um diretório por projeto cadastrado
│   ├── state\         estado das execuções
│   ├── locks\         locks de projeto, worktree, run, PR, merge e estado
│   ├── logs\          logs estruturados
│   ├── reviews\       revisões brutas das IAs
│   ├── reports\       relatórios gerados
│   ├── artifacts\     saídas por tentativa de prompt
│   └── worktrees\     worktrees quando não há raiz definida pelo projeto
├── schemas\           6 schemas JSON de validação
├── templates\         TEMPLATE-PROMPT.md, TEMPLATE-PROJECT.json e instruções
├── public\            arquivos estáticos do painel
├── dist\              código compilado
└── *.cmd              16 wrappers de duplo clique
```

Nada dentro de `data/` e `config/global.json` vai para o Git: são dados
operacionais da sua máquina.

---

## Cadastro de projetos

O projeto **já precisa existir** no computador como repositório Git com um
remoto no GitHub. O OrqPEG apenas passa a orquestrá-lo.

```bat
CADASTRAR-PROJETO.cmd
```

O assistente pergunta nome, identificador (slug), caminho local, repositório
GitHub (`owner/repo`), remoto, branch base, worktree, comandos de teste, timeout,
número máximo de tentativas e editor preferido. O resultado é gravado em
`data/projects/<id>/project.json`.

Exemplo completo (`templates/TEMPLATE-PROJECT.json`):

```json
{
  "id": "screen",
  "name": "Screen",
  "repositoryPath": "E:\\Projetos\\Screen",
  "githubRepository": "maquinanerd/screen",
  "remote": "origin",
  "baseBranch": "main",
  "branchStrategy": "per_run",
  "worktree": { "enabled": true, "rootPath": "E:\\AI-Worktrees", "reuseWhenSafe": true },
  "commands": {
    "install": ["npm ci"],
    "tests": ["npm run lint", "npm run typecheck", "npm test", "npm run build"],
    "timeoutSeconds": 1800
  },
  "execution": {
    "maxAttemptsPerPrompt": 3,
    "maxReviewerRetries": 2,
    "continueAfterApproval": true,
    "stopOnBlocked": true
  },
  "git": { "commitAfterApproval": true, "pushAfterRun": true, "commitMessagePrefix": "orqpeg" },
  "pullRequest": {
    "enabled": true,
    "draftDuringExecution": true,
    "markReadyBeforeMerge": true,
    "waitForChecks": true
  },
  "merge": {
    "enabled": true,
    "mode": "dual_ai_consensus",
    "strategy": "squash",
    "deleteBranchAfterMerge": true,
    "requireClaudeApproval": true,
    "requireCodexApproval": true,
    "requireLocalTests": true,
    "requireCiSuccess": true,
    "requireNoConflicts": true,
    "requireNoUnresolvedThreads": true,
    "invalidateApprovalOnHeadChange": true,
    "minimumConfidence": 0.9
  },
  "agents": { "claudeModel": null, "codexModel": null },
  "editor": null
}
```

Campos que merecem atenção:

| Campo | Valores | Significado |
| --- | --- | --- |
| `branchStrategy` | `per_run`, `fixed`, `per_prompt` | Como a branch de trabalho é escolhida |
| `merge.mode` | `dual_ai_consensus`, `manual`, `disabled` | `manual` e `disabled` desligam o merge automático |
| `merge.strategy` | `squash`, `merge`, `rebase` | Estratégia usada no merge da PR |
| `merge.minimumConfidence` | `0`–`1` | Confiança mínima exigida das **duas** auditorias |
| `execution.stopOnBlocked` | booleano | Interrompe a execução no primeiro veredito `BLOCKED` |

Caminhos com espaços e acentos são suportados (`E:\Meus Projetos\Ação`): todo
caminho é composto com `path.join`/`path.resolve` e validado contra escape de
diretório.

Remover o cadastro (`REMOVER-PROJETO.cmd`) apaga **apenas** os dados
operacionais do OrqPEG. O seu repositório permanece intacto.

---

## Formato dos prompts

Os prompts são arquivos Markdown em:

```text
C:\OrqPEG\data\projects\<id-do-projeto>\prompts\
```

A ordem de execução vem da **ordenação natural** do nome do arquivo, então o
prefixo numérico define a sequência (`2-x.md` roda antes de `10-x.md`):

```text
01-camada-de-configuracao.md
02-parser-de-prompts.md
10-painel-http.md
```

O modelo canônico está em `templates/TEMPLATE-PROMPT.md` e tem estas seções:

| Seção | Para que serve |
| --- | --- |
| `# Identificação` | `ID` (igual ao nome do arquivo sem extensão), `Nome` e `Dependências` |
| `# Objetivo` | Uma frase com o resultado observável |
| `# Contexto` | Estado atual do repositório e decisões já tomadas |
| `# Escopo obrigatório` | Lista fechada e verificável do que fazer |
| `# Fora do escopo` | O que não tocar, mesmo parecendo melhoria |
| `# Áreas permitidas` | Caminhos que a IA pode criar ou alterar |
| `# Áreas proibidas` | Caminhos intocáveis — violação é falha bloqueante |
| `# Requisitos funcionais` | Comportamento observável, com casos de erro e de borda |
| `# Requisitos técnicos` | Como implementar (estilo, tipos, erros, processos) |
| `# Critérios de aceitação` | Checklist binário com evidência |
| `# Testes obrigatórios` | Testes que precisam existir ao final |
| `# Restrições` | Proibições invioláveis da rodada |
| `# Evidências finais exigidas` | O que o relatório final da IA precisa conter |

O parser é tolerante de propósito: aceita `#` até `######`, títulos com ou sem
acento, títulos numerados (`2. Objetivo`), listas com `-`, `*`, `+`, `1.` e
caixas `[ ]`, e ignora blocos de código cercados por crases. Se o arquivo não
seguir o template, nada quebra: o conteúdo inteiro vira o corpo do prompt.

Commit, push, Pull Request e merge são **responsabilidade exclusiva do OrqPEG**.
O prompt deve proibir explicitamente que a IA faça isso.

---

## Worktrees

Quando `worktree.enabled` é `true`, cada execução acontece em um `git worktree`
dedicado, criado a partir da branch base. Vantagens: seu diretório de trabalho
principal continua livre, e um trabalho interrompido não deixa a sua cópia
principal em estado estranho.

```text
E:\AI-Worktrees\<projeto>\orqpeg-<projeto>-run-<stamp>
```

Nome da branch de execução:

```text
orqpeg/<projeto>/run-<stamp>
```

Regras aplicadas:

- Nomes de branch passam por validação estrita (sem `..`, sem espaço, sem
  caractere de controle, sem sequência inválida para o Git).
- `worktree.reuseWhenSafe` permite reaproveitar um worktree existente **somente
  quando é seguro**. Se o reaproveitamento estiver desligado e já existir um
  worktree ou a branch, a execução falha com mensagem explícita em vez de
  destruir trabalho.
- `git worktree remove --force`, `git clean` e `git reset --hard` não existem no
  módulo de worktree. Nenhuma alteração sua é descartada, nunca.
- Se `worktree.rootPath` for nulo, o OrqPEG usa `data/worktrees/`.

---

## Fluxo operacional completo

```text
       ┌──────────────────────────────────────────────────────────────┐
       │  VALIDATING       ambiente, projeto, prompts, gh, chaves     │
       └───────────────────────────────┬──────────────────────────────┘
                                       ▼
       ┌──────────────────────────────────────────────────────────────┐
       │  PREPARING_WORKTREE           worktree + branch de execução  │
       └───────────────────────────────┬──────────────────────────────┘
                                       ▼
   ╔═══ por prompt, em ordem natural ═══════════════════════════════════╗
   ║   RUNNING_CLAUDE      executor implementa o prompt                 ║
   ║        ▼                                                           ║
   ║   RUNNING_TESTS       comandos de teste do projeto                 ║
   ║        ▼                                                           ║
   ║   BUILDING_REVIEW_PACKAGE   diff, arquivos alterados, saída dos    ║
   ║        ▼                    testes e o prompt original             ║
   ║   RUNNING_CODEX       revisor emite JSON validado por schema       ║
   ║        ▼                                                           ║
   ║   ┌──────────────┬──────────────────┬───────────────────────────┐  ║
   ║   │ APPROVED     │ CHANGES_REQUESTED│ BLOCKED                   │  ║
   ║   │   ▼          │   ▼              │   ▼                       │  ║
   ║   │ COMMITTING   │ nova tentativa   │ para (stopOnBlocked)      │  ║
   ║   │              │ (até o máximo)   │                           │  ║
   ║   └──────────────┴──────────────────┴───────────────────────────┘  ║
   ╚════════════════════════════════════════════════════════════════════╝
                                       ▼
       PUSHING ──► CREATING_PR ──► WAITING_CI
                                       ▼
       RUNNING_CLAUDE_MERGE_AUDIT ──► RUNNING_CODEX_MERGE_AUDIT
                                       ▼
       MERGE_CONSENSUS_PENDING ──► 20 gates ──► MERGE_APPROVED
                                       ▼
                              MERGING ──► MERGED
```

Passo a passo, com o que o OrqPEG garante em cada etapa:

| # | Etapa | Garantia |
| --- | --- | --- |
| 1 | **Validar** | Projeto, prompts, `gh` autenticado, ambiente sem chave de API vazando |
| 2 | **Preparar worktree** | Worktree e branch criados a partir da base, sem tocar na sua árvore principal |
| 3 | **Executar** | Claude recebe o prompt renderizado e trabalha só dentro do worktree |
| 4 | **Testar** | Os comandos de `commands.tests` rodam de verdade, com timeout e saída capturada |
| 5 | **Revisar** | Codex recebe diff + testes + prompt e devolve JSON validado contra schema |
| 6 | **Corrigir** | `CHANGES_REQUESTED` gera nova tentativa com as ações exigidas, até `maxAttemptsPerPrompt` |
| 7 | **Commitar** | Só depois de `APPROVED`; um commit por prompt, com prefixo configurável |
| 8 | **Push** | Somente para o remoto declarado no projeto; force push é impossível |
| 9 | **Pull Request** | Criada via `gh`, opcionalmente como rascunho durante a execução |
| 10 | **CI** | O OrqPEG espera os checks obrigatórios; check pendente não vira aprovação |
| 11 | **Auditoria Claude** | Somente leitura, sobre o head SHA observado, saída validada por schema |
| 12 | **Auditoria Codex** | Somente leitura, mesmo head SHA, saída validada por schema |
| 13 | **Consenso** | Só existe se as duas auditorias aprovarem o **mesmo** commit com confiança suficiente |
| 14 | **Gates** | Os 20 gates são avaliados e registrados com evidência |
| 15 | **Merge** | `gh pr merge --squash --match-head-commit <sha>`: o próprio GitHub recusa se o commit mudou |

O merge é **idempotente**: uma PR já mergeada nunca é mergeada de novo; o
OrqPEG detecta a situação e registra `idempotentSkip`.

Simule tudo antes, sem tocar em nada:

```bat
EXECUTAR-DRY-RUN.cmd
```

---

## Painel

```bat
INICIAR-PAINEL.cmd     :: sobe o servidor local
ABRIR-PAINEL.cmd       :: abre o navegador em http://127.0.0.1:8765
PARAR-PAINEL.cmd       :: encerra o servidor
```

O servidor HTTP é escrito com `node:http` puro e:

- escuta **exclusivamente** em `127.0.0.1`; `0.0.0.0` é recusado na
  configuração e no código;
- valida o cabeçalho `Host` (aceita apenas `127.0.0.1`, `localhost` e `::1`),
  o que protege contra *DNS rebinding*;
- serve arquivos estáticos de `public/` com resolução confinada à raiz.

Endpoints da API do painel:

| Método | Rota | Função |
| --- | --- | --- |
| GET | `/api/home` | Resumo geral, ferramentas detectadas e guarda de API |
| GET | `/api/diagnostics` | Diagnóstico completo em JSON |
| GET/POST | `/api/projects` | Listar e criar projetos |
| GET/PUT/DELETE | `/api/projects/{id}` | Ler, atualizar e remover o cadastro |
| GET | `/api/projects/{id}/prompts` | Listar prompts |
| GET | `/api/projects/{id}/prompts/{promptId}` | Ler um prompt |
| GET | `/api/projects/{id}/runs` | Histórico de execuções |
| GET | `/api/projects/{id}/runs/{runId}` | Estado detalhado de uma execução |
| GET | `/api/projects/{id}/runs/{runId}/consensus` | Situação do consenso |
| GET | `/api/projects/{id}/runs/{runId}/report` | Relatório da execução |
| GET | `/api/projects/{id}/dry-run` | Plano simulado |
| POST | `/api/projects/{id}/run` | Iniciar execução |
| POST | `/api/projects/{id}/pause` | Solicitar pausa |
| POST | `/api/projects/{id}/resume` | Retomar |
| POST | `/api/projects/{id}/cancel` | Cancelamento seguro |
| POST | `/api/open` | Abrir um caminho local no editor/explorador |

---

## Os 20 gates de merge

Todos precisam passar. Um único `FAILED` impede o merge — não existe
sobreposição, atalho ou "forçar".

| # | Gate | O que exige |
| --- | --- | --- |
| 1 | `ALL_PROMPTS_APPROVED` | Todos os prompts aprovados pelo revisor |
| 2 | `ALL_COMMITS_CREATED` | Existe commit para cada prompt aprovado |
| 3 | `BRANCH_PUSHED_TO_CORRECT_REMOTE` | Branch enviada ao remoto declarado no projeto |
| 4 | `PR_OPEN` | A Pull Request está aberta (não fechada, não já mergeada) |
| 5 | `PR_BASE_CORRECT` | A base da PR é a `baseBranch` do projeto |
| 6 | `NO_CONFLICTS` | O GitHub reporta a PR como mesclável |
| 7 | `LOCAL_TESTS_PASSED` | A suíte local final passou |
| 8 | `REQUIRED_CHECKS_PASSED` | Todos os checks obrigatórios do CI concluíram com sucesso |
| 9 | `NO_PENDING_REQUIRED_CHECKS` | Nenhum check obrigatório em fila ou em execução |
| 10 | `NO_SKIPPED_REQUIRED_CHECKS` | Nenhum check obrigatório ignorado |
| 11 | `NO_UNRESOLVED_THREADS` | Nenhuma thread de revisão em aberto |
| 12 | `NO_HUMAN_CHANGES_REQUESTED` | Nenhum humano pediu mudanças na PR |
| 13 | `CLAUDE_MERGE_APPROVED` | Auditoria do Claude com veredito `APPROVED_FOR_MERGE` |
| 14 | `CODEX_MERGE_APPROVED` | Auditoria do Codex com veredito `APPROVED_FOR_MERGE` |
| 15 | `AUDITORS_SAME_HEAD_SHA` | As duas auditorias revisaram o mesmo commit |
| 16 | `MINIMUM_CONFIDENCE_MET` | As duas atingiram `merge.minimumConfidence` |
| 17 | `NO_BLOCKING_ISSUES` | Nenhuma das duas registrou problema bloqueador |
| 18 | `HEAD_SHA_UNCHANGED` | O head não mudou entre a auditoria e o merge |
| 19 | `BASE_NOT_INVALIDATED` | A base não mudou de forma que invalide as auditorias |
| 20 | `PROJECT_ALLOWS_DUAL_AI_CONSENSUS` | O projeto está em `merge.mode = dual_ai_consensus` |

> **Nesta máquina, o gate 14 reprova**, porque o Codex CLI não está instalado.
> Logo, o merge automático não acontece. Instale e autentique o Codex CLI para
> habilitar a auditoria dupla.

Cada gate é gravado no relatório com `status` (`PASSED`, `FAILED`, `SKIPPED`,
`NOT_EVALUATED`), motivo em português e evidência.

---

## Invalidação de aprovações

Uma aprovação de auditoria vale para **um commit específico**, não para a PR.

| Evento | Efeito |
| --- | --- |
| Novo commit na branch (head SHA muda) | Todas as auditorias existentes são marcadas como invalidadas e o motivo é registrado |
| Auditores revisaram SHAs diferentes | Gate 15 reprova; o consenso não é alcançado |
| Confiança abaixo do mínimo | Gate 16 reprova |
| Qualquer problema bloqueador reportado | Gate 17 reprova |
| Head muda entre a aprovação e o merge | Gate 18 reprova e o GitHub também recusa por causa de `--match-head-commit` |
| Base alterada de forma invalidante | Gate 19 reprova |

`merge.invalidateApprovalOnHeadChange` controla a invalidação automática por
mudança de head e vem ligado por padrão. A auditoria precisa ser refeita — não
existe reaproveitamento de aprovação antiga.

---

## Pausa, retomada e cancelamento seguro

```bat
PAUSAR.cmd            :: solicita pausa; nada é apagado
RETOMAR.cmd           :: continua de onde parou
CANCELAR-ETAPA.cmd    :: cancelamento seguro da execução atual
```

Garantias:

- **Pausar** grava a solicitação no estado. A etapa em andamento termina de
  forma limpa; código, worktree, branch, commits e logs são preservados.
- **Retomar** encontra a execução em `INTERRUPTED`, `BLOCKED`, `CI_FAILED`,
  `AUTH_REQUIRED` ou `USAGE_LIMIT_REACHED` e continua dali. **Prompts já
  aprovados não são reexecutados.**
- **Cancelar** pede confirmação explícita e não executa nenhum reset
  destrutivo, nenhuma limpeza e nenhuma remoção. Nada do seu trabalho é perdido.
- `Ctrl+C` durante uma execução é tratado como interrupção: os processos filhos
  são encerrados e o estado é gravado antes da saída.

Todo o estado fica em `data/projects/<id>/state/<runId>.json`, escrito de forma
atômica (arquivo temporário + `rename`), de modo que uma queda de energia não
deixa um estado meio gravado.

---

## Logs, relatórios e artefatos

| Caminho | Conteúdo |
| --- | --- |
| `data/projects/<id>/logs/` | Logs estruturados por execução |
| `data/projects/<id>/state/<runId>.json` | Estado completo, com a linha do tempo de eventos |
| `data/projects/<id>/artifacts/<runId>/<promptId>/attempt-N/` | `stdout`/`stderr` de cada invocação de IA e da suíte de testes |
| `data/projects/<id>/artifacts/<runId>/merge-audit/<auditor>-<sha>/` | Saída bruta das auditorias de merge |
| `data/projects/<id>/reviews/` | Revisões em JSON validadas por schema |
| `data/projects/<id>/reports/.../relatorio.json` | Relatório da execução em JSON |
| `data/projects/<id>/reports/.../relatorio.md` | Mesmo relatório em Markdown |
| `data/projects/<id>/reports/.../relatorio.html` | Mesmo relatório em HTML para abrir no navegador |

Todo texto gravado passa por **redação de segredos**: valores que se pareçam com
tokens são substituídos antes de chegar ao disco. O OrqPEG nunca grava o valor
de uma variável de API — apenas o nome dela, quando precisa avisar você.

---

## Limites de assinatura

O OrqPEG consome as suas assinaturas **Claude Max** e **ChatGPT Plus**, que têm
limites de uso por janela de tempo. Não há cobrança por token, e não há como o
OrqPEG "comprar mais": ele apenas detecta e reage.

| Situação | Estado da execução | O que fazer |
| --- | --- | --- |
| Limite de uso atingido | `USAGE_LIMIT_REACHED` | Espere a janela reabrir e use `RETOMAR.cmd` |
| Sessão expirada / não autenticado | `AUTH_REQUIRED` | Autentique o CLI correspondente e retome |

Em ambos os casos nada é perdido: o trabalho aprovado, os commits, o worktree e
os artefatos continuam onde estão. Como cada prompt vira um commit próprio, a
retomada nunca refaz trabalho já aprovado.

Recomendações práticas: divida trabalhos grandes em vários prompts pequenos,
prefira executar um projeto por vez e use o dry-run antes de gastar uma janela
de uso.

---

## Os 16 comandos `.cmd`

Todos abrem por duplo clique na pasta `C:\OrqPEG`.

| # | Arquivo | O que faz |
| --- | --- | --- |
| 1 | `ORQPEG.cmd` | Abre o menu interativo principal |
| 2 | `INSTALAR-E-CONFIGURAR.cmd` | Prepara `config/`, `data/` e a configuração padrão |
| 3 | `ABRIR-PAINEL.cmd` | Abre o navegador no painel local |
| 4 | `INICIAR-PAINEL.cmd` | Sobe o servidor do painel em `127.0.0.1:8765` |
| 5 | `PARAR-PAINEL.cmd` | Encerra o servidor do painel |
| 6 | `CADASTRAR-PROJETO.cmd` | Assistente de cadastro de projeto |
| 7 | `EDITAR-PROJETO.cmd` | Edita um projeto já cadastrado |
| 8 | `REMOVER-PROJETO.cmd` | Remove o cadastro (o repositório não é apagado) |
| 9 | `LISTAR-PROJETOS.cmd` | Lista os projetos e a contagem de prompts |
| 10 | `EXECUTAR-DRY-RUN.cmd` | Simula a execução inteira sem alterar nada |
| 11 | `EXECUTAR.cmd` | Executa o projeto de verdade |
| 12 | `PAUSAR.cmd` | Solicita pausa segura |
| 13 | `RETOMAR.cmd` | Retoma a execução preservada |
| 14 | `STATUS.cmd` | Situação atual de projetos e execuções |
| 15 | `DIAGNOSTICO.cmd` | Diagnóstico completo do ambiente |
| 16 | `CANCELAR-ETAPA.cmd` | Cancelamento seguro (nada é apagado) |

Equivalentes na linha de comando:

```bat
node dist\cli\main.js menu
node dist\cli\main.js panel start
node dist\cli\main.js project list
node dist\cli\main.js run meu-projeto --dry-run
node dist\cli\main.js run meu-projeto
node dist\cli\main.js pause meu-projeto
node dist\cli\main.js resume meu-projeto
node dist\cli\main.js cancel meu-projeto
node dist\cli\main.js status
node dist\cli\main.js doctor --json
node dist\cli\main.js docs
node dist\cli\main.js version
```

Códigos de saída: `0` sucesso, `1` falha, `2` uso incorreto.

---

## Solução de problemas

### Node.js ausente ou versão antiga

Sintoma: `'node' não é reconhecido como um comando` ou o diagnóstico acusa
versão abaixo de 20.

```bat
node --version
```

Instale o Node.js 20 LTS ou superior (<https://nodejs.org>), **feche e reabra**
o terminal (o `PATH` só é relido em uma sessão nova) e rode `DIAGNOSTICO.cmd`.

### `gh` não autenticado

Sintoma: erros com código `GH_FAILED` ou `AUTH_REQUIRED` ao criar a PR, ler os
checks ou fazer merge.

```bat
gh auth status
gh auth login
gh auth status --show-scopes
```

O escopo `repo` é necessário. Sem `gh` autenticado, a execução até roda, mas
para antes de `CREATING_PR`.

### Codex CLI ausente (o caso desta máquina)

Sintoma: o diagnóstico marca `codex` como indisponível; o gate 14
`CODEX_MERGE_APPROVED` reprova; o consenso não é alcançado; o merge não acontece.

Isto **não é um defeito**: é a regra "nunca aprovar merge com uma IA só" em
funcionamento.

Opções:

1. Instalar o Codex CLI e autenticar com **"Sign in with ChatGPT"**. Depois:
   ```bat
   codex --version
   DIAGNOSTICO.cmd
   RETOMAR.cmd
   ```
2. Enquanto isso, trabalhar com `merge.mode` em `manual`: o OrqPEG executa,
   testa, commita, faz push e abre a PR, e você faz o merge pelo GitHub depois
   de revisar. A auditoria dupla continua indisponível — e o produto não finge
   que ela aconteceu.

### Porta 8765 ocupada

Sintoma: o painel não sobe, ou o diagnóstico reporta a porta em uso.

```bat
netstat -ano | findstr :8765
tasklist /FI "PID eq <PID>"
```

Se for uma instância antiga do próprio painel, feche a janela dela. Se for outro
programa, mude a porta em `config\global.json`:

```json
{ "panel": { "host": "127.0.0.1", "port": 8790, "openBrowserOnStart": true } }
```

O `host` só aceita `127.0.0.1` ou `localhost`; qualquer outro valor faz o
servidor recusar a inicialização, por design.

### Lock abandonado

Sintoma: erro `LOCK_HELD` dizendo que outra execução está em andamento, mas não
há nenhuma.

O OrqPEG usa locks com *heartbeat*. Um lock é considerado abandonado quando o
processo dono não existe mais, quando o hostname não bate, ou quando o heartbeat
está parado há mais de **15 minutos** — e nesse caso ele é retomado
automaticamente.

Se o problema persistir:

```bat
DIAGNOSTICO.cmd
dir C:\OrqPEG\data\locks
```

O diagnóstico lista cada lock com PID, escopo, operação e idade do heartbeat.
Confirme que o PID não está mais rodando (`tasklist /FI "PID eq <PID>"`) antes
de remover o arquivo de lock correspondente.

### Limite de uso da assinatura atingido

Sintoma: execução em `USAGE_LIMIT_REACHED`, com a mensagem do CLI capturada nos
artefatos.

Nada foi perdido. Espere a janela de uso reabrir e rode `RETOMAR.cmd`. Prompts
já aprovados não são reexecutados. Se acontecer com frequência, quebre os
prompts em unidades menores.

### Worktree sujo

Sintoma: `WORKTREE_FAILED` informando que já existe um worktree no caminho, que
a branch já existe, ou que há alterações não commitadas.

O OrqPEG **não** limpa nem descarta nada — essa é a garantia central do produto.
Resolva você, com plena consciência do que está fazendo:

```bat
cd /d E:\AI-Worktrees\meu-projeto\orqpeg-meu-projeto-run-<stamp>
git status
git stash list
```

Depois de salvar ou commitar o que interessa, remova o worktree pelo Git
(`git worktree remove <caminho>`, sem `--force`) ou habilite
`worktree.reuseWhenSafe` no projeto para permitir o reaproveitamento quando for
seguro. Nunca use `git clean` ou `git reset --hard` "por precaução": eles apagam
trabalho de forma irreversível.

### Chave de API detectada no ambiente

Sintoma: a execução é bloqueada com a lista de **nomes** de variáveis presentes.

Isso é a guarda de zero API funcionando. Você pode:

- confirmar a continuação — o filho roda com ambiente sanitizado e sua sessão do
  Windows continua intacta; ou
- remover a variável da sua sessão, se ela não for necessária.

O OrqPEG nunca lê, grava ou imprime o **valor** dessas variáveis.

---

## Licença

MIT. Consulte também `CHANGELOG.md` e o guia visual offline `COMECE-AQUI.html`.
