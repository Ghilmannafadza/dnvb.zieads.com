@echo off
REM Push dnvb.zieads.com ke GitHub (Ghilmannafadza/dnvb.zieads.com)
REM Cara pakai: klik dua kali file ini, atau jalankan dari CMD di folder ini.
cd /d "%~dp0"

where git >nul 2>nul
if errorlevel 1 (
  echo Git belum terpasang. Download di https://git-scm.com/download/win lalu jalankan file ini lagi.
  pause
  exit /b 1
)

REM Folder ini sempat diubah dari Linux VM, jadi tandai aman untuk Git Windows
git config --global --add safe.directory "%CD:\=/%"

REM Pastikan remote origin mengarah ke repo DNVB
git remote remove origin >nul 2>nul
git remote add origin https://github.com/Ghilmannafadza/dnvb.zieads.com.git
git branch -M main

echo.
echo Mengirim ke https://github.com/Ghilmannafadza/dnvb.zieads.com ...
echo Kalau muncul jendela login GitHub, pilih "Sign in with your browser".
echo.
git push -u origin main
if errorlevel 1 (
  echo.
  echo Push gagal. Lihat pesan di atas. Penyebab umum:
  echo  - Belum login GitHub: jalankan lagi dan login di jendela yang muncul.
  echo  - Akun yang login bukan Ghilmannafadza: hapus kredensial lama di Credential Manager Windows ^(github.com^), lalu ulangi.
  pause
  exit /b 1
)
echo.
echo Selesai. Cek https://github.com/Ghilmannafadza/dnvb.zieads.com
pause
