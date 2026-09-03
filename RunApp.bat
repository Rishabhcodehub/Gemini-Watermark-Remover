@echo off
:: 1. Go to the folder where this script is located
cd /d "%~dp0"

:: 2. Open the browser to the localhost address immediately
start "" "http://localhost:8000"

:: 3. Start the Python web server (this window will stay open to keep the server running)
echo Starting Local Server...
python -m http.server 8000