@echo off
chcp 65001 >nul
title Trendyol Satici Paneli - Kurulum
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0kurulum\kurulum.ps1"
if errorlevel 1 (
  echo.
  echo   KURULUM BASARISIZ. Yukaridaki hata mesajini kontrol edin.
  pause
  exit /b 1
)
timeout /t 4 >nul
