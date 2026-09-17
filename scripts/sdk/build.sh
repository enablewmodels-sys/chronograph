#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
# Tools may be installed normally or supplied explicitly. Dependencies stay local.
SDK_TOOLS="${SDK_TOOLS:-$PWD/.work/sdk-tools}"
GO="${GO:-go}"
DOTNET="${DOTNET:-dotnet}"
GSON_JAR="${GSON_JAR:-$SDK_TOOLS/gson.jar}"
JSON_INCLUDE="${JSON_INCLUDE:-$SDK_TOOLS/include}"
SDK_LANGUAGES="${SDK_LANGUAGES:-typescript,go,java,cpp,dart,csharp}"
mkdir -p "$SDK_TOOLS/java-classes"
has() { [[ ",$SDK_LANGUAGES," == *",$1,"* ]]; }
if has typescript; then npm --prefix sdk/typescript ci --ignore-scripts; npm --prefix sdk/typescript run build; fi
if has go; then (cd sdk/go && "$GO" build -o "$SDK_TOOLS/go-conformance" ./cmd/conformance); fi
if has java; then javac --release 17 -cp "$GSON_JAR" -d "$SDK_TOOLS/java-classes" sdk/java/src/main/java/io/chronograph/Client.java scripts/sdk/Conformance.java; fi
if has cpp; then "${CXX:-c++}" -std=c++17 -Wall -Wextra -Werror -I sdk/cpp/include -I "$JSON_INCLUDE" $(pkg-config --cflags libcurl) scripts/sdk/conformance.cpp $(pkg-config --libs libcurl) -o "$SDK_TOOLS/cpp-conformance"; fi
if has dart; then (cd sdk/dart && dart pub get && dart analyze && dart compile exe tool/conformance.dart -o "$SDK_TOOLS/dart-conformance"); fi
if has csharp; then DOTNET_CLI_TELEMETRY_OPTOUT=1 "$DOTNET" build sdk/csharp/Conformance -o "$SDK_TOOLS/csharp-conformance" --nologo; fi
