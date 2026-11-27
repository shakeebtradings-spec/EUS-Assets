@echo off
rem One-click JARVIS: builds the UI the first time, starts the server, opens Chrome.
cd /d "%~dp0"
if not exist frontend\node_modules (
  echo First run: installing frontend packages...
  pushd frontend
  call npm install
  popd
)
if not exist frontend\dist\index.html (
  echo Building the UI...
  pushd frontend
  call npm run build
  popd
)
start "" cmd /c "timeout /t 5 /nobreak >nul & start chrome https://localhost:8340"
echo Starting JARVIS. Close this window (or press Ctrl+C) to stop him.
python server.py --host 127.0.0.1
pause
