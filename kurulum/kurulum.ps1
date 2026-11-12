# Trendyol Satıcı Paneli — Windows kurulum / güncelleme betiği
# Bu betik:
#  1) Resmî Electron çalışma zamanını GitHub'dan indirir ve SHA-256 özetini doğrular
#  2) Uygulamayı bu klasördeki "program" klasörüne kurar (tekrar çalıştırılırsa günceller)
#  3) Masaüstü ve Başlat menüsü kısayolu oluşturur
# Kullanıcı verileri (%APPDATA%\Trendyol Satici Paneli) güncellemede SİLİNMEZ.

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$Root     = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$Ver      = '39.2.7'
$Sha256   = '3464537FA4BE6B7B073F1C9B694AC2EB1F632D6EC36F6EEAC9E00D8A279F188C'
$Url      = "https://github.com/electron/electron/releases/download/v$Ver/electron-v$Ver-win32-x64.zip"
$Prog     = Join-Path $Root 'program'
$AppSrc   = Join-Path $Root 'uygulama'
$ExeName  = 'Trendyol Satici Paneli.exe'
$Exe      = Join-Path $Prog $ExeName
$Icon     = Join-Path $AppSrc 'build\app.ico'
$Cache    = Join-Path $env:LOCALAPPDATA 'TrendyolSaticiPaneli'
$Zip      = Join-Path $Cache "electron-v$Ver-win32-x64.zip"

function Bilgi($m) { Write-Host "  > $m" -ForegroundColor Cyan }
function Tamam($m) { Write-Host "  OK $m" -ForegroundColor Green }

Write-Host ''
Write-Host '  Trendyol Satici Paneli - Kurulum' -ForegroundColor Magenta
Write-Host '  ---------------------------------'

if (-not (Test-Path (Join-Path $AppSrc 'package.json'))) { throw "Uygulama dosyalari bulunamadi: $AppSrc" }
if (-not [Environment]::Is64BitOperatingSystem) { throw '64 bit Windows gerekli.' }

# Calisan kopyayi TAMAMEN kapat (ana islem + alt islemler). Kapanmazsa devam etme.
function Uygulamayi-Kapat {
  $name = 'Trendyol Satici Paneli'
  if (Get-Process -Name $name -ErrorAction SilentlyContinue) {
    Bilgi 'Acik olan uygulama kapatiliyor...'
    try { cmd.exe /c 'taskkill /F /T /IM "Trendyol Satici Paneli.exe" >nul 2>&1' } catch { }
    for ($i = 0; $i -lt 30; $i++) {
      if (-not (Get-Process -Name $name -ErrorAction SilentlyContinue)) { break }
      Get-Process -Name $name -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
      Start-Sleep -Milliseconds 500
    }
    if (Get-Process -Name $name -ErrorAction SilentlyContinue) { throw 'Uygulama kapatilamadi. Gorev Yoneticisi''nden "Trendyol Satici Paneli" islemlerini sonlandirip tekrar deneyin.' }
    Tamam 'Uygulama kapatildi.'
  }
}
Uygulamayi-Kapat

# 1) Electron calisma zamani
New-Item -ItemType Directory -Force -Path $Cache | Out-Null
$needDownload = $true
if (Test-Path $Zip) { if ((Get-FileHash $Zip -Algorithm SHA256).Hash -eq $Sha256) { $needDownload = $false } }
if ($needDownload) {
  Bilgi "Electron $Ver indiriliyor (yaklasik 110 MB, bir kez yapilir)..."
  Invoke-WebRequest -Uri $Url -OutFile $Zip -UseBasicParsing
}
$hash = (Get-FileHash $Zip -Algorithm SHA256).Hash
if ($hash -ne $Sha256) { Remove-Item $Zip -Force; throw "Indirilen dosyanin SHA-256 ozeti eslesmiyor ($hash). Kurulum guvenlik nedeniyle durduruldu." }
Tamam 'Electron dosyasi dogrulandi (SHA-256).'

$verFile = Join-Path $Prog 'electron-surum.txt'
$installedVer = if (Test-Path $verFile) { (Get-Content $verFile -Raw).Trim() } else { '' }
if ($installedVer -ne $Ver -or -not (Test-Path $Exe)) {
  Bilgi 'Calisma zamani kuruluyor...'
  if (Test-Path $Prog) { Remove-Item $Prog -Recurse -Force }
  New-Item -ItemType Directory -Force -Path $Prog | Out-Null
  Expand-Archive -Path $Zip -DestinationPath $Prog -Force
  Rename-Item -Path (Join-Path $Prog 'electron.exe') -NewName $ExeName
  $defaultApp = Join-Path $Prog 'resources\default_app.asar'
  if (Test-Path $defaultApp) { Remove-Item $defaultApp -Force }
  Set-Content -Path $verFile -Value $Ver -Encoding ASCII
}

# 2) Uygulama dosyalari (her kurulumda guncellenir)
$AppDst = Join-Path $Prog 'resources\app'
if (Test-Path $AppDst) { Remove-Item $AppDst -Recurse -Force }
Copy-Item -Path $AppSrc -Destination $AppDst -Recurse -Force
Tamam 'Uygulama dosyalari kopyalandi.'

# 3) Kisayollar
$shell = New-Object -ComObject WScript.Shell
$targets = @(
  (Join-Path ([Environment]::GetFolderPath('Desktop')) 'Trendyol Satici Paneli.lnk'),
  (Join-Path ([Environment]::GetFolderPath('Programs')) 'Trendyol Satici Paneli.lnk')
)
foreach ($lnkPath in $targets) {
  $lnk = $shell.CreateShortcut($lnkPath)
  $lnk.TargetPath = $Exe
  $lnk.WorkingDirectory = $Prog
  $lnk.IconLocation = "$Icon,0"
  $lnk.Description = 'Trendyol Satici Paneli'
  $lnk.Save()
}
Tamam 'Masaustu ve Baslat menusu kisayollari olusturuldu.'

Write-Host ''
Write-Host "  Kurulum tamamlandi: $Exe" -ForegroundColor Green
Write-Host ''
Start-Process -FilePath $Exe -WorkingDirectory $Prog
