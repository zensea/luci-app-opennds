#!/bin/bash
set -euo pipefail

template=$1
fixture=$2
status_template=$3
export LD_LIBRARY_PATH
"${OPENNDS_JSONFILTER:?}" -h >/dev/null
printf '%s\n' '{"title":"Bill\u0027s <Wi-Fi> & `literal` $(literal)","subtitle":"Welcome","logo":"coffee","primaryColor":"#123abc","btnText":"Connect","terms":"Line 1\nLine 2 & privacy","footer":"Guest"}' > "$fixture/portal.json"
cat > "$fixture/native.sh" <<'EOF'
generate_splash_sequence() { continue_form; }
configure_log_location() { mountpoint="$TEST_STATE"; }
auth_log() {
	printf '%s\n' "$key|$quotas|$custom" >> "$TEST_AUTH_LOG"
	ndsstatus="$TEST_AUTH_STATUS"
}
EOF
export TEST_NATIVE="$fixture/native.sh" TEST_STATE="$fixture" TEST_AUTH_LOG="$fixture/auth.log"
mkdir "$fixture/ndscids"
printf "key='native-test-key'\n" > "$fixture/ndscids/ndsinfo"
sed -e 's|\. /usr/lib/opennds/theme_click-to-continue-basic.sh|. "$TEST_NATIVE"|' \
	-e "s|/etc/opennds/portal_theme.json|$fixture/portal.json|g" "$template" > "$fixture/theme.sh"
mkdir "$fixture/bin"
printf '#!/bin/sh\nexec "%s" "$@"\n' "$OPENNDS_JSONFILTER" > "$fixture/bin/jsonfilter"
chmod +x "$fixture/bin/jsonfilter"
PATH="$fixture/bin:$PATH" bash -c '. "$1"; fas="token\"&<"; header; generate_splash_sequence' sh "$fixture/theme.sh" > "$fixture/page.html"
grep -Fq 'Bill&#39;s &lt;Wi-Fi&gt; &amp; &#96;literal&#96; $(literal)' "$fixture/page.html"
grep -Fq 'token&quot;&amp;&lt;' "$fixture/page.html"
grep -Fq 'background:#123abc' "$fixture/page.html"
grep -Fq 'Line 2 &amp; privacy' "$fixture/page.html"
grep -Fq '</html>' "$fixture/page.html"
for result in authenticated failed busy; do
	PATH="$fixture/bin:$PATH" TEST_AUTH_STATUS="$result" bash -c '. "$1"; fas="token\"&<"; quotas="15 100 200 300 400"; custom=custom-token; header; landing_page' sh "$fixture/theme.sh" > "$fixture/$result.html"
	grep -Fq 'Bill&#39;s &lt;Wi-Fi&gt;' "$fixture/$result.html"
	grep -Fq 'background:#123abc' "$fixture/$result.html"
	grep -Fq '</html>' "$fixture/$result.html"
	if [ "$result" = authenticated ]; then
		grep -Fq '认证成功' "$fixture/$result.html"
		grep -Fq '查看连接状态' "$fixture/$result.html"
	else
		grep -Fq '认证未完成' "$fixture/$result.html"
		grep -Fq 'token&quot;&amp;&lt;' "$fixture/$result.html"
		! grep -Fq '认证成功' "$fixture/$result.html"
	fi
done
test "$(wc -l < "$TEST_AUTH_LOG")" -eq 3
test "$(sort -u "$TEST_AUTH_LOG")" = 'native-test-key|15 100 200 300 400|custom-token'
PATH="$fixture/bin:$PATH" bash -c '. "$1"; status=authenticated; header; check_authenticated' sh "$fixture/theme.sh" > "$fixture/already-authenticated.html"
grep -Fq '认证成功' "$fixture/already-authenticated.html"
test "$(wc -l < "$TEST_AUTH_LOG")" -eq 3
sed 's|\. /usr/lib/opennds/theme_luci.sh|. "$TEST_PORTAL_THEME"|' "$status_template" > "$fixture/status.sh"
export TEST_PORTAL_THEME="$fixture/theme.sh" TEST_CLIENT_JSON="$fixture/client.json" TEST_STATUS_TRACE="$fixture/status.trace"
cat > "$fixture/bin/ndsctl" <<'EOF'
#!/bin/sh
printf '%s %s\n' "$1" "$2" >> "$TEST_STATUS_TRACE"
test "$1" = json && test "$2" = 192.0.2.10 || exit 1
test "${TEST_NDSCTL_FAILURE:-0}" = 0 || exit 1
cat "$TEST_CLIENT_JSON"
EOF
chmod +x "$fixture/bin/ndsctl"
printf '%s\n' '{"ip":"192.0.2.10","mac":"02:00:00:00:00:01","state":"Authenticated","client_type":"cpd_can","clientif":"<img src=x onerror=alert(1)>","session_start":"1793664000","session_end":"null","last_active":"1793664100","download_this_session":"4096","upload_this_session":"512","download_session_avg":"100.00","upload_session_avg":"20.00","download_quota":"null","upload_quota":"10000","token":"private-token","faskey":"private-key"}' > "$TEST_CLIENT_JSON"
PATH="$fixture/bin:$PATH" bash "$fixture/status.sh" status 192.0.2.10 > "$fixture/status.html"
test "$(cat "$TEST_STATUS_TRACE")" = 'json 192.0.2.10'
grep -Fq '连接状态' "$fixture/status.html"
grep -Fq '4096 kB' "$fixture/status.html"
grep -Fq '512 kB' "$fixture/status.html"
grep -Fq '无限制' "$fixture/status.html"
grep -Fq '&lt;img src=x onerror=alert(1)&gt;' "$fixture/status.html"
grep -Fq '<details><summary>更多连接信息</summary>' "$fixture/status.html"
grep -Fq 'action="/opennds_deny/"' "$fixture/status.html"
grep -Fq 'background:#123abc' "$fixture/status.html"
! grep -Eq 'private-token|private-key|<img src=x' "$fixture/status.html"
PATH="$fixture/bin:$PATH" bash "$fixture/status.sh" err511 192.0.2.10 > "$fixture/err511.html"
grep -Fq '需要认证' "$fixture/err511.html"
grep -Fq 'action="/login"' "$fixture/err511.html"
test "$(wc -l < "$TEST_STATUS_TRACE")" -eq 1
printf '{}\n' > "$TEST_CLIENT_JSON"
PATH="$fixture/bin:$PATH" bash "$fixture/status.sh" status 192.0.2.10 > "$fixture/status-unavailable.html"
grep -Fq '暂时无法读取连接状态' "$fixture/status-unavailable.html"
! grep -Fq '4096 kB' "$fixture/status-unavailable.html"
for sample in 'invalid JSON' '{"ip":"192.0.2.11","download_this_session":"9999"}'; do
	printf '%s\n' "$sample" > "$TEST_CLIENT_JSON"
	PATH="$fixture/bin:$PATH" bash "$fixture/status.sh" status 192.0.2.10 > "$fixture/status-invalid.html"
	grep -Fq '暂时无法读取连接状态' "$fixture/status-invalid.html"
	! grep -Fq '9999 kB' "$fixture/status-invalid.html"
done
PATH="$fixture/bin:$PATH" TEST_NDSCTL_FAILURE=1 bash "$fixture/status.sh" status 192.0.2.10 > "$fixture/status-busy.html"
grep -Fq '暂时无法读取连接状态' "$fixture/status-busy.html"
printf '{}\n' > "$fixture/portal.json"
PATH="$fixture/bin:$PATH" portal_title=stale bash -c '. "$1"; header; continue_form' sh "$fixture/theme.sh" > "$fixture/empty.html"
grep -Fq '<title>openNDS</title>' "$fixture/empty.html"
printf 'Native jsonfilter, portal results and client status page checks passed\n'
