# openNDS 与 LuCI 管理插件

仓库同时包含官方 openNDS 源码和 LuCI 管理插件：

```text
./
├── opennds/                 # 官方源码，Git 子模块
└── luci-app-opennds/         # LuCI 插件、翻译、示例与测试
```

获取完整源码：

```sh
git clone --recurse-submodules https://github.com/zensea/luci-app-opennds.git
```

已有克隆可执行 `git submodule update --init --recursive` 补齐官方源码。官方源码保持原样，实际提交直接从其 Git 元数据读取：

```sh
git -C opennds rev-parse HEAD
```

查看[插件使用、手工编译和验证说明](luci-app-opennds/README.md)，或进入 `opennds` 阅读官方文档。插件依赖 openNDS 本体；本体包按设备架构安装，插件与中文包为 `all` 架构。

Actions 在临时打包规则中将默认配置设为 `option enabled 0`，同时更新包内的 `/etc/config/opennds` 和 `/etc/opennds/config.uci`，官方源码及归档保持不变。新安装后需在网关配置中启用 openNDS；已有设备升级时通常保留现有配置。定制包的 release 带 `.default0` 后缀，构建时校验配置只发生这一处预期变化。

本仓库维护的插件代码使用 [Apache-2.0](LICENSE)，官方源码保留其自身许可证与版权说明。
