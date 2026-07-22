# Changelog

Todas as mudanças relevantes deste projeto são documentadas neste arquivo.

O formato segue [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/) e o
versionamento segue [Semantic Versioning](https://semver.org/lang/pt-BR/).

## [1.0.0] - 2026-07-21

Primeira versão do OrqPEG, o orquestrador local que coordena os executáveis
`claude` e `codex` para executar, revisar, testar e integrar trabalhos em
repositórios Git já existentes na máquina do usuário.

### Added

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

- **O Codex CLI não está instalado nesta máquina.** Consequência direta: a
  auditoria dupla fica **bloqueada**, o gate 14 `CODEX_MERGE_APPROVED` reprova, o
  consenso não é alcançado e **nenhum merge automático acontece**. Isso é o
  comportamento correto: o OrqPEG jamais aprova merge com apenas uma IA. Para
  desbloquear, instale o Codex CLI e autentique com "Sign in with ChatGPT".
  Enquanto isso, use `--dry-run` ou `merge.mode: "manual"` e faça o merge pelo
  GitHub após sua própria revisão.
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
