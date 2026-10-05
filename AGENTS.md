# FearDesk 复盘项目约束

本项目按用户要求使用 gstack 进行需求、工程设计、实现、审查和 QA。

本目录为原 FearDesk 的独立本地开发项目。不要修改、发布或连接原 FearDesk 的生产数据库；原目录仅用于读取基线。hosting 中没有原 project_id。新云端目标需明确后配置，不得从旧文档复用原站点部署参数。

真实交易数据、账户身份映射、券商凭证及本地数据库不提交 Git；富途接口只读。本机先运行与验收，再推进独立云端同步。保留信号快照和交易证据，不用缺失数据的零值冒充真实盈亏。

## 项目命名和 Git 约定

- FearDesk 默认指信号模块；feardeskreview 指交割单复盘模块。
- 用户要求本地工作分支与对应远端分支同名，并设置 upstream。禁止默认用 Codex 前缀替代用户约定的分支名。
- 本功能分支为 feardeskreview，以远端 fear-desk-daily-pipeline 为基线，该起点对应 release/0.2.6。
- 默认 Python 账本源码已收纳于 review-ledger；运行资料仍在被忽略的独立私人目录。

## 信号更新合入复盘的共同约定

- 默认使用 gstack，实际检查范围应匹配当次任务。
- `fear-desk-daily-pipeline` 承载 FearDesk 信号功能；`feardeskreview` 承载交割单复盘及其新增功能。
- 本地工作分支必须与对应 GitHub 远端分支同名，并设置 upstream。
- 本仓库远端为 asfordream/fear-desk。信号分支提交更新并推送后，也需将该信号分支的新提交合并到 feardeskreview；保留复盘功能及其独立私人数据边界。
- 合并冲突按上述模块边界解决，执行必要验证后推送复盘分支。禁止用覆盖目录、重置或强推丢弃复盘改动。
- GitHub 源码推送与线上部署为不同动作；按当次授权及目标环境执行部署，不因合并而自动部署复盘功能到旧信号站点。
