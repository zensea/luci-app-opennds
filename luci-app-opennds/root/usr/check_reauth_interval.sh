#!/bin/sh
# Sourced at the path expected by the pinned openNDS v11 BinAuth script.
# Keep native quota, logging and custombinauth processing in its caller.
luci_opennds_check_reauth() {
	local interval last now directory
	[ "${exitlevel:-0}" = 0 ] || return 0
	case "${action:-}" in auth_client|auth) ;; *) return 0 ;; esac
	interval=$(/usr/lib/opennds/libopennds.sh get_option_from_config reauth_interval 2>/dev/null)
	case "$interval" in ''|0) return 0 ;; *[!0-9]*) exitlevel=1; return 0 ;; esac
	# Shell arithmetic treats leading zeros as octal; use decimal digits instead.
	interval=${interval#"${interval%%[!0]*}"}
	[ -n "$interval" ] || return 0
	if [ "${#interval}" -gt 10 ] || [ "$interval" -gt 4294967295 ]; then
		exitlevel=1
		return 0
	fi
	printf '%s\n' "${clientmac:-}" | grep -Eq '^([0-9a-fA-F]{2}:){5}[0-9a-fA-F]{2}$' || { exitlevel=1; return 0; }
	directory=$(/usr/lib/opennds/libopennds.sh get_option_from_config log_mountpoint 2>/dev/null)
	if [ -n "$directory" ]; then directory="$directory/ndslog/"; else directory="$logdir"; fi
	[ -r "${directory}binauthlog.log" ] || return 0
	# Parse only native fields; log contents are never evaluated as shell code.
	last=$(awk -F', ' -v mac="$clientmac" '
		{
			address=""; method=""; timestamp=""
			for (i=1; i<=NF; i++) {
				field=$i
				if (field ~ /clientmac=/) { sub(/^.*clientmac="?/, "", field); sub(/".*$/, "", field); address=field }
				else if (field ~ /method=/) { sub(/^.*method="?/, "", field); sub(/".*$/, "", field); method=field }
				else if (field ~ /^timestamp=/) { sub(/^timestamp=/, "", field); timestamp=field }
			}
			if (tolower(address)==tolower(mac) && method ~ /_deauth$/ && timestamp ~ /^[0-9]+$/) last=timestamp
		}
		END { print last }
	' "${directory}binauthlog.log")
	case "$last" in ''|*[!0-9]*) return 0 ;; esac
	# Bound arithmetic even if a malformed local log has a huge timestamp.
	[ "${#last}" -le 10 ] || { exitlevel=1; return 0; }
	now=$(date +%s)
	case "$now" in ''|*[!0-9]*) exitlevel=1; return 0 ;; esac
	if [ "$now" -lt "$((last + interval))" ]; then exitlevel=1; fi
}
luci_opennds_check_reauth
