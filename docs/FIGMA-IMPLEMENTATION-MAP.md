# Mapa de implementação — OrqPEG Dashboard (Figma)

Documento de rastreabilidade entre o arquivo oficial do Figma e o código do
painel. Toda medida aqui foi lida do MCP remoto do Figma, não estimada a partir
da imagem.

## 1. Origem

| Campo | Valor |
| --- | --- |
| Arquivo | <https://www.figma.com/design/CCyLaVcligzX9pmCJgqruV> |
| `fileKey` | `CCyLaVcligzX9pmCJgqruV` |
| Servidor MCP | remoto autenticado (`mcp.figma.com`) |
| Página | `OrqPEG — System & Dashboard` (`0:1`) — única página do documento |
| Frame | `OrqPEG / Master Canvas` |
| Node ID | `2:2` |
| Dimensões | 1920 × 1240 |
| Filhos diretos | 218 (`2:3` … `2:220`) |
| Variáveis Figma | nenhuma — `get_variable_defs` devolve `{}` |
| Estilos compartilhados | nenhum |
| Componentes | nenhum |

O frame é **inteiramente plano**: 218 nós irmãos posicionados em coordenadas
absolutas, sem grupos, sem auto-layout, sem componentes e sem variáveis. Toda a
hierarquia visual do desenho é implícita — deduzida de contenção geométrica.
A tokenização e a componentização abaixo foram derivadas por análise das
coordenadas, dos preenchimentos e da nomenclatura das camadas.

## 2. Tokens

### 2.1 Cor

Treze cores sólidas e uma sombra. A contagem é o número de nós que usam cada
valor no design context.

| Token | Hex | Usos | Papel no desenho |
| --- | --- | --- | --- |
| `--fig-ink` | `#0e0e0d` | 71 | Global Rail, texto primário, botão de recusa, pílula de marca |
| `--fig-muted` | `#75756e` | 27 | Texto secundário, legendas, metadados |
| `--fig-ink-soft` | `#252521` | 7 | Stat cards, faixa de tarefa em cartão escuro |
| `--fig-lime` | `#dbfa47` | 6 | Acento primário: projeto selecionado, cartão de aprovação, etapa aprovada |
| `--fig-paper` | `#f6f5f2` | 5 | App Shell, Context Panel, campo de mensagem, bolha do operador |
| `--fig-hairline` | `#e0e0d6` | 5 | Divisores, borda do Run Selector |
| `--fig-coral` | `#ff5e61` | 4 | Prioridade alta, pílula `LOCAL` |
| `--fig-lavender` | `#a896f0` | 4 | Etapa atual, estágio de execução, prioridade média |
| `--fig-ink-raised` | `#1b1b18` | 4 | Execution Sidebar, cartões de projeto não selecionados |
| `--fig-cyan` | `#78dbde` | 2 | Estágio de descoberta, prioridade baixa |
| `--fig-lime-deep` | `#c7e83b` | 1 | Faixa de tarefa sobre cartão lime |
| `--fig-mat` | `#b5ba9c` | 1 | Reference Backdrop (dispositivo de apresentação) |
| `--fig-canvas` | `#0a0a09` | 1 | Fundo do frame |
| `--fig-surface` | `#ffffff` | — | Cartões de evento, console, botões claros, pílulas neutras |

Sombra única: `0 18px 36px rgba(0, 0, 0, 0.14)` — aplicada ao Reference Backdrop
e ao App Shell.

### 2.2 Tipografia

Família única: **Inter**, em quatro pesos.

| Peso | Nós | Token |
| --- | --- | --- |
| Medium (500) | 60 | `--fig-weight-medium` |
| Regular (400) | 40 | `--fig-weight-regular` |
| Bold (700) | 19 | `--fig-weight-bold` |
| Semi Bold (600) | 11 | `--fig-weight-semibold` |

Tamanhos presentes (px): 8, 9, 10, 11, 12, 13, 14, 16, 17, 18, 21, 24, 27, 28,
30, 38. O tamanho dominante é 11 px (49 nós), característico da alta densidade
informacional do painel.

`line-height` é `normal` em 131 dos 132 nós de texto; não há `letter-spacing`
customizado em nenhum nó.

### 2.3 Raio

| Token | Valor | Aplicação |
| --- | --- | --- |
| `--fig-radius-xs` | 10 px | Faixa de tarefa |
| `--fig-radius-sm` | 12 px | Linha de arquivo |
| `--fig-radius-md` | 14 px | Pílulas (h=28), Run Selector, campo de mensagem |
| `--fig-radius-lg` | 16 px | Cartão de evento, botões de decisão, bolha do agente |
| `--fig-radius-xl` | 18 px | Stat card, amostra de cor, bolha do operador |
| `--fig-radius-2xl` | 22 px | Cartão de projeto, console, etapa atual, aprovação |
| `--fig-radius-3xl` | 28 px | App Shell, Global Rail |
| `--fig-radius-mat` | 56 px | Reference Backdrop |

### 2.4 Borda

Uma única borda em todo o frame: `1px solid #e0e0d6`, no Run Selector (`2:111`).
O divisor (`2:118`) não é borda: é um retângulo de 1 px de altura preenchido com
`#e0e0d6`.

### 2.5 Espaçamento

Não há auto-layout; os espaçamentos foram derivados das coordenadas. Os valores
que se repetem formam a escala adotada:

| Token | Valor | Onde aparece |
| --- | --- | --- |
| `--fig-space-1` | 4 px | Ajuste fino de ícone |
| `--fig-space-2` | 8 px | Interno de pílula |
| `--fig-space-3` | 10 px | Vão entre stat cards (coluna) |
| `--fig-space-4` | 12 px | Interno de faixa |
| `--fig-space-5` | 14 px | Vão vertical entre stat cards |
| `--fig-space-6` | 18 px | Interno de cartão de projeto |
| `--fig-space-7` | 20 px | Interno de bolha |
| `--fig-space-8` | 22 px | Padding de painel (sidebar, contexto, workspace) |
| `--fig-space-9` | 24 px | Padding do App Shell, margem do Context Panel |
| `--fig-space-10` | 34 px | Vão entre grupos na sidebar |
| `--fig-space-11` | 38 px | Padding do cabeçalho do projeto |
| `--fig-space-12` | 52 px | Vão entre blocos do workspace |

### 2.6 Dimensões estruturais

| Token | Valor | Nó |
| --- | --- | --- |
| `--fig-shell-w` / `--fig-shell-h` | 1600 × 900 | `2:8` |
| `--fig-rail-w` | 88 | `2:9` |
| `--fig-sidebar-w` | 340 | `2:29` |
| `--fig-context-w` | 348 | `2:164` |
| `--fig-rail-item` | 48 | `2:11` |
| `--fig-stat-w` / `--fig-stat-h` | 132 × 78 | `2:30` |
| `--fig-project-card-h` | 116 | `2:48` |
| `--fig-event-card-h` | 78 | `2:121` |
| `--fig-console-h` | 310 | `2:146` |
| `--fig-pill-h` | 28 | `2:4` |
| `--fig-button-h` | 38 | `2:204` |
| `--fig-input-h` | 40 | `2:160` |

Derivação das colunas, a partir das coordenadas absolutas:

```
frame                     0 ─────────────────────────────────────── 1920
  backdrop               24 ──────────────────────────────────────── 1896
    shell               160 ──────────────────────────────────────── 1760
      rail              160 ── 248            (88)
      sidebar           248 ── 588            (340)
      workspace         610 ── 1366           (padding 22 à esquerda de 588)
      context panel    1388 ── 1736           (348, margem 24 à direita)
```

O divisor `2:118` vai de 610 a 1736 (1126 px), confirmando que a área de
conteúdo do workspace termina em 1736 e que a margem direita interna do shell é
de 24 px.

## 3. Mapa camada → componente

| Nós Figma | Componente | Arquivo |
| --- | --- | --- |
| `2:2` | `AppShell` | `public/dashboard.html` › `.shell` |
| `2:3` | Reference Backdrop | `body` › `.mat` |
| `2:4`–`2:7` | Cabeçalho de apresentação | `.canvas-head` |
| `2:8` | Superfície do shell | `.shell` |
| `2:9`–`2:28` | `GlobalRail` | `.rail` |
| `2:11`–`2:24` | Itens de navegação do rail | `.rail-item` |
| `2:25`–`2:28` | Notificações e avatar | `.rail-foot` |
| `2:29` | `ProjectSidebar` | `.sidebar` |
| `2:30`–`2:45` | `StatGrid` (4 cartões) | `.stat-grid` › `.stat` |
| `2:46`–`2:47` | Cabeçalho da lista | `.sidebar-section-head` |
| `2:48`–`2:87` | `ProjectList` (4 cartões) | `.project-list` › `.project-card` |
| `2:53`–`2:57` | Faixa de tarefa + pílula de prioridade | `.task-strip`, `.pill` |
| `2:88`–`2:100` | `ProjectHeader` | `.project-header` |
| `2:93`–`2:96` | Pílulas de ambiente e prontidão | `.pill--local`, `.pill--ready` |
| `2:97`–`2:99` | Bloco do responsável | `.owner` |
| `2:101`–`2:110` | Ações rápidas do cabeçalho | `.header-actions` |
| `2:111`–`2:112` | `RunSelector` | `.run-selector` |
| `2:113`–`2:117` | `WorkspaceTabs` (5 abas) | `.tabs` › `.tab` |
| `2:118` | Divisor | `.workspace-divider` |
| `2:119`–`2:145` | `ExecutionTimeline` (3 eventos) | `.timeline` › `.event` |
| `2:126`, `2:135`, `2:144` | Pílula de estágio | `.pill--stage` |
| `2:146`–`2:163` | `AgentConsole` | `.console` |
| `2:147`–`2:152` | Barra de ações do console | `.console-actions` |
| `2:155`–`2:159` | Bolhas de mensagem | `.bubble--operator`, `.bubble--agent` |
| `2:160`–`2:163` | Campo de instrução + envio | `.console-form` |
| `2:164` | `ContextPanel` | `.context` |
| `2:165`–`2:182` | `CurrentStageCard` + `GateChecklist` | `.stage-card`, `.checklist` |
| `2:183`–`2:207` | `ApprovalCard` | `.approval` |
| `2:186`–`2:189` | Linha de artefato | `.file-row` |
| `2:191`–`2:203` | Decisão + verificações | `.decision`, `.approval-check` |
| `2:204`–`2:207` | Botões de decisão | `.btn--reject`, `.btn--approve` |
| `2:208`–`2:220` | Faixa de fundações visuais | não implementada — ver §5 |

## 4. Comportamento responsivo

O Figma entrega um único frame fixo de 1920 × 1240. Não há variantes de
breakpoint no arquivo. O comportamento abaixo é uma extensão necessária,
derivada das proporções do desenho:

| Faixa | Comportamento |
| --- | --- |
| ≥ 1800 px | Composição integral, incluindo o mat de apresentação com margem. |
| 1440 – 1799 px | O mat perde a margem; o shell ocupa a largura útil. Rail, sidebar e context panel mantêm largura fixa; o workspace absorve a diferença. |
| 1180 – 1439 px | O Context Panel deixa a coluna direita e passa a ocupar a faixa inferior do workspace, em duas colunas. |
| 900 – 1179 px | A sidebar colapsa para uma faixa horizontal de estatísticas acima do workspace; a lista de projetos vira um seletor. |
| < 900 px | Layout de coluna única: rail vira barra superior; sidebar, workspace e contexto empilham na ordem de leitura. |

As larguras fixas do desenho (88, 340, 348) são preservadas como mínimos até o
ponto em que deixariam o workspace abaixo de 560 px de largura útil.

## 5. Diferenças justificadas

1. **Reference Backdrop como fundo, não como cartão flutuante.** O nó `2:3` é um
   dispositivo de apresentação do arquivo (uma "mesa" onde o shell repousa).
   Preservá-lo literalmente em todas as larguras desperdiçaria área útil. Ele é
   mantido acima de 1800 px e degrada para fundo sólido abaixo disso.

2. **Faixa de fundações visuais (`2:208`–`2:220`) não implementada.** É
   documentação do sistema dentro do canvas — amostras de cor, escala tipográfica
   e escala de raio. Seu conteúdo virou `tokens.css` e este documento, que é o
   destino correto dessa informação em código.

3. **Sobreposição entre `CurrentStageCard` e `ApprovalCard` resolvida.** No
   Figma, o cartão de etapa (`2:165`, y 374–594) e o cartão de aprovação
   (`2:183`, y 616–978) sobrepõem os itens de checklist (`2:174`–`2:182`,
   y 584–658), e o título da etapa (`2:167`) transborda a caixa. É um artefato de
   composição em canvas plano. Em código, o checklist pertence ao
   `CurrentStageCard`, que cresce conforme o conteúdo; nada transborda nem
   sobrepõe.

4. **Inter sem arquivo de fonte embarcado.** A CSP do painel é
   `default-src 'self'`, e o projeto não versiona binários de fonte. A pilha é
   `Inter, 'Segoe UI', system-ui, sans-serif`: idêntica ao desenho onde a Inter
   estiver instalada, com degradação métrica próxima onde não estiver. Embarcar
   um `.woff2` é possível sem alterar o servidor — o MIME `font/woff2` já é
   servido — e fica registrado como opção, não como pendência funcional.

5. **Ícones do rail e do console.** No Figma são glifos de texto de uma fonte de
   ícones não embarcada, exportados pelo MCP como imagens rasterizadas. Foram
   reimplementados como `<use>` sobre o sprite `public/assets/icons.svg`, já
   existente no projeto, preservando as caixas de 48 px do rail e de 40 px das
   ações de cabeçalho.

6. **Conteúdo demonstrativo substituído por dados reais.** Os valores `6`, `27`,
   `22`, `3`, `72%`, `Run #ORQ-0042`, `Screen — Catálogo`, `MN26 — Editor-chefe`,
   `meuimovel.io`, `Diag IA` e `PLANO-EXECUCAO.md` são referências de composição.
   O mapa de dados reais está na §6.

7. **Quinta aba renomeada.** As abas do Figma são `Resumo`, `Agentes`, `Prompts`,
   `Arquivos`, `Histórico`. `Arquivos` foi mantida como `Artefatos`, que é o
   termo do domínio no restante do produto (relatórios, pacote de revisão,
   evidência de teste) e evita sugerir um navegador de sistema de arquivos, que o
   painel deliberadamente não expõe.

8. **Dashboard como página nova, não substituição do painel atual.** O sistema
   visual do Figma (rail escuro, lime/lavender/coral, raios de 22–28 px) é
   incompatível com o de `public/assets/styles.css` (verde dessaturado, cantos
   quase retos). Aplicá-lo por cima quebraria `project.html`, `run.html`,
   `prompt.html` e `settings.html`. O Master Canvas foi implementado em
   `public/dashboard.html`, com camada de tokens própria, e as páginas existentes
   seguem intactas.

## 6. Mapa dado demonstrativo → dado real

| Elemento Figma | Valor no desenho | Origem real |
| --- | --- | --- |
| Stat "Projetos" | 6 | `GET /api/home` › `projects.length` |
| Stat "Agentes" | 27 | `GET /api/home` › `tools` disponíveis / total detectado |
| Stat "Em curso" | 22 | `GET /api/home` › `activeRuns` |
| Stat "Aprovações" | 3 | `GET /api/home` › soma de `projects[].promptPending` |
| Cartão de projeto | nomes fictícios | `GET /api/home` › `projects[]` (`name`, `activeState`, `ciStatus`) |
| Pílula de prioridade | Alta / Média / Baixa | Derivada de `activeState`: bloqueio → coral, execução → lavender, ocioso → cyan |
| Cabeçalho do projeto | `OrqPEG`, `E:/Projetos/OrqPEG` | `projects[].name`, `repositoryPath`, `githubRepository`, `baseBranch` |
| Pílula `LOCAL` | fixa | `worktreeEnabled` e ausência de remoto configurado |
| Pílula `READY` | fixa | Disponibilidade real das ferramentas (`tools`) e ausência de `lastError` |
| Run Selector | `Run #ORQ-0042` | `GET /api/projects/:id/runs` › `runId` |
| Timeline | 3 eventos fictícios | `GET /api/projects/:id/runs/:runId` › `events[]` (`at`, `state`, `message`) |
| Pílula de estágio | Discovery / Execution / Approved | `RunState` agrupado em estágios — ver `dashboard.js` › `STAGE_BY_STATE` |
| Console | diálogo fictício | `events[]` filtrados + estado de governança do campo de entrada |
| Etapa atual | `Prompt 2 — Ratings…` | `currentPromptId` + `prompts[]` |
| Progresso `72%` | fixo | `prompts` aprovados ÷ total, do `RunRecord` |
| Checklist de gates | 3 itens fictícios | `gateReport` › `MergeGateReport.gates[]` |
| Cartão de aprovação | `PLANO-EXECUCAO.md` | `consensus`, `gateReport` e `overrides` do `RunRecord` |
| Botões Aprovar / Recusar | estáticos | `POST /api/projects/:id/runs/:runId/override` com confirmação |

Nenhum valor do desenho permanece como constante no código.
