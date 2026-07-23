# Changelog

Todas as mudanças relevantes deste projeto são documentadas neste arquivo.

O formato segue [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/) e o
versionamento segue [Semantic Versioning](https://semver.org/lang/pt-BR/).

## [Não publicado]

### Fixed

#### Pausa e cancelamento passam a interromper de verdade

- **`handlePause`/`handleCancel` e os comandos da CLI gravavam uma marca no
  `RunRecord` que a execução em curso nunca relia.** O `AbortController` do
  painel não chegava a lugar nenhum (`abortRun` sequer tinha chamador), e o
  único ponto que consultava a intenção era o topo do laço de prompts — depois
  de a etapa em andamento ter rodado até o fim. Na prática: botão apertado,
  Claude, Codex ou a suíte de testes seguindo por até 60 minutos.
- Novo `execution/run-control`: registro em memória, publicado pelo próprio
  orquestrador, com `AbortController`, promessa de término, etapa corrente e
  identidade da execução. Vale para execuções do painel **e** da CLI — antes só
  as do painel apareciam em algum mapa.
- Novo `execution/intent-watcher`: vigília da intenção PERSISTIDA, que é o que
  faz `PAUSAR.cmd`, rodando em outro processo, interromper a etapa em curso de
  uma rodada hospedada no painel. Não é polling entre etapas: ao detectar a
  intenção, aborta na hora e derruba a árvore de processos.
- O `AbortSignal` do controlador é propagado a **toda** chamada de agente e de
  suíte de testes, e a interrupção é consultada entre as etapas INTERNAS de uma
  tentativa — antes do Claude, depois do Claude, antes e depois dos testes,
  antes e depois do Codex, antes do commit, do push, da PR, das auditorias e do
  merge. Nenhuma etapa começa depois de a intenção ter sido aceita.
- Cancelamento termina em `CANCELLED` e é idempotente: pedir de novo responde
  sucesso, não gera segunda transição e não altera o registro.
- `Ctrl+C` no painel agora **aguarda** o término real das execuções antes de
  fechar (`shutdownRuns`), em vez de apenas sinalizar e sair deixando filhos
  vivos.
- Operações Git curtas (`add`, `commit`, `push`) continuam **não** recebendo o
  sinal, por decisão explícita: matar um `git commit` a meio caminho deixaria
  `.git/index.lock` e destruiria o worktree que a pausa existe para preservar.
  Elas são bloqueadas antes de começar.

#### A API não reporta mais sucesso pelo que não fez

- `POST /pause` e `POST /cancel` descartavam o `Result` de `saveRun` e
  respondiam `200` incondicionalmente. Agora: `500` quando a intenção não pôde
  ser persistida (e nada é interrompido), `200` só depois que um controlador
  vivo aceitou o pedido, e `202` quando houve apenas registro — a rodada está
  em outro processo e ninguém aqui pode afirmar que o processo filho parou.
- `POST /cancel` sobre uma execução já cancelada respondia `404`. Agora
  responde `200` com `alreadyCancelled: true`.

#### O `catch` do orquestrador não apaga mais o progresso

- O `catch` externo gravava a referência de `run` capturada **antes** da
  pipeline. Como a pipeline reatribui uma variável local, uma exceção no
  terceiro prompt sobrescrevia o estado com a cópia inicial e apagava os dois
  prompts aprovados e seus commits — e a retomada refazia trabalho aprovado.
  Agora o registro é RELIDO do disco e a falha é acrescentada a ele.
- Se a exceção veio de uma parada pedida pelo usuário, o desfecho honra a
  intenção (`CANCELLED`/`INTERRUPTED`) em vez de rotular tudo como `FAILED`.

#### Estado persistido com revisão monotônica

- Novo campo `RunRecord.revision`, incrementado a cada gravação bem-sucedida.
  Execuções gravadas antes dele entram na revisão zero.
- `saveRun` passa a devolver `Result<RunRecord>` com o registro REALMENTE
  gravado: é por esse retorno que o orquestrador enxerga, na etapa seguinte,
  uma pausa pedida pelo painel no meio de uma chamada de IA.
- A intenção de pausa/cancelamento é **monotônica**: nenhuma gravação a apaga.
  Só a retomada limpa a folha, gravando em modo `REPLACE` — e o faz de forma
  deliberada e registrada.
- Gravação obsoleta que apagaria commits, aprovações de prompt ou um estado
  terminal é recusada com o novo código `STATE_REGRESSION`, em vez de aceita em
  silêncio.
- Novos `recordRunIntent` e `readPersistedIntent`.
- A exclusão mútua que torna isso um compare-and-swap de verdade veio na
  correção descrita mais abaixo; a revisão sozinha não fechava a corrida.

#### Retomada não duplica trabalho

- `commitPrompt` recusa criar um segundo commit para um prompt que já tem
  commit no registro. O caso real: a execução parou depois do commit e antes de
  o estado alcançar a etapa seguinte; ao retomar, a tentativa recomeçava e
  produzia um commit duplicado na branch que segue para o merge.
- Uma tentativa abortada devolve o prompt de `RUNNING` para `PENDING`, sem
  zerar o contador de tentativas: a tentativa custou assinatura e a retomada
  não finge que ela não existiu.

#### Falha de escrita não é mais descartada

- O `Result` de `saveRun` deixou de ser ignorado em todo o produto: rotas,
  comandos da CLI e orquestrador tratam a falha. A forma final desse tratamento
  no orquestrador — `persistCheckpoint`, fail-closed — está descrita abaixo.

#### Exclusão mútua de verdade na escrita de estado

- O que a versão anterior chamava de compare-and-swap era `ler → comparar
  revisão → gravar`, SEM exclusão mútua. Comparar revisões só detecta quem já
  está atrasado; dois processos que leem a MESMA revisão não têm o que
  detectar, e o segundo a gravar apagava o primeiro. Uma pausa vinda de
  `PAUSAR.cmd` podia desaparecer.
- Novo `state/state-lock`: lock de arquivo SÍNCRONO e entre processos
  (`openSync(..., 'wx')`, atômico no NTFS), com identidade, detecção de lock
  abandonado por pid e por idade, teto de espera e liberação garantida no
  `finally`. `EPERM`/`EACCES`/`EBUSY` — que é como o Windows relata a disputa
  quando o arquivo está em exclusão pendente — contam como disputa, não como
  falha dura.
- `saveRun`, `recordRunIntent` e o novo `mutateRun` fazem leitura, comparação,
  reconciliação e escrita INTEIRAMENTE dentro do lock.
- As rotas do painel e os comandos da CLI passaram a usar `recordRunIntent` em
  vez de `findActiveRun → requestPause → saveRun`, que lia fora e gravava
  depois.

#### Falha de persistência é parada, não aviso

- O erro de escrita ficava num campo do contexto e o fluxo seguia: testes,
  pacote de auditoria, Codex, aprovação e commit aconteciam com o disco parado
  numa versão antiga — podendo criar um commit que o estado não conhece.
- Novo `persistCheckpoint`, que devolve `Result<RunRecord>` e obriga o chamador
  a tratar a falha. Aplicado em todos os pontos que precedem efeito: validação,
  branch e worktree, relógio da tentativa, entrada em `RUNNING_CLAUDE`,
  contabilização do Claude, entrada em `RUNNING_TESTS`, montagem do pacote,
  entrada em `RUNNING_CODEX`, contabilização do Codex, assinaturas, aprovação,
  entrada em `COMMITTING`, registro do commit, suíte completa, push, PR, espera
  do CI, reparo de CI, auditorias, consenso, `MERGE_APPROVED`, `MERGING` e
  registro do merge.
- `saveStop` ficou restrito ao que era seu papel legítimo: gravar um estado de
  parada, quando não há mais etapa depois.

#### Diário de commits: a queda entre `git commit` e `saveRun`

- A guarda contra commit duplicado consultava apenas `run.commits`. Ela não
  cobria a janela em que o commit existe no Git e ainda não existe no registro:
  na retomada, o prompt era refeito e commitado de novo.
- Novo `state/commit-journal`, um write-ahead log com `fsync`: a intenção é
  gravada ANTES do Git, o commit carrega os carimbos `OrqPEG-Run-Id`,
  `OrqPEG-Prompt-Id`, `OrqPEG-Attempt` e `OrqPEG-Operation-Id` (128 bits
  aleatórios), e a entrada só é encerrada depois de o SHA chegar ao estado.
- `reconcileCommitJournal` roda antes do laço de prompts e adota um commit
  órfão mediante TRÊS provas: carimbo de operação conferente, alcançabilidade a
  partir do HEAD (`baseCommitSha..HEAD`) e alteração de ao menos um arquivo. A
  mensagem humana nunca é usada como identidade.
- Vale também para os commits de reparo de CI e de correção pós-auditoria.
- Novas portas `listCommitsSince` e `commitChangedFiles`.

#### Mensagem de commit multilinha no Windows

- `git commit --message` com quebras de linha perdia tudo depois da primeira
  linha: no Windows o `git` é encaminhado por `cmd.exe`, que não carrega
  quebras de linha dentro de um argumento. Os carimbos do rodapé eram
  descartados em silêncio. Mensagens multilinha passam por `--file`.

#### O SHA-base deixa de ser recalculado na retomada

- `prepare` recalculava `baseCommitSha` a cada retomada, rebaseando a execução
  em silêncio: o diff entregue aos auditores passava a ser medido contra um
  ponto mais recente, inclusive contra commits que a própria execução criara.
  Agora ele é congelado na primeira preparação.

#### A fronteira HTTP para de afirmar o que não sabe

- O controlador vivo é consultado ANTES do `RunRecord`. Um pedido chegado na
  janela entre o início da execução e a criação do registro deixou de responder
  `404`.
- `abort()` envia o sinal; a árvore leva um tempo real para morrer. A resposta
  agora confirma o término (`awaitRunSettled`, com teto de 3 s) e distingue os
  desfechos: `intentPersisted`, `accepted` e `terminated` são campos separados,
  e `202` significa "aceito, encerramento em andamento".

### Added

- 68 testes novos no total das duas rodadas (439 → 507), todos contra o código
  compilado:
  - `tests/e2e/pause-cancel-control.test.js` (15), `tests/unit/process-tree-kill.test.js` (4),
    `tests/integration/run-state-cas.test.js` (12) e
    `tests/integration/panel-pause-cancel-routes.test.js` (10): processos REAIS,
    com PID, neto e testemunhas irmãs que precisam sobreviver;
  - `tests/integration/state-write-race.test.js` (6): corrida REAL entre
    processos Node separados, sincronizados por barreira de arquivo, repetida
    oito vezes por cenário. Com o lock desativado, cinco dos seis reprovam;
  - `tests/e2e/crash-after-commit.test.js` (2): repositório Git real e queda
    real (`process.exit`) entre o commit e a gravação do estado;
  - `tests/e2e/persistence-fail-closed.test.js` (9): falha de escrita injetada
    em nove pontos distintos, com contadores provando que nenhuma etapa
    posterior aconteceu;
  - `tests/unit/run-control-semantics.test.js` (10): os três desfechos da
    confirmação de término e a janela anterior ao `runId`.

## [1.0.0] - 2026-07-22

Primeira versão do OrqPEG, o orquestrador local que coordena os executáveis
`claude` e `codex` para executar, revisar, testar e integrar trabalhos em
repositórios Git já existentes na máquina do usuário.

Fechamento do escopo do OrqPEG 1.0. Tudo aqui existe para uma finalidade só:
**nenhuma repetição do produto é ilimitada, e nenhuma parada é anônima.**

### Added

#### Política efetiva congelada

- `EffectiveExecutionPolicySnapshot` resolvido **uma única vez** antes de
  `createRun()`, com precedência `rodada > projeto > global > padrões do
  produto`, e guardado em `RunRecord.effectivePolicy`.
- Congela `loopGuard`, `ci`, `mergeAudit`, `commands`, `agents` (modelo já
  resolvido contra o padrão global), `git`, `pullRequest`, `merge`,
  `repository` e `worktree`.
- Dois hashes com papéis distintos: `effectiveHash` identifica a política e é
  comparável entre execuções; `integrityHash` sela o snapshot inteiro,
  `sourceMetadata` inclusive.
- Camada global opcional em `GlobalConfig.loopGuard`.
- Camada de rodada declarada em `roundConfig`, no corpo de
  `POST /api/projects/:id/run`. A rodada é propriedade da execução e não do
  cadastro: dois disparos do mesmo projeto podem ter tetos diferentes sem que
  nada em disco mude. Com o campo declarado, `roundConfigHash` passa a valer
  em `effectivePolicy.sources` e em `sourceSnapshots`; omitido, permanece
  `null` — "esta execução não tem rodada", que não é "rodada vazia".
- A fronteira da rodada **recusa** em vez de corrigir: campo desconhecido,
  tipo errado, valor fora de faixa e `roundId` fora do alfabeto de
  identificadores devolvem `400` nomeando o campo. `roundConfig` junto de
  `resumeRunId` devolve `409`, porque a retomada roda sob a política congelada
  quando a execução começou.
- Mínimos numéricos do Loop Guard centralizados em `LOOP_GUARD_MINIMUMS`, lida
  pela normalização (para corrigir o valor de disco) e pela fronteira de rodada
  (para recusar o da requisição). Enquanto cada uma tinha a própria cópia,
  `maxClaudeCallsPerPrompt: 0` atravessava a fronteira e virava `1` depois — o
  clamp silencioso que a recusa existe para impedir.

#### Skills locais na execução

- As Skills declaradas em `roundConfig.skills` passam a ser **resolvidas,
  congeladas e injetadas** de fato. Antes o módulo existia completo e testado,
  mas nenhuma de suas funções era chamada pelo orquestrador: nenhuma Skill
  chegava a agente nenhum.
- Resolução acontece **antes de a execução existir**: Skill ausente, versão
  divergente, status não aprovado ou agente incompatível interrompem sem criar
  registro. Manifesto malformado no catálogo é reportado junto, para que a
  mensagem não diga "Skill ausente" quando o problema é um `skill.json`
  quebrado.
- O congelado vai para `RunRecord.skills` com id, versão e hash — não o texto.
  O conteúdo é relido do catálogo e conferido contra o hash antes de cada uso.
- Bloco renderizado entra na instrução de quem produz ou julga o código da
  branch: executor, os três corretores (laço de prompt, reparo de CI e correção
  pós-auditoria) e revisor. As duas auditorias finais de merge ficam de fora de
  propósito — elas julgam em sessão limpa, e entregar a elas o documento que
  orientou quem escreveu o código enfraqueceria a independência do consenso.
- O congelamento cobre o `SKILL.md` **e** o manifesto (`manifestHash`): `name` é
  renderizado no bloco entregue ao agente, e `status`/`compatibleAgents` são a
  autorização que permitiu ativar a Skill. A conferência devolve as Skills que
  verificou, e o render usa esses objetos — o catálogo é lido uma vez só, sem
  janela entre conferir e usar.
- Gatilho novo `SKILL_CHANGED_DURING_RUN`: editar uma Skill no meio da execução
  para a rodada. É **hard stop** declarado e **não admite override**, pela mesma
  razão de `PROMPT_CHANGED_DURING_RUN` — a tentativa anterior já rodou sob o
  documento antigo.

#### Painel

- Defesa contra CSRF nos métodos que alteram estado. A validação de `Host`
  cobria DNS rebinding, não CSRF: numa requisição disparada por outra página o
  `Host` é justamente o do painel. Com a porta padrão fixa e documentada,
  qualquer site aberto enquanto o painel rodava alcançava criação de projeto,
  alteração de `merge.mode`, disparo de execução e concessão de override.
  Agora `Sec-Fetch-Site` e `Origin` são verificados, e corpo presente exige
  `Content-Type: application/json` — o que elimina a forma "simple request",
  que o navegador entrega sem preflight.
- `POST /api/projects/:id/runs/:runId/materialize-policy` para execuções
  legadas, com confirmação explícita e marca de procedência.

#### Orçamento de CI

- `EffectiveCiPolicy` com `maxRepairCycles`, `pollingInitialSeconds`,
  `pollingMaxSeconds`, `waitTimeoutMinutes` e `stopOnRepeatedFailure`.
- Espera com relógio **histórico** persistido (`CiWaitState`): reiniciar o
  painel não renova o prazo.
- Polling com backoff limitado. Nenhuma chamada de IA enquanto os checks
  estiverem apenas pendentes.
- Fingerprint normalizado de falha de CI, que descarta run ID, timestamps,
  duração, URLs efêmeras, SHAs, UUIDs e caminhos de runner.
- Ciclos de reparo com testes locais antes do push e artefatos append-only em
  `artifacts/<run-id>/ci-repairs/cycle-NNN/`.

#### Orçamento de auditoria final

- `EffectiveMergeAuditPolicy.maxCorrectionCycles`.
- Distinção entre pedido de mudança (corrigível, consome ciclo) e bloqueio
  estrutural (CI vermelho, conflito, auditor ausente — não consome).
- Invalidação das aprovações **antes** da correção começar; cada correção
  dispara CI novo antes de reauditar.
- Artefatos em `artifacts/<run-id>/merge-corrections/cycle-NNN/`.

#### Pacotes curados

- Importador que lê `PROJECT-CONTEXT.md`, `ROADMAP.md`, `VALIDATION.md`,
  `execution-plan.json` e `rounds/*/round.json` + prompts.
- Valida e **recusa**; nunca completa, reescreve ou conserta. Relata todos os
  problemas de uma vez.
- Exige `validation.status = "approved"` e `validatedCommitSha`.
- A origem nunca é tocada. Reimportar exige versão nova ou intenção explícita;
  o pacote anterior vai para `package-anterior/<versão>-<carimbo>`.

#### Skills locais

- Catálogo declarativo em `skills/<categoria>/<id>/{skill.json,SKILL.md}`.
- Ativação só explícita, no formato `<id>@<versão>`.
- `executeScripts` e `networkAccess` verdadeiros são recusados na leitura.
- Skills congeladas por execução e conferidas por hash: ausência, versão
  divergente ou edição durante a execução bloqueiam.
- Sem marketplace, sem download, sem descoberta automática.

### Changed

- Gatilhos novos: `PROJECT_CONFIG_CHANGED`, `POLICY_SNAPSHOT_MISSING`,
  `CI_REPAIR_BUDGET_EXHAUSTED`, `CI_CONFIGURATION_ERROR` e
  `CI_REQUIRED_CHECK_MISSING`.
- Artefatos de parada do Loop Guard passam a `stops/stop-NNN/`, append-only e
  encadeados por `previousStopHash`.
- Concessão de override sob lock persistente de escopo `run`, com releitura
  garantida estruturalmente por `withRunLocked`.
- `schemas/state.schema.json` sincronizado com o `RunRecord` real.

### Fixed

- Edição do `project.json` deixa de alterar retroativamente os limites de uma
  execução em curso — inclusive o número de overrides disponíveis.
- Detecção de mutação de configuração deixa de ser código morto: o hash "de
  agora" passa a vir do disco, não do objeto em memória que originou o
  snapshot.
- `prepare()` não recaptura mais os hashes na retomada, o que apagava a
  evidência de que o cadastro havia sido editado.
- Adoção de worktree na retomada exige prova de propriedade; merge, cherry-pick
  e revert pela metade deixam de passar despercebidos.
- Artefatos de parada e de tentativa deixam de ser sobrescritos.

### Plataforma inicial

#### Núcleo e contrato

- Contrato de tipos único em `src/types.ts`, com `Result`/`OrqError` e 32 códigos
  de erro tipados, consumido por todos os módulos.
- Estilo de erro sem exceções para falhas esperadas: `ok(valor)` e
  `fail(CODE, mensagem, detalhes, causa)`.
- Escrita atômica de JSON e de artefatos (arquivo temporário + `rename`),
  resistente a interrupção no meio da gravação.
- Utilitários de tempo, ordenação natural, logger estruturado com escopo e
  redação de segredos aplicada a tudo que é gravado em disco.
- Zero dependências de runtime: apenas módulos nativos do Node
  (`node:fs`, `node:path`, `node:child_process`, `node:http`, `node:os`,
  `node:crypto`, `node:readline`).

#### Segurança

- Guarda de zero API de IA: detecta `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`,
  `CODEX_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `OPENAI_API_KEY_PATH` e
  `ANTHROPIC_ADMIN_KEY`, bloqueia a execução por padrão e **nunca** lê, grava ou
  imprime o valor de nenhuma delas — apenas o nome.
- Sanitização do ambiente de todo processo filho (IA e ferramentas), com remoção
  case-insensitive e verificação final `assertChildEnvIsClean` imediatamente
  antes do `spawn`. O ambiente do Windows do usuário não é alterado.
- Aviso sobre variáveis de roteamento (`ANTHROPIC_BASE_URL`, `OPENAI_BASE_URL`,
  `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX`, entre outras).
- Guarda de caminhos: validação de identificadores, resolução confinada a uma
  raiz e recusa de escape de diretório, com suporte a caminhos com espaços e
  acentos.
- Validação estrita de nomes de branch e geração de `orqpeg/<projeto>/run-<stamp>`.
- Todo processo externo executado com `spawn` e vetor de argumentos: sem
  `shell: true`, sem `exec`/`execSync`, sem concatenação de linha de comando.

#### Configuração e projetos

- Validador de JSON Schema próprio, sem dependências, e 6 schemas do produto:
  `project`, `state`, `prompt-review`, `claude-merge-review`,
  `codex-merge-review` e `merge-consensus`.
- Configuração global em `config/global.json` com fusão contra os padrões,
  recusa de host diferente de `127.0.0.1`/`localhost` e `allowForcePush` fixado
  em `false`, não configurável.
- Cadastro, edição, listagem e remoção de projetos. A remoção apaga apenas os
  dados operacionais do OrqPEG; o repositório do usuário permanece intacto.

#### Prompts

- Descoberta de prompts em `data/projects/<id>/prompts/` com ordenação natural
  por nome de arquivo.
- Parser tolerante de Markdown para o formato `TEMPLATE-PROMPT.md`, aceitando
  variações de título, acentuação, numeração e estilos de lista, e ignorando
  blocos de código cercados.
- Modelos incluídos: `TEMPLATE-PROMPT.md` e `TEMPLATE-PROJECT.json`.

#### Execução

- Runner de processos com timeout, captura limitada de saída, streaming
  incremental, `AbortSignal` e classificação de status
  (`COMPLETED`, `FAILED`, `TIMEOUT`, `INTERRUPTED`, `COMMAND_NOT_FOUND`).
- Detecção de ferramentas (`node`, `npm`, `git`, `gh`, `claude`, `codex`) com
  versão, caminho e situação de autenticação.
- Agentes com papéis separados: Claude executor e corretor (podem editar), Codex
  revisor de prompt e ambos como auditores de merge (somente leitura).
- Detecção de limite de uso da assinatura e de sessão expirada, mapeadas para os
  estados `USAGE_LIMIT_REACHED` e `AUTH_REQUIRED`.
- Orquestrador com máquina de estados de 26 estados, laço por prompt com
  tentativas configuráveis e parada opcional no primeiro veredito bloqueante.
- Modo `--dry-run` que descreve o plano completo sem alterar absolutamente nada.
- Suporte a worktree dedicado por execução, com reaproveitamento apenas quando
  seguro e sem nenhuma operação destrutiva.

#### Git, GitHub e merge

- Camada Git que oferece apenas operações não destrutivas: `push --force`,
  `reset --hard`, `git clean`, `branch -D` e `checkout --force` não existem no
  código.
- Integração com o GitHub CLI para abrir a Pull Request, acompanhar os checks
  obrigatórios e executar o merge.
- Revisão de prompt e auditorias de merge devolvidas como JSON e validadas
  contra schema antes de qualquer decisão.
- Consenso de duas IAs: só existe quando Claude e Codex aprovam o **mesmo** head
  SHA, com confiança mínima atingida e sem problemas bloqueadores.
- 20 gates de merge avaliados com evidência registrada; um único gate reprovado
  impede o merge, sem sobreposição possível.
- Invalidação automática de aprovações quando o head SHA muda.
- Merge idempotente com `--match-head-commit`: uma PR já mergeada nunca é
  mergeada de novo e o GitHub recusa o merge se o commit mudar.

#### Estado, locks e relatórios

- Estado de execução persistido por run, com linha do tempo de eventos.
- Locks por escopo (`project`, `worktree`, `run`, `pr`, `merge`, `state`) com
  heartbeat e detecção de lock abandonado após 15 minutos.
- Pausa, retomada e cancelamento seguro: nenhum reset destrutivo, nenhuma
  limpeza e nenhuma remoção de trabalho. Prompts já aprovados não são
  reexecutados na retomada.
- Relatórios por execução em JSON, Markdown e HTML.
- Artefatos por tentativa de prompt e por auditoria de merge.

#### Interface

- CLI em português com menu interativo e os comandos `menu`, `panel`, `project`,
  `run`, `pause`, `resume`, `cancel`, `status`, `doctor`, `docs`, `version` e
  `help`.
- 16 wrappers `.cmd` para operação por duplo clique no Windows.
- Painel local em `node:http` puro, escutando exclusivamente em `127.0.0.1`,
  com validação do cabeçalho `Host` contra DNS rebinding e API REST de projetos,
  execuções, consenso, relatórios e diagnóstico.
- Diagnóstico completo (`doctor`) cobrindo sistema, instalação, configuração,
  ferramentas, guarda de API, schemas, wrappers, projetos, locks, porta do
  painel e espaço em disco.

#### Documentação e CI

- `README.md` completo em português, `CHANGELOG.md` e guia visual offline
  `COMECE-AQUI.html`, autocontido e sem CDN.
- Workflow de CI em `windows-latest` com build, typecheck, testes e validação
  dos 6 schemas e dos 16 wrappers `.cmd`.
- Workflow de segurança que falha o build ao detectar chamada a endpoint de API
  de IA, import de SDK de provedor, dependência de runtime, uso de shell ou de
  comando Git destrutivo, segredo aparente commitado ou escuta em `0.0.0.0`.
- Modelo de Pull Request e modelos de issue alinhados aos gates do produto.

### Limitações conhecidas

- **A auditoria dupla exige os dois executáveis instalados e autenticados.** Sem
  o Codex CLI, o gate 14 `CODEX_MERGE_APPROVED` reprova, o consenso não é
  alcançado e **nenhum merge automático acontece**. Isso é o comportamento
  correto: o OrqPEG jamais aprova merge com apenas uma IA. Até instalar o Codex
  CLI e autenticar com "Sign in with ChatGPT", use `--dry-run` ou
  `merge.mode: "manual"` e faça o merge pelo GitHub após sua própria revisão.
- **A camada de rodada só é declarável pela API do painel.**
  `POST /api/projects/{id}/run` aceita `roundConfig`; a CLI não expõe o campo, e
  uma execução disparada por ela roda sem rodada e sem Skills —
  `roundConfigHash` e `skills` ficam `null`.
- **O teste de rodada real dubla as duas IAs e o GitHub.** O Git é real e os
  commits são reais, mas chamar Claude e Codex de dentro da suíte gastaria
  assinatura e exigiria rede para provar o que já é observável no disco.
- O produto é Windows-first. Em Linux e macOS a CLI funciona, mas os 16 wrappers
  `.cmd` não se aplicam e o diagnóstico registra um aviso de plataforma.
- O consumo depende das assinaturas Claude Max e ChatGPT Plus. Ao atingir o
  limite de uso da janela, a execução para em `USAGE_LIMIT_REACHED` e precisa ser
  retomada manualmente depois que a janela reabrir.
- A leitura de checks obrigatórios e o merge dependem do GitHub CLI autenticado
  com escopo `repo`. Sem isso, a execução para antes da criação da Pull Request.
- Não existe execução paralela de múltiplos projetos: os locks por escopo
  serializam propositalmente as operações que tocam o mesmo repositório.

[1.0.0]: https://github.com/maquinanerd/OrqPEG/releases/tag/v1.0.0
