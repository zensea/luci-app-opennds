# 配置入口与验证说明

日期：2026-11-17。适用：openNDS v11、OpenWrt 24.10、luci-app-opennds 2.0.0-r3。

## 1. 交付范围

当前界面共 51 个原生配置入口，较前版增加 20 项。官方模板按名称去重列举 65 项；其余 14 项继续通过手工配置管理。此统计针对模板列举项，不表示守护进程支持项与模板完全一致。

官方源码基线为 `9477b224bfd6d7f27ab1f1931afb61580b9470d1`，插件不修改该子模块。短信功能仍单独保存在 Git stash，本次不包含短信实现。

## 2. 六个选项卡

| 选项卡 | 内容 |
| --- | --- |
| 常规设置 | 启用、接口、名称、序列号后缀、端口、客户端容量、检查周期和调试等级 |
| 认证与 FAS | 认证模式、外部 FAS、重新认证间隔、Authmon 轮询 |
| 流量控制与配额 | 会话与空闲超时、基础速率、流量配额及超额降速 |
| 访问控制与围墙花园 | 信任 MAC、预认证设备、认证前后及访问路由器规则、域名访问控制 |
| 门户与资源 | ThemeSpec 路径、状态页、页面大小、自定义参数/变量/图片/文件和资源刷新 |
| 高级与日志 | 认证日志位置与轮转、DHCP 租约路径、客户端接口扫描 |

## 3. 新增 20 项

| 编号 | 配置项 | 选项卡 | 单位、默认值与约束 |
| --- | --- | --- | --- |
| C01 | enable_serial_number_suffix | 常规 | 继承默认启用，或显式启用/停用；更改会影响 FAS 网关名称标识 |
| C02 | reauth_interval | 认证 | 秒，0 或未配置不限制，最大 4294967295；由插件钩子检查 |
| C03 | nat_traversal_poll_interval | 认证 | 1–59 秒，默认 5；仅外部 FAS 等级 3/4 显示 |
| C04 | fup_upload_throttle_rate | 流量 | kbit/s，关联上传配额；0 或未配置按原生逻辑取消认证 |
| C05 | fup_download_throttle_rate | 流量 | kbit/s，关联下载配额；0 或未配置按原生逻辑取消认证 |
| C06 | authenticated_users | 访问 | 认证后规则，每行一条，写回有序 UCI list |
| C07 | preauthenticated_users | 访问 | 认证前规则，每行一条，写回有序 UCI list |
| C08 | users_to_router | 访问 | 访问路由器规则，原生保留 DNS、DHCP、SSH、HTTPS 管理规则 |
| C09 | preemptivemac | 访问 | 显式允许预认证时显示；MAC 必填，数值非负，0/省略按原生全局继承 |
| C10 | max_page_size | 门户 | 字节，最小 1024，默认 10240；门户保存继续执行大小校验 |
| C11 | statuspath | 门户 | 绝对路径，默认原生 client_params.sh；明确设置后不会被门户保存覆盖 |
| C12 | fas_custom_parameters_list | 门户 | name=value，支持已有百分号编码，按原样保存 |
| C13 | fas_custom_variables_list | 门户 | name=value，或 input=字段:描述:类型，多字段用分号分隔 |
| C14 | fas_custom_images_list | 门户 | 名称_扩展名=URL，支持 http://、https://、file:/// |
| C15 | fas_custom_files_list | 门户 | 名称_扩展名=URL，支持 http://、https://、file:/// |
| C16 | remotes_refresh_interval | 门户 | 分钟，0 或未配置不周期刷新，最大 4294967295 |
| C17 | log_mountpoint | 高级 | 绝对路径，默认 /tmp；选择已有可写的内存或外部存储挂载点 |
| C18 | max_log_entries | 高级 | 条，默认 100；0 停止日志轮转 |
| C19 | dhcp_leases_file | 高级 | 绝对路径，留空恢复原生默认租约查找 |
| C20 | fast_client_scan | 高级 | 继承默认启用，或显式启用/停用 |

数值输入拒绝负数、小数及超出 JavaScript 安全整数范围的值。路径使用无空格、无 Shell 特殊字符的绝对路径；文件存在性、可执行性和挂载状态仍需在实际路由器核验。

新增字段用提示展示默认值，保存其他选项不会自动填入一批默认值。清空可选字段删除对应 UCI 选项。条件隐藏保留原值；自定义参数和资源在外部 FAS 或自定义 ThemeSpec 场景显示。

## 4. 列表与原生格式

八类新增列表采用多行文本，每行一条，保持顺序和重复条目，不进行自动排序、去重或重复 URL 编码。空白行不写入 UCI。

访问规则示例：

```text
block all to 192.0.2.0/24
allow tcp port 443 to 192.0.2.10
allow all
```

必须明确填写 all，或带端口的 tcp/udp。固定版本原生解析器会误解 `block to 地址` 及无端口的 `allow tcp`，界面拒绝这些写法，避免放行范围扩大或地址条件丢失。域名需只解析到一个地址。输入顺序保留，最终执行顺序遵循原生规则处理；认证后的自定义规则会替换默认 allow-all 策略。

预认证设备示例：

```text
mac=02:00:00:00:00:01;sessiontimeout=60;uploadrate=100;downloadrate=1000;uploadquota=0;downloadquota=0;custom=room-1
```

支持 mac、sessiontimeout、uploadrate、downloadrate、uploadquota、downloadquota、custom，拒绝重复键和未知键。custom 支持字母、数字和 `_ . : @ + / -`。与 trustedmac 不同，预认证设备仍保留流量统计、额度和超时。

资源示例：

```text
message=hello%20world%27s
input=phone:Phone%20number:tel;postcode:Postcode:text
logo_png=https://example.com/logo.png?v=1%26size=2
advert_htm=file:///mnt/usb/advert.htm
```

这些示例分别属于参数、变量、图片和文件列表。变量名使用字母或下划线开头的简单名称；空格、单引号及 URL 分隔符按字段说明编码。input 类型支持 text、email、tel、number、password、date、url。

## 5. 状态页和重新认证间隔

保存门户仍执行现有本地 ThemeSpec 启用流程；仅在 statuspath 未配置时选择插件品牌状态页。已明确选择原生或自定义脚本的设备保留原值，页面不会因保存品牌而被换回。未配置状态页后直接保存门户，会选择插件状态页。

固定源码中 BinAuth 加载 `/usr/check_reauth_interval.sh`，而官方打包将检查脚本放到 `/usr/lib/opennds/`，且原检查脚本存在语法及动作匹配问题。插件在实际加载路径提供独立钩子，通过原生库读取配置，不改动官方脚本或守护进程。

钩子在 auth_client/auth 阶段检查同一 MAC 最近的原生 `_deauth` 记录。间隔内返回拒绝，达到边界时间允许；无历史记录允许，已有拒绝结果不会被重置。日志按字段读取，不作为 Shell 执行。它不修改原生配额输出，也不替代后续 custombinauth。

由于检查基于本地 BinAuth 日志，日志轮转、清空或路由器重启后丢失的历史无法继续用于等待时间判断。该选项不提供跨重启的持久封禁。

## 6. 验证与交付状态

- 字段回归：51 项唯一入口、6 个选项卡、20 项分组、默认继承、0/空值、边界与错误输入、隐藏值保留、列表顺序/重复和编码。
- 原生 UCI/ucode：扩展配置保存回读，未知值与设备密钥保留，自定义 statuspath 与页面大小保持。
- 原生脚本：用官方 BinAuth 和插件钩子验证 auth_client、ndsctl_auth、preemptive_auth、client_auth；真实时间边界、错误配置、无历史记录、原生配额输出均检查。nft 使用捕获器，不修改测试机防火墙。
- 浏览器：实际 LuCI form/ui/validation/UCI/RPC，验证字段联动、保存及重载、条件隐藏、清空列表和六个选项卡的手机布局。本地 ubus 与设备发现使用替身。

真实路由器的防火墙生效、资源下载、配额降速、文件权限及挂载状态仍需实机验收。SDK 打包沿用现有 GitHub Actions，提交后自动触发；本次实现不自动提交或推送。
