# luci-app-opennds

面向 **openNDS v11、OpenWrt 24.10 和 LuCI-JS** 的认证门户管理插件。版本 2.0 不提供旧版配置迁移，只接受一个命名配置段：

```uci
config opennds 'setup'
```

## 功能

- 网关配置：接口、认证模式、外部 FAS、会话与空闲超时、限速、流量配额和域名访问控制。
- 永久免认证 MAC 白名单：从主机提示选择设备，也支持手动输入；保留已保存 MAC 的拼写，读取主机提示失败时仍可编辑。
- 运行总览：每 5 秒刷新进程、网关、客户端、流量和日志；提供 auth、deauth、trust、untrust 与服务重启。客户端 trust 是运行期操作，永久名单由网关配置保存。
- 门户设计器：七个品牌与文案字段、手机实时预览，通过随包 ThemeSpec 渲染访客页面。预览按钮仅演示交互。

保存门户将认证模式设为 3，选择本插件模板，并将本地 FAS 初始化端口设为 443。切换认证模式会保留外部 FAS 端口供切回时恢复。认证令牌、放行、日志和配额仍由 openNDS 原生逻辑负责。

首次部署可参考[初始配置示例](examples/initial/README.md)。示例由管理员手工应用，插件安装不自动套用示例名单或文案。

## 结构与保护

| 文件 | 职责 |
| --- | --- |
| htdocs/luci-static/resources/opennds.js | RPC 声明、总览数据读取和操作状态管理 |
| htdocs/luci-static/resources/view/opennds/ | 总览、网关配置和设计器 |
| root/usr/share/rpcd/ucode/opennds.uc | 配置检查、操作、日志及门户持久化 |
| root/usr/libexec/luci-opennds-status.uc | 在 rpcd 外合并采集 ndsctl JSON 和元数据 |
| root/usr/lib/opennds/theme_luci.sh | 单次 JSON 字段提取、HTML 转义和原生认证衔接 |

插件不安装或整体覆盖 /etc/config/opennds；文件缺失或为空时仅创建命名段，设备密钥由 openNDS 管理。配置检查不会修改文件，匿名段、多 opennds 段和其他命名段会被拒绝。

门户文案保存到 /etc/opennds/portal_theme.json，以临时文件、检查写入和 close、原子 rename 防止写失败截断当前文件，并加入 sysupgrade 保留列表。损坏或不可读的门户文件会使设计器加载失败；保存分别报告文案写入、UCI 提交和服务重启结果。

耗时命令通过 file.exec 异步执行。状态采集使用一次独立 ucode 进程，两路 ndsctl 各有 5 秒超时，一路失败仍保留另一路结果；输出达到 250,000 字节时明确失败，避免进入 rpcd 的 256 KiB 缓冲上限。采集失败和日志失败均会显示错误。

当前仅注册 OpenWrt 24.10 的 JSON ucitrack 触发器，保存并应用配置会执行 restart。门户标题的单引号在写入 gatewayname 时编码为 &#39;，JSON 保留原文。HTML 转义、字段大小、MAC、动作、颜色和图标校验均在对应边界保留。

域名围墙花园与黑名单需要具备 nftset/ipset 支持的 dnsmasq-full；FAS 安全等级 2/3 需要 PHP CLI 和 OpenSSL 模块，请按实际使用场景安装。

## 编译与部署

将插件目录放入 OpenWrt 源码树的 package/luci-app-opennds，选择本插件后执行：

```sh
make package/luci-app-opennds/clean
make package/luci-app-opennds/compile V=s
```

运行依赖由 Makefile 声明：opennds、rpcd-mod-ucode、rpcd-mod-file、rpcd-mod-luci、ucode、ucode-mod-fs、ucode-mod-uci、ucode-mod-ubus、jsonfilter 和 coreutils-timeout。守护进程必须为 v11；插件和中文包是 all 架构，opennds 本体按设备架构安装。

已安装 v11 的设备可从插件目录手工复制文件：

```sh
scp -r root/* root@192.168.1.1:/
scp -r htdocs/* root@192.168.1.1:/www/
ssh root@192.168.1.1 'sh /etc/uci-defaults/80_luci-app-opennds'
```

部署前应备份设备配置；部署后刷新 LuCI，并检查：

```sh
ubus -v list luci.opennds
ubus call luci.opennds check_config
ubus call luci.opennds status
ubus call luci.opennds get_portal
```

保存返回成功后，仍应确认守护进程实际运行，再用访客设备验证条款、认证和流量统计。

## 验证

在插件目录执行 Node 回归：

```sh
node --test tests/*.test.cjs
```

Linux 原生检查使用固定版本 ucode、UCI、libubox 和 jsonfilter，需要 curl、tar、CMake、C 编译器及 libjson-c 开发包，并以普通用户运行：

```sh
bash tests/run-native.sh
```

原生检查覆盖实际 UCI/文件系统权限、门户持久化、合并采集器和真实 jsonfilter 转义。进程及路由器服务仍使用替身，不能替代设备认证联调。

可选浏览器检查使用 playwright-core、本地 Chrome/Edge，以及官方 openwrt-24.10 的 luci.js 和 Bootstrap cascade.css：

```sh
OPENNDS_LUCI_ASSETS=/path/to/luci-assets node tests/browser.cjs
```

可通过 OPENNDS_PLAYWRIGHT 指定 playwright-core 模块路径，OPENNDS_BROWSER 指定浏览器可执行文件，OPENNDS_BROWSER_OUTPUT 指定证据目录，OPENNDS_BASELINE 指定重构前插件目录以保存对照截图。浏览器测试使用真实 LuCI DOM 工厂和本地 RPC 替身。

[重构说明与验证结果](docs/refactoring.md)记录本次范围、代码量变化和验证边界。

## License

Apache-2.0
