# 初始配置示例

适用于已经安装 openNDS v11、本插件及依赖，通过路由器上网的访客网络。终端阅读条款并点击同意后上网，门户使用本插件的本地 ThemeSpec 模板。

应用时优先选择已就绪的访客接口，找不到时回退到 `br-lan`。所选接口上的普通终端将进入认证流程。接口必须已经存在、已启用且具有 IPv4 地址，客户端的 DHCP、DNS 和路由上网也应已经正常；本示例不创建网络、DHCP、SSID 或防火墙隔离策略。

`select-interface.sh` 只检查并输出设备名，选择顺序为：逻辑网络 `guest` → 名称为 `guest_*`、`*_guest`、`guest-*` 或 `*-guest` 的网络 → 同类命名的访客防火墙区域绑定的网络 → 设备 `br-guest` → 设备 `br-lan`。逻辑网络通过 OpenWrt 网络接口函数解析为实际三层设备名；有多个同类候选时按配置顺序选择。未启动或没有 IPv4 地址的候选会跳过，全部不可用时返回错误并停止应用。

## 配置内容

| 项目 | 初始值 | 说明 |
| --- | --- | --- |
| 网关接口 | 优先访客接口，其次 `br-lan` | 自动选择并显示最终设备名 |
| 网关名称 | 访客 Wi-Fi | 与门户标题一致 |
| 认证方式 | `login_option_enabled=3` | 使用 `/usr/lib/opennds/theme_luci.sh` |
| 本地认证初始化 | `fasport=443` | 配合模式 `3` 使用本地点击同意流程 |
| 门户端口 | `2050` | 与 LuCI 的 HTTP 端口分开 |
| 会话有效期 | 120 分钟 | 到期后重新认证 |
| 已认证空闲超时 | 15 分钟 | 释放长时间无流量的会话 |
| 未认证超时 | 5 分钟 | 清理未完成认证的终端 |
| 最大客户端数 | 50 | 作为家庭或小型访客网络的起点 |
| 状态检查间隔 | 15 秒 | 超时处理具有相应检查间隔 |
| 速率与流量配额 | 全部为 `0` | 初始不限制，连通验证后可在界面调整 |
| 页面容量 | 16384 字节 | 为中文文案和认证参数预留空间 |
| 防火墙重载钩子 | 开启 | 防火墙重载后恢复认证规则 |
| 日志级别 | `1` | 常规运行日志 |

`gateway.uci` 是更新现有 section 的 **UCI 批处理命令**，不是完整的 `/etc/config/opennds` 文件。接口由下面的应用命令单独写入，再由批处理一并提交。它不会写入公共 `faskey`，也不添加信任 MAC；已有密钥和未列出的选项会保留。现有信任名单仍然有效。认证模式和 `fasport` 会按表格中的值调整，请先备份。

`portal_theme.json` 包含设计器支持的全部七个字段，使用文字图标和本地样式，无需加载外部图片或字体。

## 应用步骤

先将 `select-interface.sh`、`gateway.uci` 和 `portal_theme.json` 上传到路由器的 `/tmp/opennds-initial/`。应用前先检查自动选择的设备，并确认以下检查均成功：

```sh
sh /tmp/opennds-initial/select-interface.sh
test -x /usr/lib/opennds/theme_luci.sh
test -r /usr/lib/opennds/theme_click-to-continue-basic.sh
command -v jsonfilter
uci -q get opennds.setup
uci changes opennds
```

第一条命令输出本次会使用的设备名，例如 `br-guest` 或 `br-lan`。如果输出 `br-lan`，应用后该网桥上的普通终端也需要认证。`uci changes opennds` 应没有输出；如有待提交变更，先处理这些变更，再应用示例。若 section 不存在，先检查 openNDS 的安装及初始化状态。

下面的应用命令要求 openNDS v11，且配置段为 `config opennds 'setup'`。插件不提供旧配置迁移。

在路由器上备份现有配置：

```sh
backup_dir="/root/opennds-before-initial-$(date +%Y%m%d-%H%M%S)"
mkdir -m 700 "$backup_dir" &&
cp -p /etc/config/opennds "$backup_dir/gateway" &&
if [ -f /etc/opennds/portal_theme.json ]; then
    cp -p /etc/opennds/portal_theme.json "$backup_dir/portal_theme.json"
fi &&
printf '备份目录：%s\n' "$backup_dir"
```

确认备份成功后应用。下面会使用示例文案替换当前门户文案；已有文案可先在示例 JSON 中修改：

```sh
case "$(opennds -v 2>&1)" in
    'This is openNDS version 11.'*) ;;
    *) printf '需要 openNDS v11，停止应用配置。\n' >&2; exit 1 ;;
esac
gateway_interface="$(sh /tmp/opennds-initial/select-interface.sh)" &&
printf '使用网关接口：%s\n' "$gateway_interface" &&
mkdir -p /etc/opennds &&
portal_tmp="$(mktemp /etc/opennds/.portal-initial.XXXXXX)" &&
cp /tmp/opennds-initial/portal_theme.json "$portal_tmp" &&
chmod 600 "$portal_tmp" &&
mv -f "$portal_tmp" /etc/opennds/portal_theme.json &&
uci set "opennds.setup.gatewayinterface=$gateway_interface" &&
uci batch < /tmp/opennds-initial/gateway.uci &&
/etc/init.d/opennds restart
```

如果此前设置了外部 FAS，切换前可记录原来的 `fasport`；完整值也保存在备份中。以上命令不会修改网络、无线或防火墙的 UCI 配置。

## 验证

```sh
ubus call luci.opennds get_portal
ubus call luci.opennds status
logread -e opennds
```

设计器应显示“访客 Wi-Fi”及示例文案，总览应显示守护进程运行。再用连接所选网络、未被信任或认证的另一台终端发起 HTTP 访问，确认能打开门户、勾选条款并放行，随后检查终端列表和流量统计。自动弹窗由终端的门户探测机制决定，不能只以是否弹窗作为验证结果。

完成实机验证后，如需开机自动运行：

```sh
/etc/init.d/opennds enable
```

恢复网关设置时，将备份目录中的 `gateway` 复制回 `/etc/config/opennds` 后重启 openNDS。如备份中有门户 JSON，也可恢复该文件。备份目录含设备密钥，应保存在设备上，不要公开上传。

参数语义参考 [openNDS 官方配置说明](https://opennds.readthedocs.io/en/stable/config.html)；具体连接与认证效果仍需按上述步骤在设备上验证。
