@echo off
title Trendyol Satici Paneli - Ikon Yenile
echo   Kisayol ikonlari yenileniyor...
set "BAT=%~f0"
powershell -NoProfile -ExecutionPolicy Bypass -Command "$r=Split-Path -Parent $env:BAT; $exe=Join-Path $r 'program\Trendyol Satici Paneli.exe'; $ico=Join-Path $r 'uygulama\build\app.ico'; $s=New-Object -ComObject WScript.Shell; foreach($p in @([Environment]::GetFolderPath('Desktop'),[Environment]::GetFolderPath('Programs'))){ $l=$s.CreateShortcut((Join-Path $p 'Trendyol Satici Paneli.lnk')); $l.TargetPath=$exe; $l.WorkingDirectory=(Join-Path $r 'program'); $l.IconLocation=($ico+',0'); $l.Description='Trendyol Satici Paneli'; $l.Save() }"
if errorlevel 1 ( echo   Yenilenemedi. & pause & exit /b 1 )
echo   Tamam. Uygulamayi kapatip yeniden acin.
timeout /t 4 >nul
