# FearDesk 日报更新模块架构 v1.0

日期：2026-10-03。输入：PRD v1.1、技术方案 v1.1、隔离验证 v2及用户已接受的每小时恢复取舍。目标工程：/Users/zhoujiqing/Documents/ChatGPT/期权工具/fear-desk；基线392649ef971dc840245b04eeead6ff74a16cb7ba，产品0.2.5。本轮实施目标0.2.6，尚未编码或发布。

本阶段完成领域、持久化、执行器、接口、UI、迁移与测试的结构设计；不部署生产、不改变每日生成频率、不实际发送飞书。临时每小时恢复扫描是独立的“只续已有任务”能力，具体生产配置待发布阶段落实，不在本阶段创建。

## 1. 决策和边界

已确认两按钮、手动任意时段、手动不发送、历史冻结、完整性校验、原子发布、单调latest、全写fencing、来源发送意图以及版本与需求记录。已确认每小时检查并续跑已有任务，接受触发和恢复可能延迟，不承诺一分钟或一小时内完成。正常长任务也可能在初始分片后等待下一次后台检查，UI必须明示。

维持集中任务模块、纯函数与现有D1，不另建微服务或安装运行时。所有实现选择为上述合同的必要细化，沿用上一轮R1集中复用结构；不新增可独立部署服务。预计涉及约16个产品/迁移/测试文件，新增4个纯函数模块，无新外部基础设施。数据库一致性、领域模块和API有共同合同，按顺序实施；不主动派实现代理。

不做PCR、IV Rank、新行情供应商、历史自动补发、权限变化、每日时段改动、原生分钟Cron配置或新付费执行器。周一至周六14点候选暂不实施；原周二至周六14/15/16行为保持，15/16的现有只读查询不变成写入。

## 2. 实际证据与可复用组件

- lib/daily.ts：报告hash、冻结卡片和投递状态保护可复用；同步runDaily、created_at最新查询和recoverLastIncomplete直接发送必须退出新手动/恢复链。
- lib/store.ts：Yahoo解析、SPY先行、4并发及修订重算复用；putBars/recompute现有写入仅预查锁，须接入逐写fencing。
- lib/earnings.ts：缓存、人工优先与修订机制复用；候选缓存写入亦受统一写保护。
- lib/engine.ts、lib/report.ts：不改评分公式、形态和卡片业务规则；新增编排围绕它们冻结一致输入。
- app/api/reports、jobs/daily与lib/http.ts：访问边界复用；读API不调用ensureInitial、行情更新、任务接管或发送。
- components/reports.tsx目前load选reports[0]且无轮询；两个新按钮使用独立busy，latest取显式指针。
- 隔离Sites：240秒假工作量被11轮云任务续跑完成；旧token拒写和并发去重；真实D1第三SQL失败回滚。连续waitUntil在30051ms后取消；真实云实例重启未测。
- 隔离触发10:17、首wake10:22:44，观测延迟344秒，无延迟上限证据。当前接口无分钟Cron/Queue/Workflow配置入口。

交易日历采用代码内可审计的NYSE 2026–2028日历与提前收盘表，America/New_York时区转换处理夏令时；官方表只作日历事实来源，不加入新行情服务：[NYSE官方日历](https://www.nyse.com/trade/hours-calendars)。范围外年份或临时休市异常明确calendar_unavailable，不用工作日近似冒充准确交易日。

## 3. 模块职责与依赖

| 模块 | 路径与状态 | 责任 / 禁止职责 |
|---|---|---|
| 合同与状态 | 新lib/daily-contract.ts | DTO、纯状态转换、指纹及预算类型；无fetch或数据库写 |
| 任务编排与执行器端口 | 新lib/daily-pipeline.ts | admit、runSlice、resumeExisting、scanExisting、分步错误处理；不直接发送飞书 |
| 持久化与写保护 | 新lib/daily-repository.ts | D1条件SQL、请求映射、lease epoch、输入chunk、原子发布、精简读模型；不用Promise.all冒充事务 |
| 收盘日期 | 新lib/trading-calendar.ts | 请求时最新应收盘日与日历版本；无远程行情抓取 |
| 行情/财报/计算 | 现lib/store/provider/earnings/engine | 接受deadline和WriteFence，返回候选；调用方显式提交；不隐式切换发送意图 |
| 既有投递 | 现lib/daily/feishu | 只消费授权的已保存完整report；manual/recovery没有投递入口能力 |
| 路由适配 | 现app/api/reports、jobs/daily | 严格action白名单、身份/同源保护、快速持久受理与单片执行 |
| 展示与发布记录 | 现components/reports、updates；lib/releases | 只读轮询、独立状态、计划/开发/待发布/已发布；无后台推进循环 |

依赖方向：路由 -> pipeline -> repository / calendar / existing providers；UI -> read DTO；delivery -> immutable report +独立request intent。repository不依赖UI或飞书，providers不依赖请求来源。临时执行器通过HTTP调用runSlice，后续Queue/Workflow可调用同一端口，不重写领域规则。

## 4. 持久状态模型

沿用reports、deliveries、job_runs、workflow_locks，不覆盖原历史内容。job_runs新增pipeline_version、active_key、requested_closed_day、pool_version、algorithm/card版本、input_revision、stage、checkpoint、active_token、lease_epoch、lease_until、attempt_id、failed_attempts、active_budget_ms、reserved_ms、next_eligible_at、last_progress_at、validation_hash、report_id与completed_epoch。旧行标legacy，不让新小时扫描自动接管旧历史并补发。

新增daily_requests：request_id唯一、source(manual/schedule)、requested_at、job_id、send_intent(none/原定时策略)、schedule_occurrence、scope_hash。唯一请求身份的重试，包括终态后，返回原映射。request_id由客户端/调度运行身份生成，服务端验证长度/格式；客户端不能选择日期、池、算法、机器人或source=schedule。

新增daily_attempts：逻辑失败周期与原因、开始/结束、上个检查点；正常分片交接沿用同一attempt，新的lease epoch独立增加。新增daily_inputs：按job/inputGeneration/symbol/kind/chunkNo分块保存候选与清单hash，单块上限128KiB并检查总大小。无敏感配置，无无边界单行全历史JSON。

新增report_current：单例desk的report_id、trade_date、accepted_revision、version、legacy标志。新增daily_commits：原子提交审计与assertion_ok CHECK(assertion_ok=1)，最后一条断言失败使batch全部回滚。新增daily_events或等价审计行：受理/合并/领取/交接/中断/失败/发布/小时扫描；不输出能力token。

关键索引：daily_requests(request_id)唯一；job_runs(active_key)非空唯一；job_runs(pipeline_version,status,next_eligible_at,lease_until)；daily_inputs(job_id,inputGeneration,symbol,kind,chunkNo)唯一；reports(content_hash)非空唯一；reports(trade_date,input_revision)；daily_attempts(job_id,attempt_no)；daily_events(job_id,id)。

受理事务同时创建/合并任务和写request映射，形成可扫描持久事实，无“受理成功但未派发就永久丢失”窗口。active_key描述请求时闭市日/冻结池/算法/卡片及兼容输入基线；尚未确定SPY可用日时是暂态任务。定日和冻结输入后才归并最终logicalKey；已冻结但不兼容的新请求不强行并入。事务竞争失败重读胜者后返回同一映射，不能承认一个不存在的taskId。

## 5. 日期、快照与版本顺序

请求记录最新应收盘日D与日历版本。runSlice读取SPY已收盘有效日d且d<=D；d<D合法但显式行情延迟。SPY已有D而个股缺D时禁止退回旧共同日期。长等待不擅自把旧请求改成下一交易日；要请求更新的目标日需新的手动/原定时请求。

冻结观察池/算法/卡片/财报语义与SPY历史；分块保存输入清单。评分用冻结的SPY，不从可变化的全局scores拼装正式报告。财报必要重算先完成，未知和null保留。目标行合法、完整观察池和重算清单齐全才记录validation_hash。

可比较input_revision来自服务器CAS接受的因果版本，不来自完成时间、随机UUID或第三方抓取时间。全局行情/财报写入带baseRevision+resourceEpoch，新基线提交递增acceptedRevision。对旧基线提交拒写并重读；同日无法证明因果关系的输入分叉标reconcile_required并重新读取核对，禁止随便给最大序号当胜者。候选生成后以一个冻结manifest固定版本；别的市场写入口更新不能改变该manifest。

业务contentHash只含交易日、有效行情/评分、实际参与财报事实、池、算法与卡片版本。不含心跳、查询时间、重试次数、fetchedAt等波动字段。相同hash复用原report_id和首次generatedAt，历史正文永不覆盖。

## 6. 有边界执行与恢复

admit后可通过正确Worker ctx.waitUntil推进一片，目标20秒、硬预算25秒；若框架不能可靠取得ctx，则只持久受理，等待后台扫描，不用裸Promise。初始推进是加速，不是可靠性基础。ctx传递方式在首个实现门槛用框架现有接口证明后接入。

每片依次进行：claim/CAS -> 预留最多25秒预算 -> 执行一个/少量可检查点步骤 -> 条件提交 -> yield到queued或进入终态。提前留出数据库提交余量，外部fetch接收deadline/AbortSignal；Yahoo query1/2回退不得把两个12秒请求加计算写入塞进无预算片。第二来源可成为下一片待办。历史修订重算按标的分片；长计算必须可切分或经测量在片预算内，不依赖阻塞时setInterval心跳。

阶段：resolveSPY -> freezePool -> fetchMarket(chunk) -> earnings(chunk) -> calculate(symbol) -> validate -> publish。外部fetch在事务外；候选写入与checkpoint推进有相同token/epoch/lease/expectedCursor守卫。一片超时没有提交的计算丢弃，已提交检查点继续使用。

正常yield：旧token失效，保存checkpoint，queued/waiting_background；不增加失败attempt。不伪装仍在运行。真实失败或失去执行者：下一检查结束旧attempt，failed_attempts增加，预算内重试；最多3个失败执行周期含初次。退避30/120秒为not-before，实际可以等待下次小时检查。

执行预算为累计工作30分钟，不含等待。领取时先预留25秒，成功后按实际运行耗时释放剩余；进程崩溃按预留量记账，不能靠反复中断无限工作。预算不足、失败次数耗尽或永久错误落failed/partial，不再允许迟到发布。墙钟等待可延长，UI显示实际等待时长。

小时扫描只能选择已经存在的pipeline_version=2且非终态任务，禁止调用admit、runDaily或recoverLastIncomplete，禁止新建交易日任务或发送。空扫描只有运行审计，无report/job/request/delivery变化。

云任务控制器每次最多8分钟drain；每轮POST resumeExisting返回已推进数量/待办/最早not-before及read状态，优先公平轮转待办，当前云任务预算到期停止，剩余记录等待下次小时检查。不无限sleep、递归自调用或创建更高频调度来伪装分钟Cron。后续替换执行器只改变唤醒/控制器，保留数据库状态和token协议。

## 7. 全写fencing和原子发布

所有bars/scores/earnings/候选/checkpoint/job/report/pointer写入必须使用统一WriteFence。guard为activeJob/attempt、token、leaseEpoch、租约未失效、expectedInputRevision/expectedCursor。不能先SELECT锁再无条件写；每条修改SQL带条件，批量多波次也各自条件化。单标的同步、观察池写入、初始化和财报人工修订共享资源CAS协议；旧路径不得绕过写保护。读API从这些写路径拆开。

正式发布仅一次D1 batch，所有语句条件化：
1. 从拥有有效租约且validation_hash匹配冻结manifest的任务INSERT完整immutable report；contentHash已存在则复用，校验正文指纹。
2. 更新currentPointer，仅交易日更大，或同日且因果可比较acceptedRevision更大才替换；旧输入只存历史，不按createdAt比较。
3. 关联job.report_id并ready/reused，记录completed_epoch，完成对应attempt。
4. 最后写daily_commits，CHECK断言job/attempt/report关联一致、报告完整、完成epoch等于本次epoch、租约在数据库当前时刻仍有效，以及current没有倒退。旧历史任务不要求成为current。
5. 断言失败使整批回滚；返回明确lease/input/publication冲突，重读现态。pointer条件更新零行在“当前已有更新版本”时合法，不可当事务失败；关联更新零行或不完整却ready必须断言失败。

不会因为每条SQL的WHERE无命中就假定整批原子正确。末尾CHECK保护“部分语句成功但job未关联”的逻辑失败。SQL时间用D1支持的数据库时钟表达式，防止应用提前取now后跨过租约边界仍发布。完成后终态写入口拒绝旧token；清理token只有带completed_epoch的CAS，不影响发布事实。

原子性原语已在真实隔离D1受控冲突验证；此具体业务batch、last-check断言、指针乱序竞争和全部writer fencing还需实现后测试，不能把原语成功冒充产品实现成功。

## 8. 发送意图与既有调度

request意图和job生成生命周期独立。manual固定none；同一job合并的schedule请求保留原独立策略，不能被manual覆盖或让manual继承。纯手动job没有投递能力。

既有每日生成控制器在原时段受理自己的请求并drain；只有它能在原授权策略下调用独立deliverAuthorized(reportId,scheduleIntent)。生成完成不自动发送。小时恢复控制器没有此能力，即使续跑的是schedule来源也不会发送；错过原定时投递路径时显示“报告已保存，原定时投递未完成”，不追加历史补发。

deliveries继续保护sent/sending/unknown不重发；发送未知结果不改为可自动重试。飞书失败不把report/job从ready降级。保留既有人工发送入口的权限，任何真实发送另需实际接收群授权；本轮测试全部mock或假接收端。

## 9. 接口冻结与UI行为

浏览器GET /api/reports只读返回currentPointer、简短任务状态及独立delivery；按id GET冻结正文；支持requestId只读查询已受理映射。未有记录是明确空态，数据库失败不是空态。no-store，不暴露服务令牌、内部写token或配置值。

浏览器POST /api/reports action=generate（旧preview/run返回明确过渡错误，不能悄悄映射为发送路径）：身份+同源校验 -> requestId白名单 -> manual持久受理 ->202 {requestId,jobId,state,reportId?}。未知action400，拒绝任意source/date/symbols/bot。访问保护沿用lib/http；失败前后保留requestId，超时显示“受理状态待核对”。

服务POST /api/jobs/daily严格action=daily|resume_existing；daily仅原每日控制器受理，resume_existing仅续已有记录。两个不同受限适配函数，不把动作拼错/空JSON落入runDaily。保留现有服务启用与私有站点调度保护，站点权限变化时停止该服务入口，不新增持久自调用凭据。生产自动任务的提示指令更新仅在发布阶段按原时段核对；15/16只读不会擅改。

UI：“刷新日报”只触发GET，自身busy；“立即生成最新日报”只持久受理manual请求，有独立busy。生成中仍能读旧日报；旧report不会被空响应清除。列表轮询正常30秒、活动任务5秒；隐藏暂停，可见/网络恢复立即GET；AbortController+请求序号拒绝旧响应，获取完整新report后整体替换。历史id页固定正文。

等待状态文案：“任务已受理，等待后台续跑；系统每小时检查已有任务，实际恢复可能延迟。”展示最近进度、等待时长、最近后台检查；下次计划检查标“计划时间，可能延迟”，不得倒计时承诺最多一小时。租约过期可由GET派生“执行已中断，等待后台检查”，但GET不能写interrupted。生成、完整性、交易日、生成时间、日期新鲜度、请求发送意图、报告投递分别展示。

## 10. 版本、迁移与本地一致性

冻结本轮开发目标0.2.6；APP_VERSION保持最后已发布0.2.5直到生产发布验收完成。RELEASES增加status/sourceCommit/requirements/evidence，显示开发中与当前已发布分开；需求状态新增developing/ready_to_release/released，保留旧open/planned/done兼容映射，不把历史done自动改成新发布。

迁移新增字段/表/索引，保留reports payload/card及旧链接。旧job标legacy，小时扫描不自动恢复它们；旧sending/unknown不重发。当前指针初始种子保留既有当前展示ID并标legacy不可比较；首次完整新pipeline核对后再按因果规则更新，旧同日多版本不按创建时间伪造新input_revision。迁移必须有代表性旧库样本测试，不直接对生产注入。

回退时先停新写入口/恢复控制器，再回退兼容代码；不DROP新增表或删除历史。版本记录只在正确源提交发布成功、关键验收完成后标已发布，失败仍待发布，回退保留历史记录。

编码前再次核对HEAD和原未提交列表。新代码、配置说明、迁移、测试和版本草稿写准确本地repo；不reset、不覆盖他人修改、不迁移另一个fear-lab。发布阶段才核对Sites源提交/部署回执，不能把本地实现称线上完成。

## 11. 数据流与失败分支

读取：
GET -> auth失败401 / DB失败503且保留旧UI / current不存在空态 / current存在读取完整快照 ->序号校验 ->整体替换
历史GET -> auth -> ID不存在404 / 存在冻结正文；从不随current更新。

生成：
POST -> auth/origin/action错误拒绝
     -> requestId已存在: 原映射（含终态）
     -> 新请求: 持久事务 -> 兼容活动job合并 / 新queued
     -> 可选单片启动（失败也不丢持久任务） ->202 -> 网页可关闭

分片：
runSlice -> 终态/非到期返回只读结果
         -> claim失败busy/旧owner -> 无业务写
         -> claim成功+预算预留 -> 执行当前stage
         -> 可检查点成功: 有条件写 -> 最终validate? 否: yield queued
         -> 完整validate: publication batch -> ready/reused
         -> 预算/永久错误: failed/partial
         -> 可重试错误: retry_wait
         -> process消失: 租约失效 -> 小时scan结束旧attempt -> 新token续已有checkpoint

小时：
tick -> 空: 审计后结束
     -> 有已有任务: 限额公平扫描 -> resumeExisting若干片 -> 完成/预算耗尽等待下次
     -> 禁止admit与delivery，所有异常保存安全诊断。

## 12. QA验收矩阵与实现门槛

保留PRD AC01–AC30；AC08按v1.1新参数。已有node:test+SQLite和mock网络为本机框架，不新增安装。当前daily.test.mjs的batch=Promise.all不是事务证明；隔离D1补充的是原语证据。

| 门槛 | 必要断言与证据 |
|---|---|
| G0 实现前结构准备 | 库迁移样本、request/schema/DTO合同、现有Node运行命令和原修改保护清单 |
| G1 持久受理与读隔离 | 同requestId终态重试原结果；并发来源映射完整；受理后立即退出仍被扫描；所有GET业务零写；未知action/跨站/匿名拒绝 |
| G2 分片预算和fencing | 正常48片不耗3次失败预算；失败/租约失效耗次数；预算预留崩溃计费；网络deadline、部分checkpoint、每个store/earnings写入口旧token零写 |
| G3 完整性与原子发布 | SPY D而股票缺D禁止退旧；null预热与未知财报；混合revision拒绝；batch中途SQL失败、末CHECK失败均零部分发布；发布后断连复用同结果 |
| G4 latest顺序 | 旧交易日晚完成、同日旧因果版晚完成不倒退；同日不可比较冲突显式核对；contentHash复用原生成时间 |
| G5 意图与小时恢复 | manual/schedule两种到达顺序；manual永不发；hourly空/queued/interrupted均不admit不send；恢复ready与原定时未投递单独显示；sending/unknown不重发 |
| G6 UI与版本 | 两按钮busy独立；等待时间不承诺SLA；刷新/轮询零副作用；响应乱序、隐藏/离线、401、DB失败保留旧内容、历史固定；版本开发/待发布/已发布和本地源提交一致 |
| G7 完整负载 | 46标的、SPY修订、财报必要重算，受理/精简读P95<=2秒；每片实际预算、CPU/内存、总执行计费；小时控制器预算内停止；不要用假步骤耗时替代真实负载测量 |

每个失败路径都有错误/等待/终态和对应验收，不静默失败；critical gaps=0。真实云实例重启仍未测，不能冒充通过；分片持久原语证明与产品后续实现测试分别记录。无需新的用户决定即可编写必要测试与改动，但迁移或生产调度实施/发布不在本阶段执行。

## 13. 顺序实施任务

Sequential implementation, no parallelization opportunity.

A1（源F1/F5；人工1–2d / CC约2–4h）：schema/migration、repository、合同与首片执行器接口；先证明读零写/持久受理/框架ctx生命周期。
A2（源F2/F3；人工2–3d / CC约3–6h）：分片/预算/lease epoch、全部写入口fencing、冻结manifest、原子提交断言和单调pointer；对应G2–G4。
A3（源F4；人工0.5–1d / CC约1–2h）：source intent、daily与resumeExisting能力隔离、原投递保护和mock测试；G5。
A4（源F6/F7；人工1d / CC约1–3h）：精简读/索引、两个按钮/轮询/等待提示、版本需求记录；G6。
A5（源F5/F6；人工1–2d / CC约2–4h）：46标的真实形状假来源负载、孤立D1竞争故障、迁移与回退；G7。无需发真实飞书。

依赖A1 -> A2 -> A3 -> A4 -> A5；各门槛失败先修对应路径，不宣称所有代码都完成才可开始相关测试。代码完成再做实现review/QA，生产部署仍需相应授权。本阶段没有产品代码完成项。

## 14. 工程评审

范围挑战：保留完整已批准功能，沿用R1集中复用而非增加微服务。小时延迟R3已由用户明确接受；不引入新的功能裁剪。数据库表/条件SQL是承接原子性与防重复的必要实现，不把读路径修复、发送政策或新数据供应商混入范围。

架构：明确领域/持久化/执行器/投递边界，持久受理无丢失窗口，分片和失败attempt区分；小时控制器不能创建/投递。发布末CHECK处理零行逻辑失败，因果revision避免按时间排序。未发现当前架构稿中未处理的P1问题。

代码质量：复用provider/engine/report，只有4个纯函数模块，不抽通用workflow框架；统一WriteFence服务所有实际写入口，读模型不调用初始化。所有现有路径的迁移职责已逐项列明，不以搬代码行数证明收益；预计净增约900–1600行实现及约700–1200行测试/迁移，删旧同步串联约120–220行，总量增加是为持久与失败合同，未经编码的估算不是承诺。

测试：以上G0–G7覆盖分支与用户流程，实际隔离原语和未实现路径区分；不以16条旧用例或探针模拟代表新架构通过。性能：4并发为上限，按片预算限制实际批量；128KiB chunk、精简读索引及任务公平轮转限制内存/读开销；46标的实测仍为实施门槛。

Suppressed findings：不把“外部行情可能限流”升级成新供应商接入；不把原48.482秒断连推成固定超时；不把CLI不可用推成技术架构失败。无新增TODO范围；未来执行器替换已有端口及触发条件（平台开放分钟/持久能力或用户另获授权），不创建待办来掩盖临时限制。

## 15. Decision ledger

R1：集中任务服务并复用现有模块；沿用技术方案已记录的结构，无新部署服务。
R2：两按钮、只读刷新、完整性、原子发布、latest/fencing、来源意图与版本更新，来自已批准设计/PRD及继续开发授权。
R3：用户明确接受每小时检查续跑与恢复可能延迟；取消60秒恢复、墙钟30分钟完成承诺，其必要预算口径和UI限制见PRD1.1，不新增生成/发送权限。
R4：0.2.6未被当前实现占用，冻结为实施目标；当前已发布仍0.2.5，不需用户另选文档编号。
Approval readiness: PASS（R1–R4及无生产部署/频率变化/飞书补发边界已核对）。

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|---|---|---|---|---|---|
| CEO Review | 沿用已批准设计/PRD | 已确认产品范围 | 0 | 未新运行 | 无新业务政策 |
| Outside Review | 默认外部审阅 | 独立第二意见 | 1次尝试 | unavailable | Claude Code API ENOTFOUND；没有完成结果 |
| Eng Review | /plan-eng-review | 模块架构/测试/性能 | 1 | CLEAN | issues_found=0 / unresolved=0 / critical_gaps=0；实现任务尚未完成 |
| Design Review | 已批准设计基础+本轮状态核对 | 两按钮与延迟提示 | 0 | 未新运行独立设计审阅 | 不能冒称外部覆盖 |
| DX Review | 不适用 | 非工具产品 | 0 | 未运行 | 无本轮结果 |

OUTSIDE COVERAGE: 已实际以前台只读模式尝试 Claude Code CLI，退出1，API Error: Unable to connect to API (ENOTFOUND)，usage=0。此环境没有技能指定的 Plan/TaskOutput/TaskStop 后备工具，按 unavailable 分支记录；不替换为其他代理，不计入独立评审覆盖。主工程评审四部分已完成。

VERDICT: ENG 架构评审 CLEARED，READY TO IMPLEMENT。此结论只覆盖当前架构与验收基线，不表示产品实现、QA或发布完成。

NO UNRESOLVED DECISIONS

