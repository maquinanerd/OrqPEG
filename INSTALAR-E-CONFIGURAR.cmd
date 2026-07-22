@echo off
chcp 65001 >nul
setlocal
title OrqPEG - Instalar e configurar

rem ---------------------------------------------------------------------------
rem  OrqPEG - instalacao e configuracao assistida.
rem  Delega todo o trabalho para scripts\setup.ps1, que verifica ferramentas,
rem  instala dependencias de desenvolvimento, compila, valida schemas, roda os
rem  testes e o diagnostico. Nada e instalado globalmente sem o seu comando.
rem ---------------------------------------------------------------------------

where node >nul 2>nul
if errorlevel 1 goto sem_node

where powershell >nul 2>nul
if errorlevel 1 goto sem_powershell

if not exist "%~dp0scripts\setup.ps1" goto sem_script

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\setup.ps1" %*
set "ORQPEG_EXIT=%ERRORLEVEL%"
echo.
pause
endlocal & exit /b %ORQPEG_EXIT%

:sem_node
echo.
echo  [ERRO] O Node.js nao foi encontrado no PATH deste computador.
echo         O OrqPEG precisa do Node.js 20 ou superior para funcionar.
echo         Instale a versao LTS a partir de https://nodejs.org
echo         e depois execute INSTALAR-E-CONFIGURAR.cmd novamente.
echo.
pause
endlocal & exit /b 1

:sem_powershell
echo.
echo  [ERRO] O Windows PowerShell nao foi encontrado no PATH.
echo         Ele acompanha o Windows 10 e o Windows 11.
echo         Verifique se a pasta abaixo esta no PATH do sistema:
echo           %%SystemRoot%%\System32\WindowsPowerShell\v1.0
echo.
pause
endlocal & exit /b 1

:sem_script
echo.
echo  [ERRO] Instalador ausente: scripts\setup.ps1
echo         A copia do OrqPEG esta incompleta. Baixe o repositorio novamente
echo         a partir de https://github.com/maquinanerd/OrqPEG
echo.
pause
endlocal & exit /b 1
