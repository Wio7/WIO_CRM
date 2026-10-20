@echo off
setlocal
cd /d "%~dp0"
where npm.cmd >nul 2>&1
if errorlevel 1 (
  echo No se encontro Node.js / npm. Instala Node.js antes de iniciar Golden Caja.
  pause
  exit /b 1
)
echo Iniciando Golden Caja en http://localhost:3000/caja
echo Vista de ejemplo: http://localhost:3000/caja/demo
echo Manten esta ventana abierta mientras uses la vista local.
echo Para detenerla, presiona Ctrl+C.
call npm.cmd run dev -- --hostname 127.0.0.1 --port 3000
if errorlevel 1 (
  echo Golden Caja no pudo iniciar. Revisa el error anterior.
  pause
  exit /b 1
)
