# 初始配置示例

适用于已经安装本插件及依赖、通过路由器上网的访客网络。终端阅读条款并点击同意后上网，门户使用本插件的本地 ThemeSpec 模板。

示例按 `br-lan` 设计，应用后该接口上的普通终端将进入认证流程。若已有独立访客网络，将 `gateway.uci` 中的 `br-lan` 改为对应设备名，例如 `br-guest`。接口必须已经存在并具有 IPv4 地址，客户端的 DHCP、DNS 和路由上网也应已经正常；本示例不创建网络、DHCP、SSID 或防火墙隔离策略。

## 配置内容

| 项目 | 初始值 | 说明 |
| --- | --- | --- |
| 网关接口 | `br-lan` | 按实际访客网络修改 |
| 网关名称 | 访客 Wi-Fi | 与门户标题一致 |
| 认证方式 | `login_option_enabled=3` | 使用 `/usr/lib/opennds/theme_luci.sh` |
| 外部 FAS | `fasport=0` | 使用本地点击同意流程 |
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

`gateway.uci` 是更新现有 section 的 **UCI 批处理命令**，不是完整的 `/etc/config/opennds` 文件。它不会写入公共 `faskey`，也不添加信任 MAC；已有密钥和未列出的选项会保留。现有信任名单仍然有效。认证模式和 `fasport` 会按表格中的值调整，请先备份。

`portal_theme.json` 包含设计器支持的全部七个字段，使用文字图标和本地样式，无需加载外部图片或字体。

## 应用步骤

先将 `gateway.uci` 和 `portal_theme.json` 上传到路由器的 `/tmp/opennds-initial/`，检查并修改接口名称。应用前应确认以下检查均成功：

```sh
ip -4 addr show dev br-lan
test -x /usr/lib/opennds/theme_luci.sh
test -r /usr/lib/opennds/theme_click-to-continue-basic.sh
command -v jsonfilter
uci -q get opennds.@opennds[0]
uci changes opennds
```

如果修改了接口名称，第一条命令也要对应修改。`uci changes opennds` 应没有输出；如有待提交变更，先处理这些变更，再应用示例。若 section 不存在，先检查 openNDS 的安装及初始化状态。

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
mkdir -p /etc/opennds &&
portal_tmp="$(mktemp /etc/opennds/.portal-initial.XXXXXX)" &&
cp /tmp/opennds-initial/portal_theme.json "$portal_tmp" &&
chmod 600 "$portal_tmp" &&
mv -f "$portal_tmp" /etc/opennds/portal_theme.json &&
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
