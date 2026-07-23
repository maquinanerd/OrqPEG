@echo off
chcp 65001 >nul
setlocal
title OrqPEG - Iniciar painel

rem ---------------------------------------------------------------------------
rem  OrqPEG - inicia o servidor do painel em 127.0.0.1.
rem  A janela fica aberta enquanto o painel estiver no ar.
rem  Para encerrar, pressione Ctrl+C nesta janela ou use PARAR-PAINEL.cmd.
rem  Comando: node dist\cli\main.js panel start
rem ---------------------------------------------------------------------------

where node >nul 2>nul
if errorlevel 1 goto sem_node

if not exist "%~dp0dist\cli\main.js" goto sem_build

echo.
echo  Iniciando o painel do OrqPEG. Mantenha esta janela aberta.
echo  Encerre com Ctrl+C quando terminar.
echo.

node "%~dp0dist\cli\main.js" panel start %*
set "ORQPEG_EXIT=%ERRORLEVEL%"
if not "%ORQPEG_EXIT%"=="0" pause
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
