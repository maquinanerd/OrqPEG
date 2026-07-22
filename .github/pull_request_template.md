# Descrição

<!-- O que muda e por quê. Uma frase de resultado observável, seguida do contexto necessário. -->

## Prompts e escopo

- Prompts cobertos por esta PR:
- Escopo declarado:
- Fora do escopo (não tocado nesta rodada):

## Arquivos alterados

<!-- Lista dos caminhos criados, modificados e removidos, com o motivo de cada um. -->

## Como validar

```bat
npm ci
npm run build
npm run typecheck
npm test
node scripts/security-check.js
```

Resultado obtido:

---

## Checklist — execução e revisão

- [ ] Todos os prompts desta rodada estão aprovados pelo revisor (`ALL_PROMPTS_APPROVED`)
- [ ] Existe commit para cada prompt aprovado (`ALL_COMMITS_CREATED`)
- [ ] A branch foi enviada ao remoto correto (`BRANCH_PUSHED_TO_CORRECT_REMOTE`)
- [ ] Esta PR está aberta contra a base correta (`PR_OPEN`, `PR_BASE_CORRECT`)
- [ ] Não há conflitos com a base (`NO_CONFLICTS`)
- [ ] Os testes locais do projeto passaram (`LOCAL_TESTS_PASSED`)
- [ ] Todos os checks obrigatórios passaram, nenhum pendente e nenhum ignorado
      (`REQUIRED_CHECKS_PASSED`, `NO_PENDING_REQUIRED_CHECKS`, `NO_SKIPPED_REQUIRED_CHECKS`)
- [ ] Não há threads de revisão em aberto (`NO_UNRESOLVED_THREADS`)
- [ ] Nenhuma revisão humana pedindo mudanças está pendente (`NO_HUMAN_CHANGES_REQUESTED`)

## Checklist — auditoria dupla

- [ ] Auditoria do Claude com veredito `APPROVED_FOR_MERGE` (`CLAUDE_MERGE_APPROVED`)
- [ ] Auditoria do Codex com veredito `APPROVED_FOR_MERGE` (`CODEX_MERGE_APPROVED`)
- [ ] As duas auditorias revisaram o mesmo head SHA (`AUDITORS_SAME_HEAD_SHA`)
- [ ] As duas atingiram a confiança mínima do projeto (`MINIMUM_CONFIDENCE_MET`)
- [ ] Nenhuma das duas registrou problema bloqueador (`NO_BLOCKING_ISSUES`)
- [ ] O head SHA não mudou depois das auditorias (`HEAD_SHA_UNCHANGED`)
- [ ] A base não mudou de forma invalidante (`BASE_NOT_INVALIDATED`)

> Se o Codex CLI não estiver instalado e autenticado, o gate `CODEX_MERGE_APPROVED`
> reprova e o merge automático não acontece. Isso é o comportamento correto:
> o OrqPEG nunca aprova merge com apenas uma IA.

## Checklist — regras invioláveis do produto

- [ ] Nenhuma dependência de runtime adicionada (`"dependencies"` continua vazio)
- [ ] Nenhum SDK de IA, nenhuma chamada a endpoint de API de IA, nenhuma leitura de API key
- [ ] Nenhum `shell: true`, `exec`/`execSync` ou concatenação de linha de comando
- [ ] Nenhum comando Git destrutivo (`push --force`, `reset --hard`, `git clean`, `branch -D`)
- [ ] O painel continua escutando apenas em `127.0.0.1`
- [ ] Nenhum segredo commitado; nenhum valor de variável de API lido, gravado ou logado
- [ ] TypeScript estrito respeitado: sem `any`, índices possivelmente indefinidos tratados
- [ ] Erros esperados devolvidos como `Result` via `ok`/`fail`, nunca como exceção
- [ ] Tipos importados de `src/types.ts`; nenhum tipo redefinido localmente
- [ ] Caminhos compostos com `path.join`/`path.resolve`, funcionando com espaços e acentos
- [ ] Comentários e mensagens ao usuário em português do Brasil
- [ ] Sem `TODO`, `FIXME`, função vazia, stub, placeholder ou dado fictício em produção
- [ ] Documentação atualizada quando o comportamento visível mudou
      (`README.md`, `CHANGELOG.md`, `COMECE-AQUI.html`)

## Riscos e limitações

<!-- O que pode quebrar, qual o impacto, como detectar. O que ficou de fora e por quê. -->
