# 飞书群自定义机器人接入

日报在 `/reports`。四个恐慌分区直接展示全部有效标的，不使用折叠面板。格式更新后重新生成卡片预览；旧快照和已发消息保持当时的格式。生成预览只读取 D1 中的收盘结果；网页内容预览与飞书客户端外观不同。可导出 JSON 2.0 卡片，在飞书卡片工具核对。公网历史链接需要 ChatGPT 登录。

## 服务器配置

在目标群创建自定义机器人，按需要启用签名校验、关键词或 IP 限制。Webhook 和签名密钥通过部署平台的服务端秘密配置写入，不提交 Git、不填进网页。

| 环境变量 | 内容 |
|---|---|
| FEISHU_WEBHOOK_URL | `https://open.feishu.cn/open-apis/bot/v2/hook/…` |
| FEISHU_SIGNING_SECRET | 可选，群机器人启用签名校验时填写 |
| SITE_BASE_URL | 真实公网 HTTPS 网站 origin，例如 `https://desk.example.com`，不能填 localhost |
| FEISHU_SEND_ENABLED | 默认缺省关闭；确认群目标和发送授权后设为 `true` |
| FINNHUB_API_KEY | 可选，财报日历接口令牌；不配置也使用免费公开来源 |

本地 Worker 开发可使用忽略的 `.dev.vars`，上线应使用平台 secret 设置。仓库已忽略 `.dev.vars*`。不要使用带凭据的 shell 命令参数或输出环境变量。

配置公网链接后重新生成预览，以保证保存的原始卡片含冻结日报链接。网页发送按钮只在已启用、链接有效、当日截面齐全时显示。按钮点击将发送到配置的群。

## 调度与状态

Worker 配置 `0,10,20 6 * * *`（UTC），首次触发对应北京时间14:00，失败在14:10、14:20重试。任务以北京时间前一自然日作为美股收盘日期，正常周二至周六发送；夏令时和冬令时发送时间均不变。SPY必须已有目标日期收盘日线，否则记为休市或延迟，不会用旧截面冒充。每日成功更新后复用冻结日报，发送中、成功或结果不确定时不重复发。

配置写入生成的 Worker 清单不等于云端调度已经启用。发布后需在部署平台核对 Cron、D1迁移、秘密变量与最近实际任务。Sites平台是否应用Cron需线上确认；首版尚未取得线上执行证据。

成功、发送中、结果不确定的快照不会重新提交。明确被飞书拒绝的请求可以重新发送原快照。超时或进程在发送后崩溃时，应先核对群消息，人工处理结果，不盲目重试。自定义机器人没有可调用的消息去重保证，因此不承诺远端“恰好一次”。

## 财报信息

默认自动获取，不需要API密钥。已登记的公司官方公告/RSS优先，Yahoo公开报价页补充；Finnhub作为可选备用。官方来源覆盖AAPL/MSFT/NVDA/TSLA/NFLX/CRDO，其他普通股使用Yahoo。官网动态页面、403或未发布下一期公告时可能只能取得预计日期。

日历保存确认/预计/未知、日期区间、盘前盘后、来源URL及检查时间。成功缓存24小时，尚未公布6小时，失败15分钟；失败保留已知未来日期并提示，过去日期不当作下一期财报。新增标的、增量行情更新、每日任务、打开观察池都会检查缓存；详情页可手动刷新。

人工纠错优先，清空仍保持人工模式，可点击“恢复自动获取”。精确预计日期参与原有修正且带预计提示；预计区间不任意取第一天修正。新信息统一从纽约下一自然日起对计算可见，避免把事后发现的日期回填到过去。财报窗口暂按3自然日，PCR规则仍待完善。

冻结日报和卡片保存当时的日期/状态/来源/获取时间，不改写旧快照。获取失败不等于没有财报。财报正文和财务指标尚未接入。

## 参考

- [飞书自定义机器人说明](https://open.feishu.cn/document/client-docs/bot-v3/add-custom-bot)
- [卡片 JSON 2.0](https://open.feishu.cn/document/feishu-cards/card-json-v2-structure)
- [折叠面板](https://open.feishu.cn/document/feishu-cards/card-json-v2-components/containers/collapsible-panel)
- [Cloudflare Cron](https://developers.cloudflare.com/workers/configuration/cron-triggers/)
- [Finnhub财报日历](https://finnhub.io/docs/api/earnings-calendar)

本机 Wrangler 4.92 的静态资产路由会拦截 scheduled 测试入口并返回exception。验证使用生成清单的本地副本，仅去除assets（API/定时处理器和D1不变）后在隔离库运行；不将该副本发布。Vite旧版本不支持新版 `/cdn-cgi/local/scheduled`，应使用 Wrangler `/cdn-cgi/handler/scheduled`。
