@echo off
chcp 65001 >nul
setlocal

where code >nul 2>nul
if errorlevel 1 (
  if exist "%LOCALAPPDATA%\Programs\Microsoft VS Code\bin\code.cmd" (
    set "CODE=%LOCALAPPDATA%\Programs\Microsoft VS Code\bin\code.cmd"
  ) else if exist "%ProgramFiles%\Microsoft VS Code\bin\code.cmd" (
    set "CODE=%ProgramFiles%\Microsoft VS Code\bin\code.cmd"
  ) else (
    echo 找不到 VS Code，請先安裝 VS Code。
    pause
    exit /b 1
  )
) else (
  set "CODE=code"
)

where node >nul 2>nul
if errorlevel 1 echo [注意] 找不到 Node.js，hook 需要它才能執行，請到 https://nodejs.org 安裝 LTS 版。

rem 同一資料夾只放最新版的 .vsix
for %%f in ("%~dp0*.vsix") do call "%CODE%" --install-extension "%%f" --force

echo.
echo 安裝完成。接下來請照「安裝說明.md」第 2 步起操作（重新載入視窗、安裝 hook）。
pause
