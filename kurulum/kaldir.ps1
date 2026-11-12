# Trendyol Satıcı Paneli — kaldırma. Program klasörünü ve kısayolları siler.
# Kullanıcı verileri (%APPDATA%\Trendyol Satici Paneli) varsayılan olarak KORUNUR.
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$Prog = Join-Path $Root 'program'
$Exe  = Join-Path $Prog 'Trendyol Satici Paneli.exe'
try { cmd.exe /c 'taskkill /F /T /IM "Trendyol Satici Paneli.exe" >nul 2>&1' } catch { }
Start-Sleep -Seconds 1
Get-Process -Name 'Trendyol Satici Paneli' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 1
foreach ($p in @((Join-Path ([Environment]::GetFolderPath('Desktop')) 'Trendyol Satici Paneli.lnk'), (Join-Path ([Environment]::GetFolderPath('Programs')) 'Trendyol Satici Paneli.lnk'))) {
  if (Test-Path $p) { Remove-Item $p -Force }
}
if (Test-Path $Prog) { Remove-Item $Prog -Recurse -Force }
Write-Host '  Program ve kisayollar kaldirildi.' -ForegroundColor Green
$data = Join-Path $env:APPDATA 'Trendyol Satici Paneli'
if (Test-Path $data) {
  $a = Read-Host "  Kullanici verileri (ayarlar, API anahtarlari, islem gecmisi) da silinsin mi? Silmek icin EVET yazin"
  if ($a -eq 'EVET') { Remove-Item $data -Recurse -Force; Write-Host '  Veriler silindi.' -ForegroundColor Yellow } else { Write-Host "  Veriler korundu: $data" }
}
