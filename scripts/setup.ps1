<#
    OrqPEG - instalacao e configuracao assistida.

    Compativel com Windows PowerShell 5.1 (sem os operadores &&, ||, ?: e ??).
    Executado por INSTALAR-E-CONFIGURAR.cmd:
        powershell -NoProfile -ExecutionPolicy Bypass -File scripts\setup.ps1

    Etapas: valida a pasta, confere o acesso ao repositorio maquinanerd/OrqPEG,
    verifica as ferramentas, instala as dependencias de desenvolvimento,
    compila, valida os schemas, roda os testes, garante config/global.json,
    executa o diagnostico e oferece a abertura do painel.

    Regras deste instalador:
      - nenhuma ferramenta global e instalada silenciosamente: quando algo
        falta, o comando de instalacao e apenas informado;
      - nenhuma chave de API e lida ou gravada; o OrqPEG conversa apenas com
        os executaveis locais "claude" e "codex";
      - o resultado real de cada etapa e sempre relatado, inclusive falhas.

    Texto sem acentos de proposito: o console do Windows pode estar em qualquer
    codepage e a mensagem precisa continuar legivel.
#>

param(
    [switch] $SkipTests
)

$ErrorActionPreference = 'Stop'

$script:Root         = Split-Path -Parent $PSScriptRoot
$script:StepNumber   = 0
$script:ErrorCount   = 0
$script:WarningCount = 0
$script:CliPath      = Join-Path $script:Root 'dist\cli\main.js'

try {
    [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
}
catch {
    # Console sem suporte a troca de codificacao: seguimos assim mesmo.
}

# ---------------------------------------------------------------------------
# Saida formatada
# ---------------------------------------------------------------------------

function Write-Rule {
    Write-Host ('  ' + ('=' * 70)) -ForegroundColor DarkCyan
}

function Write-StepTitle {
    param([string] $Title)
    $script:StepNumber = $script:StepNumber + 1
    Write-Host ''
    Write-Host ('  [{0}] {1}' -f $script:StepNumber, $Title) -ForegroundColor Cyan
}

function Write-StepOk {
    param([string] $Text)
    Write-Host ('      OK    ' + $Text) -ForegroundColor Green
}

function Write-StepWarn {
    param([string] $Text)
    $script:WarningCount = $script:WarningCount + 1
    Write-Host ('      AVISO ' + $Text) -ForegroundColor Yellow
}

function Write-StepError {
    param([string] $Text)
    $script:ErrorCount = $script:ErrorCount + 1
    Write-Host ('      ERRO  ' + $Text) -ForegroundColor Red
}

function Write-StepInfo {
    param([string] $Text)
    Write-Host ('            ' + $Text) -ForegroundColor DarkGray
}

# ---------------------------------------------------------------------------
# Execucao de processos externos
# ---------------------------------------------------------------------------

# Executa um programa mostrando a saida ao vivo e devolve o codigo de saida.
function Invoke-Tool {
    param(
        [Parameter(Mandatory = $true)][string] $FilePath,
        [string[]] $ArgumentList = @(),
        [string] $WorkingDirectory = $script:Root
    )

    $previousPreference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    $previousLocation = Get-Location
    $exitCode = 1

    try {
        Set-Location -LiteralPath $WorkingDirectory
        & $FilePath @ArgumentList | Out-Host
        $exitCode = $LASTEXITCODE
    }
    catch {
        Write-Host ('      ERRO  Nao foi possivel executar "' + $FilePath + '": ' + $_.Exception.Message) -ForegroundColor Red
        $exitCode = 1
    }
    finally {
        Set-Location -LiteralPath $previousLocation.Path
        $ErrorActionPreference = $previousPreference
    }

    if ($null -eq $exitCode) {
        $exitCode = 0
    }
    return $exitCode
}

# Executa um programa capturando a saida padrao como texto.
function Invoke-ToolCapture {
    param(
        [Parameter(Mandatory = $true)][string] $FilePath,
        [string[]] $ArgumentList = @(),
        [string] $WorkingDirectory = $script:Root
    )

    $previousPreference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    $previousLocation = Get-Location
    $exitCode = 1
    $text = ''

    try {
        Set-Location -LiteralPath $WorkingDirectory
        $lines = & $FilePath @ArgumentList
        $exitCode = $LASTEXITCODE
        if ($null -ne $lines) {
            $text = ($lines | Out-String)
        }
    }
    catch {
        $exitCode = 1
        $text = ''
    }
    finally {
        Set-Location -LiteralPath $previousLocation.Path
        $ErrorActionPreference = $previousPreference
    }

    if ($null -eq $exitCode) {
        $exitCode = 0
    }
    return [pscustomobject]@{ ExitCode = $exitCode; Output = $text }
}

# Descobre se uma ferramenta esta no PATH e qual a versao instalada.
function Get-ToolInfo {
    param(
        [Parameter(Mandatory = $true)][string] $Name,
        [string[]] $VersionArgs = @('--version')
    )

    $command = Get-Command -Name $Name -ErrorAction SilentlyContinue
    if ($null -eq $command) {
        return [pscustomobject]@{ Found = $false; Version = ''; Path = '' }
    }

    $sourcePath = ''
    if ($command.Path) {
        $sourcePath = $command.Path
    }

    $version = ''
    $captured = Invoke-ToolCapture -FilePath $Name -ArgumentList $VersionArgs
    if ($captured.ExitCode -eq 0) {
        $first = ($captured.Output -split '[\r\n]+' | Where-Object { $_.Trim().Length -gt 0 } | Select-Object -First 1)
        if ($null -ne $first) {
            $version = $first.Trim()
        }
    }

    return [pscustomobject]@{ Found = $true; Version = $version; Path = $sourcePath }
}

function Show-Summary {
    Write-Host ''
    Write-Rule
    if ($script:ErrorCount -gt 0) {
        Write-Host ('  RESULTADO: {0} ERRO(S) e {1} AVISO(S).' -f $script:ErrorCount, $script:WarningCount) -ForegroundColor Red
        Write-Host '  Corrija os itens marcados como ERRO e rode INSTALAR-E-CONFIGURAR.cmd de novo.' -ForegroundColor Red
    }
    elseif ($script:WarningCount -gt 0) {
        Write-Host ('  RESULTADO: instalacao concluida com {0} AVISO(S).' -f $script:WarningCount) -ForegroundColor Yellow
        Write-Host '  Os avisos nao impedem o uso, mas leia cada um antes de executar um projeto.' -ForegroundColor Yellow
    }
    else {
        Write-Host '  RESULTADO: instalacao concluida sem erros nem avisos.' -ForegroundColor Green
    }
    Write-Rule
    Write-Host ''
    Write-Host '  Proximos passos:' -ForegroundColor White
    Write-Host '    ORQPEG.cmd             menu principal' -ForegroundColor Gray
    Write-Host '    CADASTRAR-PROJETO.cmd  registra um repositorio ja existente' -ForegroundColor Gray
    Write-Host '    EXECUTAR-DRY-RUN.cmd   simula tudo sem alterar nada' -ForegroundColor Gray
    Write-Host '    DIAGNOSTICO.cmd        revalida o ambiente quando algo falhar' -ForegroundColor Gray
    Write-Host ''
}

function Stop-Setup {
    param([string] $Reason)
    Write-Host ''
    Write-Host ('  Instalacao interrompida: ' + $Reason) -ForegroundColor Red
    Show-Summary
    exit 1
}

# ---------------------------------------------------------------------------
# Inicio
# ---------------------------------------------------------------------------

Write-Host ''
Write-Rule
Write-Host '  ORQPEG - INSTALACAO E CONFIGURACAO' -ForegroundColor White
Write-Host '  Orquestrador local: Claude Code executa, Codex CLI revisa.' -ForegroundColor Gray
Write-Host '  Zero API paga, zero dependencia de runtime, tudo em 127.0.0.1.' -ForegroundColor Gray
Write-Rule

# ---------------------------------------------------------------------------
# 1. Pasta de instalacao
# ---------------------------------------------------------------------------

Write-StepTitle 'Validando a pasta de instalacao'
Write-StepInfo ('Pasta: ' + $script:Root)

$requiredEntries = @('package.json', 'tsconfig.json', 'src', 'scripts')
$missingEntries = @()
foreach ($entry in $requiredEntries) {
    if (-not (Test-Path -LiteralPath (Join-Path $script:Root $entry))) {
        $missingEntries += $entry
    }
}

if ($missingEntries.Count -gt 0) {
    Write-StepError ('Estrutura incompleta. Faltando: ' + ($missingEntries -join ', '))
    Write-StepInfo 'Baixe o repositorio de novo em https://github.com/maquinanerd/OrqPEG'
    Stop-Setup 'a pasta nao contem uma copia completa do OrqPEG.'
}

$packageJsonPath = Join-Path $script:Root 'package.json'
$package = $null
try {
    $package = Get-Content -LiteralPath $packageJsonPath -Raw -Encoding UTF8 | ConvertFrom-Json
}
catch {
    $package = $null
}

if ($null -eq $package) {
    Write-StepError 'package.json ilegivel ou com JSON invalido.'
    Stop-Setup 'nao foi possivel ler o package.json.'
}
elseif ($package.name -ne 'orqpeg') {
    Write-StepError ('Esta pasta contem o pacote "' + $package.name + '", nao o OrqPEG.')
    Stop-Setup 'pasta de instalacao incorreta.'
}
else {
    Write-StepOk ('Copia valida do OrqPEG ' + $package.version + '.')
}

if ($script:Root -ne 'C:\OrqPEG') {
    Write-StepInfo 'A pasta recomendada e C:\OrqPEG, mas qualquer caminho funciona,'
    Write-StepInfo 'inclusive com espacos e acentos.'
}

# ---------------------------------------------------------------------------
# 2. Ferramentas do ambiente
# ---------------------------------------------------------------------------

Write-StepTitle 'Verificando as ferramentas do ambiente'

$node = Get-ToolInfo -Name 'node'
if (-not $node.Found) {
    Write-StepError 'Node.js nao encontrado no PATH.'
    Write-StepInfo 'Instale a versao LTS 20 ou superior em https://nodejs.org'
    Stop-Setup 'o Node.js e obrigatorio.'
}
else {
    $nodeMajor = 0
    $versionMatch = [regex]::Match($node.Version, '^v?(\d+)')
    if ($versionMatch.Success) {
        $nodeMajor = [int] $versionMatch.Groups[1].Value
    }
    if ($nodeMajor -ge 20) {
        Write-StepOk ('Node.js ' + $node.Version)
    }
    else {
        Write-StepError ('Node.js ' + $node.Version + ' e antigo demais. O minimo e a versao 20.')
        Write-StepInfo 'Atualize em https://nodejs.org e rode este instalador de novo.'
        Stop-Setup 'versao do Node.js incompativel.'
    }
}

$npm = Get-ToolInfo -Name 'npm'
if ($npm.Found) {
    Write-StepOk ('npm ' + $npm.Version)
}
else {
    Write-StepError 'npm nao encontrado no PATH. Ele acompanha o instalador do Node.js.'
    Stop-Setup 'o npm e obrigatorio para instalar as dependencias de desenvolvimento.'
}

$git = Get-ToolInfo -Name 'git'
if ($git.Found) {
    Write-StepOk $git.Version
}
else {
    Write-StepError 'Git nao encontrado no PATH.'
    Write-StepInfo 'Instale o Git for Windows em https://git-scm.com/download/win'
}

$gh = Get-ToolInfo -Name 'gh'
if ($gh.Found) {
    Write-StepOk ('GitHub CLI: ' + $gh.Version)
    $ghAuth = Invoke-ToolCapture -FilePath 'gh' -ArgumentList @('auth', 'status')
    if ($ghAuth.ExitCode -eq 0) {
        Write-StepOk 'GitHub CLI autenticado.'
    }
    else {
        Write-StepWarn 'GitHub CLI presente, porem sem autenticacao.'
        Write-StepInfo 'Execute: gh auth login'
    }
}
else {
    Write-StepWarn 'GitHub CLI (gh) ausente: pull requests e checagens de CI ficam indisponiveis.'
    Write-StepInfo 'Instale em https://cli.github.com e depois execute: gh auth login'
}

$claude = Get-ToolInfo -Name 'claude'
if ($claude.Found) {
    Write-StepOk ('Claude Code: ' + $claude.Version)
}
else {
    Write-StepWarn 'Claude Code (claude) ausente: nenhuma execucao de IA sera possivel.'
    Write-StepInfo 'Instale voce mesmo com: npm install -g @anthropic-ai/claude-code'
    Write-StepInfo 'Depois autentique com a sua assinatura Claude Max.'
}

$codex = Get-ToolInfo -Name 'codex'
if ($codex.Found) {
    Write-StepOk ('Codex CLI: ' + $codex.Version)
}
else {
    Write-StepWarn 'Codex CLI (codex) ausente: a revisao e o consenso de merge ficam bloqueados.'
    Write-StepInfo 'Instale voce mesmo com: npm install -g @openai/codex'
    Write-StepInfo 'Depois autentique com "Sign in with ChatGPT".'
}

Write-StepInfo 'Nenhuma ferramenta foi instalada automaticamente por este script.'

# ---------------------------------------------------------------------------
# 3. Acesso ao repositorio oficial
# ---------------------------------------------------------------------------

Write-StepTitle 'Conferindo o acesso a maquinanerd/OrqPEG'

if (-not $gh.Found) {
    Write-StepWarn 'Sem o GitHub CLI nao da para confirmar o acesso ao repositorio oficial.'
    Write-StepInfo 'Isso nao impede a instalacao nem o uso local do OrqPEG.'
}
else {
    $repoCheck = Invoke-ToolCapture -FilePath 'gh' -ArgumentList @('repo', 'view', 'maquinanerd/OrqPEG', '--json', 'nameWithOwner')
    if ($repoCheck.ExitCode -eq 0) {
        Write-StepOk 'Acesso a maquinanerd/OrqPEG confirmado.'
    }
    else {
        Write-StepWarn 'Nao foi possivel confirmar o acesso a maquinanerd/OrqPEG.'
        Write-StepInfo 'Verifique a autenticacao com: gh auth login'
        Write-StepInfo 'O OrqPEG continua funcionando com os seus proprios repositorios.'
    }
}

# ---------------------------------------------------------------------------
# 4. Dependencias de desenvolvimento
# ---------------------------------------------------------------------------

Write-StepTitle 'Instalando as dependencias de desenvolvimento (npm install)'
Write-StepInfo 'O OrqPEG tem zero dependencias de runtime: apenas TypeScript e os'
Write-StepInfo 'tipos do Node sao baixados, e somente para compilar.'

$installExit = Invoke-Tool -FilePath 'npm' -ArgumentList @('install')
if ($installExit -eq 0) {
    Write-StepOk 'Dependencias instaladas.'
}
else {
    Write-StepError ('npm install falhou com codigo ' + $installExit + '.')
    Write-StepInfo 'Verifique a conexao com a internet e o acesso ao registro npm.'
    Stop-Setup 'sem as dependencias nao e possivel compilar.'
}

# ---------------------------------------------------------------------------
# 5. Compilacao
# ---------------------------------------------------------------------------

Write-StepTitle 'Compilando o TypeScript (npm run build)'

$buildExit = Invoke-Tool -FilePath 'npm' -ArgumentList @('run', 'build')
if ($buildExit -ne 0) {
    Write-StepError ('npm run build falhou com codigo ' + $buildExit + '.')
    Stop-Setup 'a compilacao falhou.'
}

if (Test-Path -LiteralPath $script:CliPath) {
    Write-StepOk 'Compilado: dist\cli\main.js'
}
else {
    Write-StepError 'A compilacao terminou sem erro, mas dist\cli\main.js nao existe.'
    Stop-Setup 'saida de compilacao inesperada.'
}

# ---------------------------------------------------------------------------
# 6. Validacao dos schemas
# ---------------------------------------------------------------------------

Write-StepTitle 'Validando os schemas JSON'

$doctorJson = Invoke-ToolCapture -FilePath 'node' -ArgumentList @($script:CliPath, 'doctor', '--json')
$report = $null
try {
    $report = $doctorJson.Output | ConvertFrom-Json
}
catch {
    $report = $null
}

if ($null -eq $report) {
    Write-StepError 'Nao foi possivel interpretar a saida de "doctor --json".'
    Write-StepInfo 'Rode DIAGNOSTICO.cmd para ver a mensagem completa.'
}
else {
    $schemaItems = @($report.items | Where-Object { $_.category -eq 'Schemas' })
    $schemaErrors = @($schemaItems | Where-Object { $_.status -eq 'ERRO' })
    if ($schemaItems.Count -eq 0) {
        Write-StepWarn 'O diagnostico nao reportou nenhum schema.'
    }
    elseif ($schemaErrors.Count -eq 0) {
        Write-StepOk ('Todos os ' + $schemaItems.Count + ' schemas foram carregados e estao utilizaveis.')
    }
    else {
        foreach ($item in $schemaErrors) {
            Write-StepError ($item.title + ': ' + $item.detail)
        }
    }

    $wrapperItems = @($report.items | Where-Object { $_.id -eq 'wrappers' })
    foreach ($item in $wrapperItems) {
        if ($item.status -eq 'OK') {
            Write-StepOk $item.detail
        }
        else {
            Write-StepError ('Wrappers .cmd: ' + $item.detail)
        }
    }
}

# ---------------------------------------------------------------------------
# 7. Testes automatizados
# ---------------------------------------------------------------------------

if ($SkipTests) {
    Write-StepTitle 'Testes automatizados (ignorados por -SkipTests)'
    Write-StepWarn 'Os testes foram pulados a seu pedido. Rode "npm test" antes de usar em producao.'
}
else {
    Write-StepTitle 'Rodando os testes automatizados (npm test)'
    $testExit = Invoke-Tool -FilePath 'npm' -ArgumentList @('test')
    if ($testExit -eq 0) {
        Write-StepOk 'Todos os testes passaram.'
    }
    else {
        Write-StepError ('npm test falhou com codigo ' + $testExit + '.')
        Write-StepInfo 'A instalacao segue, mas nao execute projetos reais ate os testes passarem.'
    }
}

# ---------------------------------------------------------------------------
# 8. Configuracao global
# ---------------------------------------------------------------------------

Write-StepTitle 'Garantindo a configuracao global'

$configDir  = Join-Path $script:Root 'config'
$configFile = Join-Path $configDir 'global.json'

if (Test-Path -LiteralPath $configFile) {
    Write-StepOk 'config\global.json ja existe e foi preservado.'
}
else {
    Write-StepInfo 'config\global.json ausente: pedindo a CLI para gerar o padrao.'
    $seedExit = Invoke-Tool -FilePath 'node' -ArgumentList @($script:CliPath, 'version')
    if ($seedExit -ne 0) {
        Write-StepWarn ('A CLI retornou o codigo ' + $seedExit + ' ao gerar a configuracao.')
    }
    if (Test-Path -LiteralPath $configFile) {
        Write-StepOk 'config\global.json criado com os valores padrao.'
    }
    else {
        Write-StepError 'Nao foi possivel criar config\global.json.'
        Write-StepInfo 'Confira as permissoes de escrita na pasta de instalacao.'
    }
}

if (Test-Path -LiteralPath $configFile) {
    $config = $null
    try {
        $config = Get-Content -LiteralPath $configFile -Raw -Encoding UTF8 | ConvertFrom-Json
    }
    catch {
        $config = $null
    }
    if ($null -eq $config) {
        Write-StepError 'config\global.json existe, mas nao contem JSON valido.'
        Write-StepInfo 'Apague o arquivo e rode este instalador de novo para regerar o padrao.'
    }
    else {
        Write-StepOk ('Painel configurado para http://' + $config.panel.host + ':' + $config.panel.port)
    }
}

# ---------------------------------------------------------------------------
# 9. Diagnostico completo
# ---------------------------------------------------------------------------

Write-StepTitle 'Executando o diagnostico completo'

$doctorExit = Invoke-Tool -FilePath 'node' -ArgumentList @($script:CliPath, 'doctor')
if ($doctorExit -eq 0) {
    Write-StepOk 'Diagnostico sem erros.'
}
else {
    Write-StepError 'O diagnostico encontrou pelo menos um ERRO. Leia o relatorio acima.'
}

# ---------------------------------------------------------------------------
# 10. Painel
# ---------------------------------------------------------------------------

Show-Summary

if ($script:ErrorCount -gt 0) {
    exit 1
}

$launcher = Join-Path $PSScriptRoot 'launcher.ps1'
if (-not (Test-Path -LiteralPath $launcher)) {
    Write-Host '  scripts\launcher.ps1 nao encontrado: abra o painel com INICIAR-PAINEL.cmd.' -ForegroundColor Yellow
    exit 0
}

$answer = Read-Host '  Deseja abrir o painel agora? [s/N]'
if ($answer -match '^\s*[sS]') {
    & $launcher
    $launcherExit = $LASTEXITCODE
    if ($null -eq $launcherExit) {
        $launcherExit = 0
    }
    exit $launcherExit
}

Write-Host '  Tudo pronto. Abra o painel quando quiser com ABRIR-PAINEL.cmd.' -ForegroundColor Green
exit 0
