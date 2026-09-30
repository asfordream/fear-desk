export const APP_VERSION='0.2.4';
export const RELEASES=[
 {version:'0.2.4',date:'2026-09-30',title:'紧凑恐慌日报样式',changes:['按参考截图改为每只标的一行：名称、收盘价、恐慌值、彩色变化箭头和独立形态。','增加底部区摘要、跨分区提示和距击球10分内的候选；所有分区直接展示。','网页预览同步紧凑样式；卡片格式独立版本保留历史快照。'],limits:['IV与连续天数等未接入标签不显示；PCR待完善。','云端定时触发仍待验证。']},
 {version:'0.2.3',date:'2026-09-30',title:'日报分区全部直接展示',changes:['飞书卡片的击球区、底部区、恐慌区和贪婪区取消折叠，直接展示全部有效标的。','网页日报预览同步改为完整展示；新生成卡片采用独立格式版本，保留历史快照。'],limits:['手动飞书发送已由用户确认成功；云端定时触发仍待验证。','PCR规则待完善。']},
 {version:'0.2.2',date:'2026-09-30',title:'飞书日报发送与下午两点调度',changes:['修复云端发送的重定向兼容问题；拒绝转发到其他地址。','日报发送时间改为北京时间14:00；休市通过目标日期SPY日线核对。','飞书分区展开显示全部有效标的；保留财报和数据质量说明。'],limits:['定时配置已写入发布清单，平台是否启用及真实推送仍需线上验证。','PCR规则待完善。']},
 {version:'0.2.1',date:'2026-09-30',title:'修复市场总览加载卡住',changes:['移除行情初始化跨请求共享的等待，避免一个请求阻塞后续请求。','行情读取增加超时提示和重试入口；财报检查单独显示更新状态。'],limits:['免费来源可能限制访问；PCR规则和真实飞书发送仍待完善或验收。']},
 {version:'0.2.0',date:'2026-09-30',title:'自动财报日历与版本记录',changes:['财报日期自动获取、缓存和入库，无密钥可使用免费公开来源。','区分官方确认、第三方预计和日期未知；保存来源链接、检查时间与日期区间。','新增标的、行情更新与每日任务接入财报日历；支持人工纠错及恢复自动。','详情页、冻结日报和飞书卡片显示财报来源及预计状态。','新增版本更新页和持久化需求记录，可跟踪需求处理状态。'],limits:['官网可能限制访问；无法获取的日期会明确显示，不保证所有标的已公告。','预计日期修正会带预计标签；日期区间不选择某一天执行修正。','PCR规则、线上定时触发和真实飞书发送仍需完善或验收。']},
 {version:'0.1.0',date:'2026-09-30',title:'恐慌观察与收盘日报首版',changes:['真实日线按课堂V7逐日计算恐慌值，SPY作为统一基准。','行情增量更新；历史修订触发回填；形态、恐慌分区与筛选状态分开显示。','观察池支持新增、移除和历史导出。','保存不可变日报快照，提供飞书群自定义机器人卡片预览。'],limits:['PCR待完善；首版财报日期采用人工登记或可选Finnhub。','网站访问需要ChatGPT登录。']},
] as const;
export const REQUEST_STATUSES={open:'待评审',planned:'计划中',done:'已完成'} as const;
export function requestInput(input:unknown){if(!input||typeof input!=='object')throw new Error('需求格式无效');const x=input as Record<string,unknown>;if(typeof x.title!=='string'||typeof x.description!=='string')throw new Error('请填写需求标题和说明');const title=x.title.trim(),description=x.description.trim();if(title.length<2||title.length>80)throw new Error('标题需为2–80个字符');if(description.length<5||description.length>3000)throw new Error('说明需为5–3000个字符');return {title,description};}
export function requestStatus(input:unknown){if(typeof input!=='string'||!Object.hasOwn(REQUEST_STATUSES,input))throw new Error('需求状态无效');return input as keyof typeof REQUEST_STATUSES;}
