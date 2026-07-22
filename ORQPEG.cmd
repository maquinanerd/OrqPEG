@echo off
chcp 65001 >nul
setlocal
title OrqPEG - Menu principal

rem ---------------------------------------------------------------------------
rem  OrqPEG - menu principal de duplo clique.
rem  Abre o menu interativo de 11 opcoes da CLI:
rem    1 Abrir painel        2 Cadastrar projeto   3 Listar projetos
rem    4 Executar projeto    5 Dry-run             6 Status
rem    7 Pausar              8 Retomar             9 Diagnostico
rem   10 Abrir documentacao  0 Sair
rem  Comando: node dist\cli\main.js menu
rem ---------------------------------------------------------------------------

where node >nul 2>nul
if errorlevel 1 goto sem_node

if not exist "%~dp0dist\cli\main.js" goto sem_build

node "%~dp0dist\cli\main.js" menu %*
set "ORQPEG_EXIT=%ERRORLEVEL%"
echo.
pause
endlocal & exit /b %ORQPEG_EXIT%

:sem_node
echo.
echo  [ERRO] O Node.js nao foi encontrado no PATH deste computador.
echo         O OrqPEG precisa do Node.js 20 ou superior para funcionar.
echo         Instale a versao LTS a partir de https://nodejs.org
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
