<#
    OrqPEG - build de desenvolvimento.

    Compativel com Windows PowerShell 5.1 (sem os operadores &&, ||, ?: e ??).
    Uso:
        powershell -NoProfile -ExecutionPolicy Bypass -File scripts\build.ps1

    Etapas, sempre relatadas com o resultado real:
      1. npm install  (somente quando node_modules estiver ausente)
      2. npm run build
      3. npm run typecheck

    Nenhum arquivo de dados e tocado: data\ e config\ ficam intactos.
    Texto sem acentos de proposito, para nao depender do codepage do console.
#>

param()

$ErrorActionPreference = 'Stop'

$script:Root = Split-Path -Parent $PSScriptRoot

try {
    [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
}
catch {
    # Console sem suporte a troca de codificacao: seguimos assim mesmo.
}

function Write-Stage {
    param([string] $Text)
    Write-Host ''
    Write-Host ('  >> ' + $Text) -ForegroundColor Cyan
}

function Write-Ok {
    param([string] $Text)
    Write-Host ('  OK    ' + $Text) -ForegroundColor Green
}

function Write-Problem {
    param([string] $Text)
    Write-Host ('  ERRO  ' + $Text) -ForegroundColor Red
}

function Write-Detail {
    param([string] $Text)
    Write-Host ('        ' + $Text) -ForegroundColor DarkGray
}

# Executa um programa mostrando a saida ao vivo e devolve o codigo de saida.
function Invoke-Tool {
    param(
        [Parameter(Mandatory = $true)][string] $FilePath,
        [string[]] $ArgumentList = @()
    )

    $previousPreference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    $previousLocation = Get-Location
    $exitCode = 1

    try {
        Set-Location -LiteralPath $script:Root
        & $FilePath @ArgumentList | Out-Host
        $exitCode = $LASTEXITCODE
    }
    catch {
        Write-Host ('  ERRO  Nao foi possivel executar "' + $FilePath + '": ' + $_.Exception.Message) -ForegroundColor Red
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

Write-Host ''
Write-Host '  ORQPEG - build de desenvolvimento' -ForegroundColor White
Write-Detail ('Pasta: ' + $script:Root)

foreach ($tool in @('node', 'npm')) {
    if ($null -eq (Get-Command -Name $tool -ErrorAction SilentlyContinue)) {
        Write-Problem ($tool + ' nao encontrado no PATH.')
        Write-Detail 'Instale o Node.js LTS 20 ou superior em https://nodejs.org'
        Write-Host ''
        exit 1
    }
}

# --- 1. Dependencias --------------------------------------------------------

$nodeModules = Join-Path $script:Root 'node_modules'
if (Test-Path -LiteralPath $nodeModules) {
    Write-Stage 'Dependencias'
    Write-Ok 'node_modules ja existe: npm install nao e necessario.'
    Write-Detail 'Para forcar a reinstalacao, rode scripts\clean-dev.ps1 antes.'
}
else {
    Write-Stage 'npm install'
    $installExit = Invoke-Tool -FilePath 'npm' -ArgumentList @('install')
    if ($installExit -ne 0) {
        Write-Problem ('npm install falhou com codigo ' + $installExit + '.')
        Write-Host ''
        exit 1
    }
    Write-Ok 'Dependencias de desenvolvimento instaladas.'
}

# --- 2. Compilacao ----------------------------------------------------------

Write-Stage 'npm run build'
$buildExit = Invoke-Tool -FilePath 'npm' -ArgumentList @('run', 'build')
if ($buildExit -ne 0) {
    Write-Problem ('npm run build falhou com codigo ' + $buildExit + '.')
    Write-Host ''
    exit 1
}

$cliPath = Join-Path $script:Root 'dist\cli\main.js'
if (Test-Path -LiteralPath $cliPath) {
    Write-Ok 'Compilado: dist\cli\main.js'
}
else {
    Write-Problem 'A compilacao terminou sem erro, mas dist\cli\main.js nao existe.'
    Write-Host ''
    exit 1
}

# --- 3. Verificacao de tipos ------------------------------------------------

Write-Stage 'npm run typecheck'
$typecheckExit = Invoke-Tool -FilePath 'npm' -ArgumentList @('run', 'typecheck')
if ($typecheckExit -ne 0) {
    Write-Problem ('npm run typecheck falhou com codigo ' + $typecheckExit + '.')
    Write-Host ''
    exit 1
}
Write-Ok 'Verificacao de tipos sem erros.'

Write-Host ''
Write-Host '  Build concluido com sucesso.' -ForegroundColor Green
Write-Detail 'Use DIAGNOSTICO.cmd para revalidar o ambiente.'
Write-Host ''
exit 0
