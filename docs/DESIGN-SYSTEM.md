# Design system do painel OrqPEG

Uma camada de tokens, duas folhas de estilo, um tema. Este documento diz o que
cada peça decide, para que uma mudança futura não precise redescobrir as
razões.

## 1. Arquivo por arquivo

| Arquivo | Papel |
| --- | --- |
| `public/assets/tokens.css` | Única fonte de cor, tipografia, espaço, raio e movimento. Não estiliza nenhum seletor. |
| `public/assets/dashboard.css` | Console (`index.html`). Consome tokens. |
| `public/assets/styles.css` | Páginas de detalhe (`painel-classico`, `project`, `run`, `prompt`, `settings`). Estrutura própria, tokens compartilhados. |

`styles.css` mantém os nomes `--orq-*` porque 229 declarações os usam, mas
nenhum deles carrega valor próprio: cada um é apelido de um `--op-*`. Toda
página que carrega `styles.css` precisa carregar `tokens.css` antes — sem isso
cada `var(--op-*)` resolve para nada e a página abre sem cor. Há teste para
isso em `tests/security/dashboard-surface.test.js`.

## 2. Princípios

**O painel é claro. Só claro.** Não existe tema escuro nem inversão por
`prefers-color-scheme`. Um console de operação que muda de fundo conforme a
configuração do sistema operacional é um console que ninguém reconhece de
relance. `color-scheme: light` está fixo no `:root` e cada página declara a
meta correspondente, para que campo, seletor e barra de rolagem nativos também
sejam desenhados na variante clara.

**Cromatismo é informação.** Fundo, borda e texto são acromáticos. Matiz só
aparece onde significa alguma coisa: estado da execução, resultado de gate,
prioridade, transporte. Uma tela sem incidente é uma tela cinza.

**Um acento só.** Azul é interação — seleção, foco, ação primária. Nada mais é
azul.

**Sinal na borda, não no preenchimento.** Estado se mostra por régua lateral,
ponto ou etiqueta pequena. Cartão inteiro tingido destrói hierarquia: quando
tudo grita, nada informa. O cartão de etapa fica neutro e ganha uma régua de
2 px na cor do estado; a etiqueta é o par tinta-a-12% + texto na cor sólida.

**Geometria apertada.** Raio de 3 a 10 px, fio de 1 px, grade de 4 px.

**Tamanho de leitura.** Corpo em 13 px.

## 3. Cor

Superfícies em escada de elevação — `canvas`, `sunken`, `surface`, `raised`,
`overlay`. A escada sobe ficando mais branca: o fundo da aplicação é o tom mais
acinzentado e o cartão é branco puro. Traço em três pesos — `line`,
`line-strong`, `line-loud`. Texto em três níveis — `fg`, `fg-secondary`,
`fg-muted`.

Seis matizes semânticos, cada um com par sólido/suave:

| Token | Papel |
| --- | --- |
| `--op-ok` | aprovado, gate passou |
| `--op-warn` | aguardando decisão, pausado |
| `--op-danger` | bloqueio, falha, prioridade alta |
| `--op-info` | em execução (é o mesmo valor do acento: "em curso" é "ativo") |
| `--op-accent-alt` | descoberta, enfileirado |
| `--op-neutral` | ocioso, sem estado |

Os estados de execução (`--op-state-*`) são apelidos sobre esses seis. **O
painel não introduz cor nova.** Se um estado novo aparecer, ele reusa um destes
— ou o mapeamento está errado.

### 3.1 Como os matizes foram calibrados

O sólido é a cor do **texto** sobre o próprio suave — é assim que a etiqueta
funciona. Então o par precisa fechar contraste junto, não separadamente.

O alpha do suave é **0,12**, e não é arbitrário: a tinta escurece o fundo e
aproxima fundo e texto, então alpha maior derruba o contraste. Foi o maior
valor que ainda deixa todos os pares passarem.

Os níveis de texto foram resolvidos contra **todas** as superfícies que o
painel realmente produz, não só as opacas: 21 combinações — as três opacas
(branco, `--op-canvas`, `--op-sunken`) e cada uma coberta por cada tinta
semântica a 12%. O pior caso de `--op-fg-muted` não é texto sobre painel — é
legenda dentro de caixa de aviso, onde a tinta come o contraste que a
superfície sozinha teria dado. É esse caso que fixa o valor. O cartão de
projeto selecionado (`#e4ebf8`, que é `--op-accent-soft` resolvido sobre
branco) entra na conta pelo mesmo motivo.

Verificação: com o painel no ar, percorrer as abas do console e as páginas de
detalhe medindo `color` contra o fundo composto (a cadeia de ancestrais até a
primeira superfície opaca, com cada camada translúcida aplicada por cima).
Alvo: 4,5:1 para texto e 3:1 para ponto, régua e ícone. Última verificação: sem
reprovação no console (seis abas + diálogos) nem em `painel-classico`,
`project`, `run` e `settings`.

**Ao mexer em qualquer matiz ou no alpha, refaça a medição.** Os valores são
apertados de propósito — vários fecham entre 4,6 e 4,7 — porque escurecer mais
que o necessário achata a paleta.

## 4. Tipografia

Sete tamanhos: `micro` 11, `caption` 12, `body` 13, `body-lg` 14, `title` 16,
`heading` 20, `display` 26, `metric` 30. A escala anterior tinha dezesseis, o
que garantia que ninguém soubesse qual escolher.

Sem fonte embarcada: a CSP é `default-src 'self'` e o projeto não versiona
binários. A pilha começa em Inter e cai para as variáveis do Windows.

## 5. Layout do console

```
topbar   44px, largura total — identidade, contexto da sessão, transporte
shell    grade de quatro colunas ocupando o resto da altura
  rail       52px   navegação global, só glifo
  sidebar   300px   estatísticas + lista de execuções
  workspace  1fr    cabeçalho, abas, linha do tempo, console
  context   336px   etapa atual e decisão pendente
```

O aplicativo ocupa a janela inteira. Não há moldura nem cartão flutuante: é
ferramenta aberta, não peça exposta.

Três quebras, cada uma com um motivo: em 1379 px o painel de contexto desce
para o workspace; em 1099 px a sidebar vira faixa horizontal; em 899 px o rail
vira barra e tudo empilha em coluna única.

### 5.1 Altura do documento

O console é uma janela de altura fixa (`100dvh`) e cada coluna rola no próprio
eixo. `overflow-y: auto` recorta o desenho, mas **não** impede que a altura de
layout do conteúdo suba pela árvore: o documento reportava `scrollHeight` de
2534 com viewport de 950, e a página ganhava mil e quinhentos pixels de vazio
abaixo do aplicativo — visível em captura de tela inteira e alcançável por
rolagem programática.

`contain: paint` nas três colunas que rolam corta essa propagação na origem.
Recortar a rolagem da raiz (`overflow: hidden` no `html`) foi testado e **não
resolve**: o `scrollHeight` continua inflado, e o recorte ainda esconderia
qualquer transbordamento legítimo que aparecesse depois.

Na faixa estreita a contenção é desfeita (`contain: none`): empilhado, a página
inteira rola e conter as colunas deixaria o conteúdo abaixo da dobra
inalcançável.

### 5.2 Duas armadilhas de flex

- `.workspace > * { flex: none }` — o workspace é coluna que rola; sem isso o
  flex encolhe os filhos, e quem tem `overflow: hidden` (o console) perde a
  proteção do `min-height` automático e colapsa até a borda.
- As abas ocupam a própria linha. Quando dividiam a linha com as ações e o
  seletor de execução, três controles de largura variável disputavam a mesma
  faixa e a barra quebrava sozinha.

## 6. Controle e navegação

A barra do workspace separa dois escopos que não se misturam:

- **Esquerda — a execução corrente.** Iniciar, pausar, retomar, cancelar,
  abrir repositório; e o seletor de execução.
- **Direita — o cadastro do projeto.** Detalhes, Ensaio, Editar, Remover.

Editar e cadastrar usam **um diálogo em dois modos**: os campos são os mesmos
sete, e duplicar o formulário só garantiria que um dos dois ficasse para trás
na próxima mudança. A diferença real é o identificador — ele nomeia o diretório
de estado do projeto e por isso não muda depois de criado; no modo edição o
campo é somente-leitura e não viaja no corpo do `PUT`.

Remover passa pelo fluxo governado, com justificativa obrigatória, e fica
desabilitado enquanto houver execução viva: apagar o cadastro sob uma execução
em curso deixa a execução órfã. O texto do diálogo diz o que a rota realmente
faz — remove o registro, não o repositório —, porque a diferença entre as duas
coisas é a única que importa para quem clica.

Prompt, execução anterior e merge são `<a href>` de verdade para
`prompt.html`, `run.html` e `project.html`. Antes eram texto morto: o operador
via o identificador e não tinha como abrir o que ele nomeia. Sendo âncora e não
`<li>` com `onclick`, clique do meio, "abrir em nova aba" e navegação por
teclado funcionam. Todo identificador que entra numa URL passa por
`encodeURIComponent`.

## 7. Acessibilidade

Anel de foco único no acento, com halo branco para permanecer visível também
sobre superfície tingida. Rótulo textual existe no DOM para todo item do rail e
aparece como tooltip. `prefers-reduced-motion` zera a duração das transições em
vez de removê-las, para que regras que dependem de `transitionend` continuem
disparando.

## 8. História

O painel já teve duas identidades ao mesmo tempo: o console carregava uma
paleta derivada de um frame do Figma (prefixo `--fig-`: lima neon, coral,
lavanda, fundo oliva, raios de 22 a 56 px, corpo em 11 px) e `styles.css`
carregava outra (verde institucional, raio de 3 px). Trocar de página trocava
de produto. As duas foram removidas em favor da camada única descrita aqui;
`tests/security/dashboard-surface.test.js` impede que qualquer uma volte, que o
tema escuro reapareça e que a contenção das colunas seja removida.
