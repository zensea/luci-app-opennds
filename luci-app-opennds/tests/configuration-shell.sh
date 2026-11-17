#!/bin/bash
set -euo pipefail
app=$1
fixture=$2
mkdir -p "$fixture/bin" "$fixture/log/ndslog" "$fixture/native/ndscids"
export CONFIG_FIXTURE="$fixture"
cat > "$fixture/lib.sh" <<'LIB'
#!/bin/sh
case "$1:$2" in
	get_option_from_config:reauth_interval) cat "$CONFIG_FIXTURE/interval" ;;
	get_option_from_config:log_mountpoint) printf '%s/log' "$CONFIG_FIXTURE" ;;
	write_log:*) printf '%s\n' "$2" >> "$CONFIG_FIXTURE/log/ndslog/$3" ;;
esac
LIB
cat > "$fixture/bin/ndscfg" <<'NDSCFG'
#!/bin/sh
exec "$CONFIG_FIXTURE/lib.sh" "$@"
NDSCFG
cat > "$fixture/bin/ndsctl" <<'NDSCTL'
#!/bin/sh
if [ "$1" = b64encode ]; then printf '%s' "$2" | base64 | tr -d '\n'; fi
NDSCTL
cat > "$fixture/bin/date" <<'DATE'
#!/bin/sh
if [ "$1" = +%s ]; then cat "$CONFIG_FIXTURE/clock"; else /bin/date "$@"; fi
DATE
printf '#!/bin/sh\nprintf "br-guest - -"\n' > "$fixture/interface.sh"
chmod 755 "$fixture/lib.sh" "$fixture/bin/"* "$fixture/interface.sh"
sed "s|/usr/lib/opennds/libopennds.sh|$fixture/lib.sh|g" "$app/root/usr/check_reauth_interval.sh" > "$fixture/reauth.sh"
sed -e "s|/usr/lib/opennds/libopennds.sh|$fixture/lib.sh|g" \
	-e "s|/usr/lib/opennds/get_client_interface.sh|$fixture/interface.sh|g" \
	-e "s|/usr/check_reauth_interval.sh|$fixture/reauth.sh|g" \
	-e "s|mountpoint=\"/tmp\"|mountpoint=\"$fixture/native\"|" \
	-e 's|tempdir="/tmp /run /var"|tempdir=""|' \
	"$app/../opennds/forward_authentication_service/binauth/binauth_log.sh" > "$fixture/binauth.sh"
export PATH="$fixture/bin:$PATH"
printf '600' > "$fixture/interval"
for action in auth_client ndsctl_auth preemptive_auth client_auth; do
	for clock in 1499 1500 1600; do
		printf '%s' "$clock" > "$fixture/clock"
		cat > "$fixture/log/ndslog/binauthlog.log" <<'LOG'
2026-01-01 method="client_deauth", clientmac="02:00:00:00:00:01", timestamp=900, bytes_incoming=0, bytes_outgoing=0
2026-01-01 method="idle_deauth", clientmac="02:00:00:00:00:02", timestamp=1400, custom="$(touch should-not-execute)"
LOG
		result=0
		if [ "$action" = auth_client ]; then
			sh "$fixture/binauth.sh" "$action" '02:00:00:00:00:01' url agent '192.0.2.10' token custom > "$fixture/result" || result=$?
		else
			sh "$fixture/binauth.sh" "$action" '02:00:00:00:00:01' 0 0 500 2000 token custom > "$fixture/result" || result=$?
		fi
		if [ "$clock" -lt 1500 ]; then test "$result" -eq 1; else test "$result" -eq 0; fi
		grep -qx '0 0 0 0 0' "$fixture/result"
	done
done
while read -r interval clock expected; do
	printf '%s' "$interval" > "$fixture/interval"
	printf '%s' "$clock" > "$fixture/clock"
	printf 'method="client_deauth", clientmac="02:00:00:00:00:01", timestamp=900\n' > "$fixture/log/ndslog/binauthlog.log"
	result=0
	sh "$fixture/binauth.sh" auth_client '02:00:00:00:00:01' url agent '192.0.2.10' token custom > "$fixture/result" 2> "$fixture/error" || result=$?
	if [ "$result" -ne "$expected" ] || [ -s "$fixture/error" ]; then
		printf 'Decimal interval %s at %s: expected exit %s, got %s\n' "$interval" "$clock" "$expected" "$result" >&2
		cat "$fixture/error" >&2
		exit 1
	fi
	grep -qx '0 0 0 0 0' "$fixture/result"
done <<'DECIMAL_CASES'
08 907 1
08 908 0
09 908 1
09 909 0
010 908 1
010 909 1
010 910 0
010 911 0
0000000000000000000008 907 1
0000000000000000000008 908 0
000 900 0
0000000000000000000000 900 0
0004294967295 4294968194 1
0004294967295 4294968195 0
0004294967296 900 1
DECIMAL_CASES
for interval in '' 0 600 bad 999999999999999999999; do
	printf '%s' "$interval" > "$fixture/interval"
	printf '1000' > "$fixture/clock"
	printf '' > "$fixture/log/ndslog/binauthlog.log"
	result=0
	sh "$fixture/binauth.sh" auth_client '02:00:00:00:00:01' url agent '192.0.2.10' token custom > "$fixture/result" || result=$?
	case "$interval" in bad|999*) test "$result" -eq 1 ;; *) test "$result" -eq 0 ;; esac
done
printf '600' > "$fixture/interval"
action=deauth exitlevel=1 clientmac='02:00:00:00:00:01' logdir="$fixture/log/ndslog/"
. "$fixture/reauth.sh"
test "$exitlevel" -eq 1

# Execute the fixed native ruleset function with a capture-only nft command.
awk '/^create_client_ruleset \(\) \{/ {copy=1} copy {print} copy && /^\}$/ {exit}' \
	"$app/../opennds/forward_authentication_service/libs/libopennds.sh" > "$fixture/rules.sh"
. "$fixture/rules.sh"
# The upstream library runs without nounset and references unset optional fields.
set +eu
urldecode() { urldecoded=$(printf '%b' "${1//%/\\x}"); }
nft() { printf '%s\n' "$*" >> "$fixture/nft"; }
ruleset_name=authenticated_users
ruleset='block%20all%20to%20192.0.2.0/24 allow%20tcp%20port%20443%20to%20192.0.2.10 allow%20all'
create_client_ruleset
set -e
grep -q 'ip daddr 192.0.2.0/24.*counter drop' "$fixture/nft"
grep -q 'ip daddr 192.0.2.10 tcp dport 443 counter accept' "$fixture/nft"
test "$(head -n 1 "$fixture/nft")" = 'insert rule inet nds_filter ndsAUT index 2     counter accept'
ruleset_name=users_to_router ruleset='allow%20tcp%20port%208080'
set +e
create_client_ruleset
set -e
grep -q 'ndsRTR.*tcp dport 8080 counter accept' "$fixture/nft"
grep -q 'ndsRTR.*tcp dport 443 counter accept' "$fixture/nft"
printf 'Native BinAuth hook accepts expired intervals, rejects early login, preserves quotas and captures address-specific rules\n'
