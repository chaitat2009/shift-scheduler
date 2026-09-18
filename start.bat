@echo off
echo Starting IICS Shift Scheduler...
echo.

REM First-time setup check: ensure ortools is installed
python -c "import ortools" >nul 2>&1
if errorlevel 1 (
    echo OR-tools is not installed. Installing now...
    pip install ortools
    if errorlevel 1 (
        echo.
        echo ERROR: pip install ortools failed.
        echo Please install Python from https://python.org and re-run this script.
        pause
        exit /b 1
    )
)

node --experimental-sqlite server.js
pause
