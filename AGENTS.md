# FearDesk 分支开发约定

- 默认使用 gstack，实际检查范围应匹配当次任务。
- `fear-desk-daily-pipeline` 承载 FearDesk 信号功能；`feardeskreview` 承载交割单复盘及其新增功能。
- 本地工作分支必须与对应 GitHub 远端分支同名，并设置 upstream。
- 本仓库远端为 asfordream/fear-desk。信号分支提交更新并推送后，也需将该信号分支的新提交合并到 feardeskreview；保留复盘功能及其独立私人数据边界。
- 合并冲突按上述模块边界解决，执行必要验证后推送复盘分支。禁止用覆盖目录、重置或强推丢弃复盘改动。
- GitHub 源码推送与线上部署为不同动作；按当次授权及目标环境执行部署，不因合并而自动部署复盘功能到旧信号站点。
