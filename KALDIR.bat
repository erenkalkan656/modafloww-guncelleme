@echo off
chcp 65001 >nul
title Trendyol Satici Paneli - Kaldir
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0kurulum\kaldir.ps1"
pause
