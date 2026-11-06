#!/bin/bash
set -euo pipefail

app_dir=$(cd -- "$(dirname -- "$0")/.." && pwd)
native_root=${OPENNDS_NATIVE_ROOT:-${XDG_CACHE_HOME:-$HOME/.cache}/opennds-native-3f64c808}
output_dir=${1:-$native_root/results}
mkdir -p "$native_root" "$output_dir"

# Match the fixed ucode/UCI versions used to validate the OpenWrt package.
if [ ! -x "$native_root/build/ucode" ] || [ ! -x "$native_root/jsonpath/jsonpath" ]; then
	for item in libubox:49056d178f42da98048a5d4c23f83a6f6bc6dd80 uci:16ff0badbde7e17ec3bd1f827ffe45922956cf86 jsonpath:8a86fb78235b5d7925b762b7b0934517890cc034; do
		component=${item%%:*}
		revision=${item#*:}
		mkdir -p "$native_root/$component"
		curl -fLsS --retry 2 "https://codeload.github.com/openwrt/$component/tar.gz/$revision" -o "$native_root/$component.tar.gz"
		tar -xzf "$native_root/$component.tar.gz" -C "$native_root/$component" --strip-components=1
		build_dir="$native_root/$component-build"
		# jsonpath's fixed revision generates its parser relative to the source tree.
		if [ "$component" = jsonpath ]; then build_dir="$native_root/$component"; fi
		cmake -S "$native_root/$component" -B "$build_dir" \
			-DCMAKE_POLICY_VERSION_MINIMUM=3.5 -DBUILD_LUA=OFF -DBUILD_EXAMPLES=OFF -DCMAKE_INSTALL_PREFIX="$native_root/prefix" -DCMAKE_PREFIX_PATH="$native_root/prefix" \
			-DCMAKE_EXE_LINKER_FLAGS="-L$native_root/prefix/lib -Wl,-rpath,$native_root/prefix/lib" \
			>> "$output_dir/native-build.log" 2>&1
		cmake --build "$build_dir" --parallel 2 >> "$output_dir/native-build.log" 2>&1
		cmake --install "$build_dir" >> "$output_dir/native-build.log" 2>&1
	done
	mkdir -p "$native_root/ucode"
	curl -fLsS --retry 2 https://codeload.github.com/jow-/ucode/tar.gz/3f64c8089bf3ea4847c96b91df09fbfcaec19e1d -o "$native_root/ucode.tar.gz"
	tar -xzf "$native_root/ucode.tar.gz" -C "$native_root/ucode" --strip-components=1
	cmake -S "$native_root/ucode" -B "$native_root/build" -DCMAKE_POLICY_VERSION_MINIMUM=3.5 -DCMAKE_PREFIX_PATH="$native_root/prefix" \
		-DCMAKE_C_FLAGS="-Wno-error=discarded-qualifiers -I$native_root/prefix/include" \
		-DUBUS_SUPPORT=OFF -DUCI_SUPPORT=ON -DULOOP_SUPPORT=OFF >> "$output_dir/native-build.log" 2>&1
	cmake --build "$native_root/build" --target ucode fs_lib uci_lib --parallel 2 >> "$output_dir/native-build.log" 2>&1
fi

export LD_LIBRARY_PATH="$native_root/prefix/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
test "$(id -u)" -ne 0 # Filesystem permission checks must run without root bypass.
fixture=$(mktemp -d "${TMPDIR:-/tmp}/opennds-native-test.XXXXXX")
trap 'rm -rf -- "$fixture"' EXIT
mkdir "$fixture/portal" "$fixture/config" "$fixture/status"
ucode_bin="$native_root/build/ucode"
"$ucode_bin" -L "$native_root/build" "$app_dir/tests/portal-read.uc" \
	"$app_dir/root/usr/share/rpcd/ucode/opennds.uc" "$fixture/portal" | tee "$output_dir/native-portal.log"
"$ucode_bin" -L "$native_root/build" "$app_dir/tests/configuration.uc" \
	"$app_dir/root/usr/share/rpcd/ucode/opennds.uc" "$fixture/config" | tee "$output_dir/native-configuration.log"
"$ucode_bin" -L "$native_root/build" "$app_dir/tests/status.uc" \
	"$app_dir/root/usr/libexec/luci-opennds-status.uc" | tee "$output_dir/native-status.log"
OPENNDS_JSONFILTER="$native_root/jsonpath/jsonpath" bash "$app_dir/tests/portal-shell.sh" \
	"$app_dir/root/usr/lib/opennds/theme_luci.sh" "$fixture/status" | tee "$output_dir/native-shell.log"
