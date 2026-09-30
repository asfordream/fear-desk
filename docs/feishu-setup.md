# 飞书群自定义机器人接入

日报在 `/reports`。生成预览只读取 D1 中的收盘结果；网页内容预览与飞书客户端外观不同。可导出 JSON 2.0 卡片，在飞书卡片工具核对。公网历史链接需要 ChatGPT 登录。

## 服务器配置

在目标群创建自定义机器人，按需要启用签名校验、关键词或 IP 限制。Webhook 和签名密钥通过部署平台的服务端秘密配置写入，不提交 Git、不填进网页。

| 环境变量 | 内容 |
|---|---|
| FEISHU_WEBHOOK_URL | `https://open.feishu.cn/open-apis/bot/v2/hook/…` |
| FEISHU_SIGNING_SECRET | 可选，群机器人启用签名校验时填写 |
| SITE_BASE_URL | 真实公网 HTTPS 网站 origin，例如 `https://desk.example.com`，不能填 localhost |
| FEISHU_SEND_ENABLED | 默认缺省关闭；确认群目标和发送授权后设为 `true` |
| FINNHUB_API_KEY | 可选，财报日历接口令牌；不配置则沿用人工登记 |

本地 Worker 开发可使用忽略的 `.dev.vars`，上线应使用平台 secret 设置。仓库已忽略 `.dev.vars*`。不要使用带凭据的 shell 命令参数或输出环境变量。

配置公网链接后重新生成预览，以保证保存的原始卡片含冻结日报链接。网页发送按钮只在已启用、链接有效、当日截面齐全时显示。按钮点击将发送到配置的群。

## 调度与状态

Worker 配置 `30 20,21,22 * * MON-FRI`（UTC）。任务再检查纽约工作日16:30；夏令时20:30UTC开始，冬令时21:30UTC开始。早收市日也等到16:30。SPY 必须已有当天收盘日线，否则记为休市或延迟，不生成当天报告。部分失败后后续触发重试；每日更新成功后的日报存在时复用，手动预览不会跳过正式更新。

配置写入生成的 Worker 清单不等于云端调度已经启用。发布后需在部署平台核对 Cron、D1迁移、秘密变量与最近实际任务。Sites平台是否应用Cron需线上确认；首版尚未取得线上执行证据。

成功、发送中、结果不确定的快照不会重新提交。明确被飞书拒绝的请求可以重新发送原快照。超时或进程在发送后崩溃时，应先核对群消息，人工处理结果，不盲目重试。自定义机器人没有可调用的消息去重保证，因此不承诺远端“恰好一次”。

## 财报信息

有 Finnhub 密钥时按标的读取未来90自然日事件，保持获取日及记录时间。人工登记优先，清除也保留人工决定；后续仍由用户登记。来源失败保留以前数据。日期缺失不等于窗口外，过期日期亦不能代表下一期事件。

## 参考

- [飞书自定义机器人说明](https://open.feishu.cn/document/client-docs/bot-v3/add-custom-bot)
- [卡片 JSON 2.0](https://open.feishu.cn/document/feishu-cards/card-json-v2-structure)
- [折叠面板](https://open.feishu.cn/document/feishu-cards/card-json-v2-components/containers/collapsible-panel)
- [Cloudflare Cron](https://developers.cloudflare.com/workers/configuration/cron-triggers/)
- [Finnhub财报日历](https://finnhub.io/docs/api/earnings-calendar)

本机 Wrangler 4.92 的静态资产路由会拦截 scheduled 测试入口并返回exception。验证使用生成清单的本地副本，仅去除assets（API/定时处理器和D1不变）后在隔离库运行；不将该副本发布。Vite旧版本不支持新版 `/cdn-cgi/local/scheduled`，应使用 Wrangler `/cdn-cgi/handler/scheduled`。
