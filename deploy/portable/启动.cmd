@echo off
chcp 65001 >nul
rem companion-agent 便携版入口：双击我
rem 用系统自带的 Windows PowerShell 5.1 跑启动脚本（不要求对方装 PowerShell 7）
cd /d "%~dp0"
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-companion.ps1"
