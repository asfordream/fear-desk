import {getRawDb} from '@/db';
import {readReport} from './daily';
import {postCard,validateWebhook,type BotConfig} from './feishu';
import {publicBase} from './report';
import {scheduledReportWindow} from './trading-calendar';

// One delivery identity per Beijing occurrence and existing bot target. The
// immutable market report can be reused across occurrences without resending
// within one occurrence. No lease recovery for uncertain network outcomes.
export async function sendScheduledReport(reportId:string,occurrenceDate:string,config:BotConfig,now=new Date()) {
 const window=scheduledReportWindow(now);
 if(!window.ready||window.date!==occurrenceDate)return {status:'not_requested',message:'非本日原定时发送意图；未发送或补发历史'};
 if(config.FEISHU_SEND_ENABLED!=='true'||!config.FEISHU_WEBHOOK_URL)throw new Error('机器人尚未启用');
 const target=validateWebhook(config.FEISHU_WEBHOOK_URL),base=publicBase(config.SITE_BASE_URL),saved=await readReport(reportId);
 if(!saved.snapshot.summary.complete||!base||!JSON.stringify(saved.card).includes(`${base}/reports/${saved.snapshot.id}`))throw new Error('完整日报和公网链接尚未就绪，未发送');
 const targetKey=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(target)))).map(x=>x.toString(16).padStart(2,'0')).join('');
 const database=getRawDb(),stamp=new Date().toISOString();
 await database.prepare("INSERT INTO scheduled_deliveries(occurrence_date,target_key,report_id,status,updated_at) VALUES (?,?,?,'failed',?) ON CONFLICT(occurrence_date,target_key) DO NOTHING").bind(occurrenceDate,targetKey,reportId,stamp).run();
 const claim=await database.prepare("UPDATE scheduled_deliveries SET status='sending',report_id=?,attempts=attempts+1,updated_at=?,message='本排程日发送处理中，重复提交已阻断' WHERE occurrence_date=? AND target_key=? AND status='failed'").bind(reportId,stamp,occurrenceDate,targetKey).run();
 if(!claim.meta.changes){const prior=await database.prepare('SELECT status FROM scheduled_deliveries WHERE occurrence_date=? AND target_key=?').bind(occurrenceDate,targetKey).first<{status:string}>();return {status:prior?.status??'sending',message:'本排程日已发送、发送中或结果不确定；未重复提交'};}
 let result;try{result=await postCard(saved.card,config);}catch(error){result={status:'failed' as const,message:error instanceof Error?error.message:'发送配置无效'};}
 await database.prepare('UPDATE scheduled_deliveries SET status=?,updated_at=?,message=? WHERE occurrence_date=? AND target_key=? AND report_id=? AND status=\'sending\'').bind(result.status,new Date().toISOString(),result.message,occurrenceDate,targetKey,reportId).run();
 return result;
}
