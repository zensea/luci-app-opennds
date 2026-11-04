include $(TOPDIR)/rules.mk

LUCI_TITLE:=LuCI support for openNDS Captive Portal
LUCI_DESCRIPTION:=LuCI WebUI for openNDS (Open Network Demarcation Service) Captive Portal daemon.
LUCI_DEPENDS:=+opennds +rpcd-mod-ucode +rpcd-mod-file +ucode +ucode-mod-fs +ucode-mod-uci +ucode-mod-ubus +jsonfilter +coreutils-timeout
LUCI_PKGARCH:=all

PKG_NAME:=luci-app-opennds
PKG_VERSION:=1.0.0
PKG_RELEASE:=4
PKG_LICENSE:=Apache-2.0
PKG_LICENSE_FILES:=LICENSE
PKG_MAINTAINER:=OpenWrt Community

include $(TOPDIR)/feeds/luci/luci.mk
