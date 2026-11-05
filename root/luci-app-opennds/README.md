# luci-app-opennds

面向 **openNDS** 的 LuCI-JS 管理插件，要求设备具备 LuCI-JS、rpcd-mod-ucode 和对应 ucode 模块。支持识别 openNDS v10/v11 配置差异，并手工升级已确认的旧配置；v11 的完整路由器认证流程仍需实机验证。

## 功能

- 网关配置：网络接口、认证模式、FAS、会话超时、限速、流量配额、MAC 信任名单和域名访问名单。
- 永久免认证 MAC 白名单：读取路由器已发现的主机，按主机名、MAC 和 IP 提示选择，实际保存 MAC 地址；也支持手动输入。读取主机记录失败时会提示，并保留手动输入能力。
- 运行总览：每 5 秒刷新进程状态、版本、运行时间、终端列表、流量与日志。
- 配置升级：服务停止时检查已安装版本和配置。仅对可确认的 v11 旧配置显示“升级配置文件”按钮；其他错误保留诊断信息和日志。点击后备份原文件、迁移配置并重启；多配置段、命名冲突、语法错误或待应用修改须先手工处理。
- 终端操作：`auth`、`deauth`、`trust`、`untrust`。域名黑名单通过网关配置管理。
- 门户设计器：保存标题、颜色、图标、按钮和条款，通过随包安装的 `theme_luci.sh` 渲染真实页面。模板复用 openNDS 原生点击放行流程，认证令牌、日志和配额由 openNDS 处理。
- 保存门户会将 `login_option_enabled` 设为 `3` 并选择本插件模板，替换当前认证模式，同时按版本设置本地认证参数：v10 使用 `fasport=0`，v11 使用 `fasport=443` 触发原生本地认证初始化。设计器预览按钮仅演示交互，真实认证需要访客终端验证。

## 初始配置

首次部署可参考[初始配置示例](examples/initial/README.md)，包含接口选择脚本、网关 UCI 批处理文件和门户文案 JSON：本地点击同意认证、每次授权 2 小时、空闲 15 分钟退出、最多 50 个客户端，初始不限速和流量。应用时优先使用已就绪的访客接口，其次使用 `br-lan`，并显示最终选择结果；应用前请备份现有配置。

示例由管理员手工应用，插件安装时仍保留设备已有配置。

## 配置保护

插件不安装或整体替换 `/etc/config/opennds`。现有接口、访问策略和设备生成的 `faskey` 均予以保留；仅在文件缺失或为空时创建最小匿名 section，由守护进程提供默认值并生成密钥。

v11 检测到唯一旧匿名段时，可在运行总览手工升级为 `config opennds 'setup'`，同时转换已确认的旧本地认证参数，保留接口、密钥、列表及其他选项。检查和页面刷新不会修改配置。升级前将原始文件备份为 `/etc/config/opennds.before-v11-upgrade.<时间戳>.<序号>`，权限为 `0600`；请妥善保管，其中包含设备密钥。迁移提交或校验失败会尝试恢复原文件；若重启失败，会保留已升级配置并报告备份路径。升级不会自动迁移自定义 BinAuth 逻辑，也不保证修复所有启动错误。

门户文案保存到 `/etc/opennds/portal_theme.json`，采用临时文件和原子替换防止写入失败损坏原文件，并加入 sysupgrade 保留列表。门户保存失败会区分写入、UCI 提交和服务重启失败；部分成功时会明确提示，不会报告全部成功。文件损坏或读取失败时，设计器会报告错误并停止加载，避免将默认文案误存为新主题。大小校验包含实际 HTML 转义和标题的重复输出。

耗时命令通过 rpcd 的 `file.exec` 异步执行，不阻塞 rpcd 主循环；服务重启最长等待 15 秒。状态采集通过独立的 `/usr/libexec/luci-opennds-status.uc` 进程读取完整 ndsctl 输出，精简客户端字段和网关元数据后再返回 rpcd，避免 1,000 个客户端时超过 `file.exec` 的 256 KiB 输出上限。RPC 权限拒绝和超时会明确报错，状态读取失败不会显示为“已停止”，日志命令失败也不会显示为空日志。门户标题中的单引号在写入 `gatewayname` 时转换为 `&#39;`，门户 JSON 仍保留原始文案。检测周期 `checkinterval` 必须为大于零的整数。

本插件显式执行 `restart` 重新读取配置，并为 LuCI 23.05 的 UCI ucitrack 和 24.10+ 的 JSON ucitrack 注册变更触发器；保存并应用会重启服务。

切换到本地认证模式 `1/2/3` 时，插件将原外部 FAS 端口保存在 `luci_fasport` 中，并按版本设置本地认证端口；其他隐藏的 FAS 字段保留原值。重复保存本地模式不会把内部端口写进外部 FAS 备份。切回模式 `0` 时恢复原端口，也可在表单中修改。v10 的模式 `0` 在未配置 FAS 端口时为点击放行；v11 默认认证模式为 `1`，外部 FAS 默认端口为 `443`。

域名围墙花园和域名黑名单需要 `dnsmasq-full` 的 nftset/ipset 支持；使用 FAS 安全等级 2/3 前须安装 PHP CLI 和 OpenSSL 模块。请按设备的软件源核对这些可选运行依赖。

## 编译

将目录放入 OpenWrt 源码树的 `package/luci-app-opennds`，在 menuconfig 的 LuCI Applications 中选择本插件，然后执行：

```sh
make package/luci-app-opennds/clean
make package/luci-app-opennds/compile V=s
```

软件包依赖 `opennds`、`rpcd-mod-ucode`、`rpcd-mod-file`、`rpcd-mod-luci`、`ucode`、`ucode-mod-fs`、`ucode-mod-uci`、`ucode-mod-ubus`、`jsonfilter`、`coreutils-timeout`。安装前应核对设备软件源中的 openNDS 与所用配置、接口的兼容性。标准 OpenWrt 的 BusyBox 不一定提供 `timeout`，因此显式安装该依赖（`coreutils-timeout` 属于 packages 软件源，编译前需确保已更新安装 `packages` feed）。

## 已安装 openNDS 的设备手工部署

先在设备上确认版本、安装插件依赖并备份现有配置：

```sh
ssh root@192.168.1.1
opennds -v
opkg install rpcd-mod-ucode rpcd-mod-file rpcd-mod-luci ucode ucode-mod-fs ucode-mod-uci ucode-mod-ubus jsonfilter coreutils-timeout
cp -p /etc/config/opennds /etc/config/opennds.before-luci.$(date +%Y%m%d-%H%M%S)
exit
```

在项目目录复制安装文件。前端目标目录为 `/www/`：

```sh
scp -r root/* root@192.168.1.1:/
scp -r htdocs/* root@192.168.1.1:/www/
ssh root@192.168.1.1 'sh /etc/uci-defaults/80_luci-app-opennds'
```

初始化脚本会设置 ThemeSpec 执行权限、注册配置应用联动并刷新 rpcd。刷新 LuCI 后进入“服务 → openNDS 认证门户”。

部署后可在路由器上进行只读检查：

```sh
ucode /usr/share/rpcd/ucode/opennds.uc
ubus -v list luci.opennds
ubus call luci.opennds status
ubus call luci.opennds get_portal
```

门户保存成功表示配置已持久化且重启命令返回成功；守护进程最终运行状态应在总览确认，再由访客终端测试条款确认、认证和流量统计。

如果曾部署旧模板，请先检查现有配置中的示例免认证 MAC、示例 FAS 地址和共享密钥。本次升级不会自动删除用户现有访问名单，也不会主动轮换现有密钥。

## 本地验证

在仓库根目录先进入插件目录：`cd root/luci-app-opennds`。

```sh
node --test tests/regression.test.cjs
```

本地检查覆盖前端业务返回码、ubus 错误码与 RPC 拒绝后的恢复、异步命令期间的请求处理、停止状态刷新、JSON 字段、信任名单、认证时长、门户原子写入失败、标题单引号兼容和模板 HTML 转义；另验证 FAS 模式往返切换、损坏或不可读门户的加载保护、转义后的大小限制、日志执行失败和 1,000 条客户端记录的精简输出。RPC 后端和状态采集器使用内存 UCI/文件系统及进程替身执行逻辑；这不能代替真实 ucode、SDK 构建及路由器认证联调。

## License

Apache-2.0
