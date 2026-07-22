# Identificação

ID: {{PROMPT_ID}}
Nome: {{PROMPT_NAME}}
Dependências: {{PROMPT_DEPENDENCIES}}

Regras desta seção:

- `ID` deve bater com o nome do arquivo sem extensão (ex.: arquivo `03-camada-http.md` → ID `03-camada-http`). O OrqPEG ordena os prompts por ordenação natural, então o prefixo numérico define a sequência de execução: `2-x.md` roda antes de `10-x.md`.
- `ID` só aceita letras, números, ponto, hífen e sublinhado, começando por letra ou número.
- `Nome` é o título legível exibido no painel, nos relatórios e no corpo da Pull Request.
- `Dependências` lista os IDs de prompts que precisam estar aprovados antes deste, separados por vírgula. Escreva `nenhuma` quando o prompt for independente.

---

# Objetivo

Uma frase declarando o resultado observável que este prompt entrega. Comece com um verbo no infinitivo e termine com o efeito verificável.

Exemplo de formulação correta: "Implementar o carregador de configuração de projeto para que `orqpeg run` recuse projetos com `baseBranch` inexistente antes de criar qualquer worktree."

Não misture dois objetivos no mesmo prompt. Se houver "e também", divida em dois arquivos de prompt.

---

# Contexto

Explique o estado atual do repositório e por que a mudança é necessária. Inclua:

- Qual comportamento existe hoje e onde ele está (arquivos e funções reais do repositório).
- Qual problema, limitação ou requisito de negócio motiva a alteração.
- Decisões já tomadas em prompts anteriores que a IA deve respeitar em vez de reabrir.
- Convenções do projeto que a IA precisa conhecer (padrão de erro, estilo de import, camadas, idioma dos comentários).

A IA executora abre uma sessão sem memória das anteriores. Tudo que não estiver escrito aqui não existe para ela.

---

# Escopo obrigatório

Lista numerada e fechada do que precisa ser feito. Cada item deve ser verificável por leitura de código ou por execução de teste.

1. Item concreto, citando arquivo e comportamento esperado.
2. Item concreto, citando arquivo e comportamento esperado.
3. Item concreto, citando arquivo e comportamento esperado.

Um item que não pode ser conferido objetivamente não pertence a esta seção — mova-o para `# Contexto` como orientação.

---

# Fora do escopo

Lista explícita do que a IA não deve tocar nesta rodada, mesmo que pareça uma melhoria óbvia. Exemplos de itens típicos:

- Refatorações de módulos não citados no escopo obrigatório.
- Renomear símbolos públicos já consumidos por outras partes do sistema.
- Atualizar dependências, versões de runtime ou configuração de build.
- Alterar formatação de arquivos que não fazem parte da mudança.
- Antecipar trabalho de prompts posteriores.

O revisor trata qualquer alteração fora do escopo como motivo de `CHANGES_REQUESTED`.

---

# Áreas permitidas

Caminhos, relativos à raiz do repositório, que a IA pode criar ou modificar. Use um caminho por linha e prefira granularidade de arquivo.

- `src/caminho/do/modulo.ts`
- `src/caminho/do/outro-modulo.ts`
- `tests/caminho/do/modulo.test.ts`

Se um caminho novo precisar ser criado, declare-o aqui antes, com o nome final desejado.

---

# Áreas proibidas

Caminhos que a IA não pode criar, editar ou remover em hipótese alguma nesta rodada.

- `src/types.ts` (contrato de tipos compartilhado)
- Arquivos de configuração de build e de CI
- Qualquer arquivo sob os diretórios de dados e artefatos gerados em execução
- Qualquer caminho não listado em `# Áreas permitidas`

Tocar em uma área proibida é falha bloqueante, independentemente da qualidade do código produzido.

---

# Requisitos funcionais

O que o sistema passa a fazer, do ponto de vista de quem usa. Escreva em forma de comportamento observável, com entrada e saída.

- Dado <estado inicial>, quando <ação>, então <resultado observável>.
- Dado <estado inicial>, quando <ação inválida>, então <erro específico com código e mensagem em português>.
- Casos de borda que precisam ser tratados: entrada vazia, caminho com espaços e acentos, arquivo ausente, execução repetida (idempotência).

---

# Requisitos técnicos

Como a implementação deve ser feita. Itens que costumam ser obrigatórios:

- Sem novas dependências de runtime; apenas módulos nativos do Node.
- TypeScript estrito: sem `any`, tratar índices possivelmente indefinidos, sem variáveis e parâmetros não usados.
- Erros esperados devolvidos como `Result` via `ok`/`fail`, nunca como exceção lançada.
- Tipos importados de `src/types.ts` com `import type`; nenhum tipo redefinido localmente.
- Processos externos executados com `spawn` e vetor de argumentos, sem `shell`, sem concatenação de comando.
- Caminhos sempre compostos com `path.join`/`path.resolve`, funcionando com espaços e acentos.
- Comentários e mensagens ao usuário em português do Brasil; identificadores em inglês.
- Nada de código morto, dados fictícios embutidos, funções vazias ou marcadores de trabalho pendente.

---

# Critérios de aceitação

Checklist binário. O prompt só é aprovado quando todos os itens forem verdadeiros e comprovados por evidência.

- [ ] Todos os itens de `# Escopo obrigatório` estão implementados e funcionando.
- [ ] Nenhum arquivo fora de `# Áreas permitidas` foi criado, alterado ou removido.
- [ ] Todos os comandos de teste do projeto passam localmente.
- [ ] Os requisitos funcionais foram exercitados por teste automatizado, inclusive os casos de erro.
- [ ] Nenhum comportamento existente regrediu.
- [ ] O relatório final lista arquivos alterados, decisões, testes e riscos.

---

# Testes obrigatórios

Descreva os testes que precisam existir ao final, não apenas os comandos a executar.

- Caso feliz: <descrição do cenário e da asserção principal>.
- Caso de erro: <entrada inválida> deve produzir falha com o código de erro esperado e sem lançar exceção.
- Caso de borda: caminho com espaços e acentos, entrada vazia, execução repetida.
- Regressão: <comportamento anterior que precisa continuar válido>.

Comandos que precisam terminar com sucesso: os definidos em `commands.tests` do `project.json` do projeto.

---

# Restrições

Restrições invioláveis desta rodada:

- Não fazer commit.
- Não fazer push.
- Não fazer merge.
- Não trocar de branch nem criar branch.
- Não alterar partes do sistema fora do escopo declarado.
- Não remover testes.
- Não reduzir, enfraquecer, marcar como ignorado nem afrouxar validações para obter aprovação.

Commit, push, Pull Request e merge são responsabilidade exclusiva do OrqPEG, e só acontecem depois da aprovação do revisor e dos gates de merge. Se um teste falha, a correção é no código de produção, não no teste.

---

# Evidências finais exigidas

O relatório final da IA executora deve conter, nesta ordem:

1. **Arquivos alterados** — lista completa de caminhos criados, modificados e removidos, com uma linha explicando o motivo de cada um.
2. **Decisões técnicas** — o que foi decidido, quais alternativas foram descartadas e por quê.
3. **Testes executados** — cada comando rodado, na íntegra, com o diretório de execução.
4. **Resultados dos testes** — status de cada comando e, em caso de falha, o trecho relevante da saída.
5. **Mapeamento com os critérios de aceitação** — cada critério marcado como atendido, com a evidência que o comprova.
6. **Limitações conhecidas** — o que ficou de fora, o que é parcial e o que depende de prompts futuros.
7. **Riscos** — o que pode quebrar, qual o impacto e como detectar o problema em produção.

Relatório sem evidência de teste executado é tratado como trabalho não concluído.
