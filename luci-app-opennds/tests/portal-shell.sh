#!/bin/bash
set -euo pipefail

template=$1
fixture=$2
export LD_LIBRARY_PATH
"${OPENNDS_JSONFILTER:?}" -h >/dev/null
printf '%s\n' '{"title":"Bill\u0027s <Wi-Fi> & `literal` $(literal)","subtitle":"Welcome","logo":"coffee","primaryColor":"#123abc","btnText":"Connect","terms":"Line 1\nLine 2 & privacy","footer":"Guest"}' > "$fixture/portal.json"
sed -e 's|\. /usr/lib/opennds/theme_click-to-continue-basic.sh|generate_splash_sequence() { continue_form; }|' \
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
printf '{}\n' > "$fixture/portal.json"
PATH="$fixture/bin:$PATH" portal_title=stale bash -c '. "$1"; header; continue_form' sh "$fixture/theme.sh" > "$fixture/empty.html"
grep -Fq '<title>openNDS</title>' "$fixture/empty.html"
printf 'Native jsonfilter and portal shell checks passed\n'
