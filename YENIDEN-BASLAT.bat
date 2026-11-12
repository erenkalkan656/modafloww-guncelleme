@echo off
title Trendyol Satici Paneli - Yeniden Baslat
echo   Uygulama kapatiliyor...
taskkill /F /T /IM "Trendyol Satici Paneli.exe" >nul 2>&1
timeout /t 2 >nul
taskkill /F /T /IM "Trendyol Satici Paneli.exe" >nul 2>&1
echo   Uygulama aciliyor...
start "" "%~dp0program\Trendyol Satici Paneli.exe"
