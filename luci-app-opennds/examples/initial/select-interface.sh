#!/bin/sh
# Print one ready IPv4 gateway device; leave all device settings unchanged.

set -f
. /lib/functions.sh
. /lib/functions/network.sh

chosen_device=''

usable_device() {
	case "$1" in
		''|lo|*[!A-Za-z0-9_.:-]*) return 1 ;;
	esac
	ip link show dev "$1" 2>/dev/null | grep -q '[<,]UP[,>]' || return 1
	ip -4 addr show dev "$1" 2>/dev/null | grep -q '^[[:space:]]*inet '
}

choose_network() {
	local candidate_device
	[ -z "$chosen_device" ] || return 0
	network_is_up "$1" || return 0
	network_get_device candidate_device "$1" || return 0
	usable_device "$candidate_device" && chosen_device="$candidate_device"
	return 0
}

choose_guest_section() {
	case "$1" in
		guest|guest_*|*_guest|guest-*|*-guest) choose_network "$1" ;;
	esac
}

choose_guest_zone() {
	local zone_name zone_networks network_name
	[ -z "$chosen_device" ] || return 0
	config_get zone_name "$1" name
	case "$zone_name" in
		guest|guest_*|*_guest|guest-*|*-guest)
			config_get zone_networks "$1" network
			for network_name in $zone_networks; do
				choose_network "$network_name"
			done
			;;
	esac
}

choose_network guest
if [ -z "$chosen_device" ] && config_load network; then
	config_foreach choose_guest_section interface
fi
if [ -z "$chosen_device" ] && config_load firewall; then
	config_foreach choose_guest_zone zone
fi
for candidate_device in br-guest br-lan; do
	[ -z "$chosen_device" ] || break
	usable_device "$candidate_device" && chosen_device="$candidate_device"
done

if [ -z "$chosen_device" ]; then
	printf 'No ready IPv4 guest interface or br-lan device was found.\n' >&2
	exit 1
fi
printf '%s\n' "$chosen_device"
