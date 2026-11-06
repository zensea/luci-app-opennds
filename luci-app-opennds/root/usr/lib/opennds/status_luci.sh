#!/bin/sh
# Read only this client's native counters; logout remains an openNDS HTTP action.
. /usr/lib/opennds/theme_luci.sh

portal_row() {
	case "$2" in
		''|Unavailable) portal_value='—' ;;
		null|Unlimited) portal_value='无限制' ;;
		*) portal_value="$2$3" ;;
	esac
	portal_value=$(printf '%s' "$portal_value" | portal_escape)
	printf '<div><dt>%s</dt><dd>%s</dd></div>\n' "$1" "$portal_value"
}

portal_time() {
	case "$1" in
		''|0) ;;
		*[!0-9]*) printf '%s' "$1" ;;
		*) date -d "@$1" '+%Y-%m-%d %H:%M:%S' 2>/dev/null || printf '%s' "$1" ;;
	esac
}

portal_mode=$1
portal_ip=$2
case "$portal_mode" in status|err511) ;; *) exit 1 ;; esac
case "$portal_ip" in ''|*[!0-9a-fA-F:.]*) exit 1 ;; esac
header

if [ "$portal_mode" = err511 ]; then
	cat <<EOF
<section class="result"><h2>需要认证</h2><p>请确认上网条款后连接互联网。</p></section>
<form action="/login" method="get"><button type="submit">前往认证</button></form>
EOF
	read_terms
	footer
fi

portal_sample=$(timeout -s KILL 5 ndsctl json "$portal_ip" 2>/dev/null) || portal_sample=''
set --
for field in ip mac state client_type clientif session_start session_end last_active \
	download_this_session upload_this_session download_session_avg upload_session_avg \
	download_quota upload_quota download_rate_limit_threshold upload_rate_limit_threshold \
	download_packet_rate upload_packet_rate download_bucket_size upload_bucket_size; do
	unset "client_$field"
	set -- "$@" -e "client_$field=@.$field"
done
# Optional fields can be absent even when the remaining exports are valid.
portal_values=$(jsonfilter -s "$portal_sample" "$@" 2>/dev/null) || :
eval "$portal_values"

if [ "$client_ip" != "$portal_ip" ]; then
	cat <<EOF
<section class="result" role="alert"><h2>暂时无法读取连接状态</h2><p>服务可能繁忙或会话已结束，请刷新重试。</p></section>
<form action="/" method="get"><button type="submit">刷新状态</button></form>
EOF
	footer
fi

printf '<section class="result"><h2>连接状态</h2></section><dl class="stats">\n'
portal_row 'IP 地址' "$client_ip"
portal_row 'MAC 地址' "$client_mac"
portal_row '会话开始' "$(portal_time "$client_session_start")"
portal_row '会话结束' "$(portal_time "$client_session_end")"
portal_row '本次下载' "$client_download_this_session" ' kB'
portal_row '本次上传' "$client_upload_this_session" ' kB'
portal_row '平均下载速率' "$client_download_session_avg" ' kb/s'
portal_row '平均上传速率' "$client_upload_session_avg" ' kb/s'
printf '</dl><details><summary>更多连接信息</summary><dl class="stats">\n'
portal_row '认证状态' "$client_state"
portal_row '客户端类型' "$client_client_type"
portal_row '连接接口' "$client_clientif"
portal_row '最后活动' "$(portal_time "$client_last_active")"
portal_row '下载配额' "$client_download_quota" ' kB'
portal_row '上传配额' "$client_upload_quota" ' kB'
portal_row '下载速率阈值' "$client_download_rate_limit_threshold" ' kb/s'
portal_row '上传速率阈值' "$client_upload_rate_limit_threshold" ' kb/s'
portal_row '下载包速率' "$client_download_packet_rate" ' packets/min'
portal_row '上传包速率' "$client_upload_packet_rate" ' packets/min'
portal_row '下载桶容量' "$client_download_bucket_size" ' packets'
portal_row '上传桶容量' "$client_upload_bucket_size" ' packets'
cat <<EOF
</dl></details>
<form action="/" method="get"><button type="submit">刷新状态</button></form>
<form action="/opennds_deny/" method="get"><button type="submit">退出登录</button></form>
EOF
footer
