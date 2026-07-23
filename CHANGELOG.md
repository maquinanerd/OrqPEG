# Changelog

Todas as mudanças relevantes deste projeto são documentadas neste arquivo.

O formato segue [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/) e o
versionamento segue [Semantic Versioning](https://semver.org/lang/pt-BR/).

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
- Bloco renderizado entra na instrução do executor, do corretor e do revisor.
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
