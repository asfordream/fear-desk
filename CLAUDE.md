# Project workflow

用户已要求所有项目默认使用 gstack，沿用现有需求、设计与验证结果。按任务规模调用已注册技能，无需重复询问是否启用。

## Skill routing

- 产品需求：office-hours / spec
- 架构方案：plan-eng-review
- 设计：design-consultation / plan-design-review / design-review
- 调试：investigate
- 实现审查：review
- 验证：qa / qa-only
- 发布：ship / land-and-deploy / canary，需核对本次发布授权
- 保存和恢复工作：context-save / context-restore

机器人实际发送需明确接收群和发送授权；凭据使用服务端秘密变量。测试中不得发送到真实群。
