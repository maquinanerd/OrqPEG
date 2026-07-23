@echo off
chcp 65001 >nul
setlocal
title OrqPEG - Dry-run

rem ---------------------------------------------------------------------------
rem  OrqPEG - simulacao completa, sem alterar nada.
rem  Mostra o plano: prompts encontrados, branch, worktree, testes, PR e merge.
rem  Nenhum arquivo do seu projeto e tocado, nenhuma IA e chamada.
rem  Uso opcional: EXECUTAR-DRY-RUN.cmd meu-projeto
rem  Comando: node dist\cli\main.js run --dry-run
rem ---------------------------------------------------------------------------

where node >nul 2>nul
if errorlevel 1 goto sem_node

if not exist "%~dp0dist\cli\main.js" goto sem_build

node "%~dp0dist\cli\main.js" run --dry-run %*
set "ORQPEG_EXIT=%ERRORLEVEL%"
echo.
pause
endlocal & exit /b %ORQPEG_EXIT%

:sem_node
echo.
echo  [ERRO] O Node.js nao foi encontrado no PATH deste computador.
echo         Instale a versao LTS 20 ou superior a partir de https://nodejs.org
echo         e depois abra este arquivo novamente.
echo.
pause
endlocal & exit /b 1

:sem_build
echo.
echo  [ERRO] O OrqPEG ainda nao foi compilado.
echo         Arquivo ausente: dist\cli\main.js
echo         Execute primeiro INSTALAR-E-CONFIGURAR.cmd, nesta mesma pasta.
echo.
pause
endlocal & exit /b 1
