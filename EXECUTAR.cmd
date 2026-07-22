@echo off
chcp 65001 >nul
setlocal
title OrqPEG - Executar projeto

rem ---------------------------------------------------------------------------
rem  OrqPEG - execucao real de um projeto.
rem  Roda os prompts em ordem com Claude, testa, revisa com Codex, commita,
rem  abre o PR e, se o projeto permitir, faz o merge por consenso.
rem  Ctrl+C interrompe com seguranca: codigo, branch, worktree e logs ficam.
rem  Uso opcional: EXECUTAR.cmd meu-projeto
rem  Comando: node dist\cli\main.js run
rem ---------------------------------------------------------------------------

where node >nul 2>nul
if errorlevel 1 goto sem_node

if not exist "%~dp0dist\cli\main.js" goto sem_build

node "%~dp0dist\cli\main.js" run %*
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
