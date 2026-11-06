#!/bin/sh
# LuCI branding for the openNDS native click-to-continue ThemeSpec.
# The native landing_page/auth_log functions retain token validation and quotas.
. /usr/lib/opennds/theme_click-to-continue-basic.sh

portal_escape() {
	sed -e 's/\&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g' \
		-e 's/"/\&quot;/g' -e "s/'/\&#39;/g" -e 's/`/\&#96;/g'
}

header() {
	unset portal_title portal_subtitle portal_button portal_terms portal_footer portal_color portal_logo
	eval "$(jsonfilter -i /etc/opennds/portal_theme.json \
		-e 'portal_title=@.title' -e 'portal_subtitle=@.subtitle' \
		-e 'portal_button=@.btnText' -e 'portal_terms=@.terms' \
		-e 'portal_footer=@.footer' -e 'portal_color=@.primaryColor' \
		-e 'portal_logo=@.logo' 2>/dev/null)"
	portal_title=$(printf '%s' "${portal_title:-openNDS}" | portal_escape)
	portal_subtitle=$(printf '%s' "$portal_subtitle" | portal_escape)
	portal_button=$(printf '%s' "${portal_button:-同意条款并连接互联网}" | portal_escape)
	portal_terms=$(printf '%s' "$portal_terms" | portal_escape)
	portal_footer=$(printf '%s' "$portal_footer" | portal_escape)
	case "$portal_color" in
		\#[0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F]) ;;
		*) portal_color='#0284c7' ;;
	esac
	case "$portal_logo" in
		coffee) portal_logo='CAFE' ;;
		hotel) portal_logo='HOTEL' ;;
		business) portal_logo='BIZ' ;;
		*) portal_logo='Wi-Fi' ;;
	esac
	cat <<EOF
<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Cache-Control" content="no-cache, no-store, must-revalidate">
<title>$portal_title</title>
<style>
body{margin:0;background:#020617;color:#f8fafc;font:16px system-ui,sans-serif}
main{max-width:400px;margin:5vh auto;padding:28px;text-align:center}
.logo{display:grid;place-items:center;width:72px;height:72px;margin:0 auto 20px;border-radius:20px;background:$portal_color;font-weight:bold}
h1{font-size:24px;overflow-wrap:anywhere}.subtitle,footer{color:#94a3b8;overflow-wrap:anywhere}
input[type=submit],input[type=button],button{width:100%;margin:18px 0;padding:14px;border:0;border-radius:12px;background:$portal_color;color:white;font:inherit;cursor:pointer}
.terms{white-space:pre-wrap;overflow-wrap:anywhere;color:#94a3b8;font-size:13px;text-align:left;border-top:1px solid #334155;padding-top:20px}
label{display:block;text-align:left;font-size:14px}footer{font-size:12px;margin-top:24px}
big-red{display:block;color:#ef4444;font-size:17px;font-weight:bold;margin:12px 0}
italic-black{display:block;color:#cbd5e1;font-size:14px;font-style:italic;margin:8px 0}
med-blue{display:block;color:#38bdf8;font-size:15px;margin:8px 0}
hr{border:0;border-top:1px solid #334155;margin:16px 0}
</style></head><body><main>
<div class="logo">$portal_logo</div><h1>$portal_title</h1><p class="subtitle">$portal_subtitle</p>
EOF
}

continue_form() {
	portal_fas=$(printf '%s' "$fas" | portal_escape)
	cat <<EOF
<form action="/opennds_preauth/" method="get">
<input type="hidden" name="fas" value="$portal_fas">
<input type="hidden" name="landing" value="yes">
<label><input type="checkbox" required> 已阅读并同意以下上网条款</label>
<input type="submit" value="$portal_button">
</form>
EOF
	read_terms
	footer
}

read_terms() {
	printf '<p class="terms">%s</p>\n' "$portal_terms"
}

display_terms() {
	read_terms
	footer
}

footer() {
	printf '<footer>%s</footer></main></body></html>\n' "$portal_footer"
	exit 0
}
