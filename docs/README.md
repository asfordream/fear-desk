# FearDesk 文档入口

## 当前状态

- 主要开发分支：`feardeskreview`。
- 当前功能版本：[v0.3.0](versions/v0.3.0/README.md)。
- 本机整合历史：[v0.2.20](versions/v0.2.20/README.md)。完成状态以对应验证记录为准。
- 交易规则与观察：[v0.3.0需求与方案](versions/v0.3.0/PRD.md)；[原始讨论草稿](features/trading-rules/draft/PRD.md)保留追溯。实际验收状态见该版本验证与发布记录。

[新版本资料模板](templates/version/README.md)

## 目录约定

| 目录 | 内容 |
|---|---|
| `versions/<version>/` | 每个已开发版本自己的需求、方案、验证、发布与迁移记录 |
| `features/<feature>/draft/` | 未定版本的需求与原型，评审通过后关联到目标版本 |
| `guides/` | 跨版本使用和运维指南 |
| `archive/legacy/` | 历史原始文档，保留原标题，不伪造所属发布版本 |

新增版本使用 `PRD.md`、`architecture.md`、`verification.md`、`release.md`；原型放 `prototypes/`。不是每个旧版本都能补出真实PRD，不根据当前功能倒填历史。

## 历史追溯

- [跨旧目录的历史资料总索引](archive/history-index.md)：原始PRD、旧信号/复盘文档，按内容去重并保留来源。
- [文件迁移映射](archive/document-moves.md)：项目内原路径与新路径。

## 日常入口

- [统一本机运行说明](guides/local-unified.md)
- [本地各目录角色](guides/directory-map.md)
- [复盘使用指南](guides/review-user-guide.md)
- [历史文件迁移映射](archive/document-moves.md)

原信号分支与旧运行目录保留可恢复副本，不删除私人资料或历史数据库。其 export、qa 等目录目前仅建立角色说明，不自动移动大型运行产物。
