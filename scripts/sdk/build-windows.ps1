$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true
Set-Location (Join-Path $PSScriptRoot '../..')
$Source = if ($env:SDK_SOURCE_ROOT) { $env:SDK_SOURCE_ROOT } else { Join-Path $PWD 'sdk' }
$Tools = if ($env:SDK_TOOLS) { $env:SDK_TOOLS } else { Join-Path $PWD '.work/sdk-tools' }
New-Item -ItemType Directory -Force (Join-Path $Tools 'java-classes') | Out-Null
npm --prefix "$Source/typescript" ci --ignore-scripts
npm --prefix "$Source/typescript" run build
Push-Location "$Source/go"
try { go build -o "$Tools/go-conformance.exe" ./cmd/conformance } finally { Pop-Location }
javac --release 17 -cp "$Tools/gson.jar" -d "$Tools/java-classes" "$Source/java/src/main/java/io/chronograph/Client.java" scripts/sdk/Conformance.java
$CurlFlags = ((& C:/msys64/ucrt64/bin/pkg-config.exe --cflags --libs libcurl) -split '\s+') | Where-Object { $_ }
& C:/msys64/ucrt64/bin/g++.exe -std=c++17 -pthread -Wall -Wextra -Werror "-I$Source/cpp/include" "-I$Tools/include" scripts/sdk/conformance.cpp @CurlFlags -o "$Tools/cpp-conformance.exe"
Push-Location "$Source/dart"
try {
  dart pub get
  dart analyze
  dart compile exe tool/conformance.dart -o "$Tools/dart-conformance.exe"
} finally { Pop-Location }
dotnet build "$Source/csharp/Conformance" -o "$Tools/csharp-conformance" --nologo
