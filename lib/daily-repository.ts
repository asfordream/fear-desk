import {getRawDb} from '@/db';
import {jobDto, LEASE_MS, PIPELINE_VERSION, SLICE_BUDGET_MS, WORK_BUDGET_MS, type DailyJobRow, type DailyRequest, type DailyStage, type WriteFence, hashFacts} from './daily-contract';

const DB_NOW = "CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)";
// Every worker mutation checks ownership at database execution time.
const OWNED = `id=? AND pipeline_version=2 AND status='running' AND active_token=? AND lease_epoch=? AND checkpoint=? AND input_revision=? AND lease_until>${DB_NOW} AND slice_until>${DB_NOW}`;
const fenceValues = (f: WriteFence) => [f.jobId, f.token, f.epoch, f.cursor, f.inputRevision];
type RequestRow = {request_id: string; job_id: string; source: string; send_intent: string; scope_hash: string};

export class DailyRepository {
  private database: D1Database;
  constructor(database: D1Database = getRawDb()) { this.database = database; }
  async job(id: string) {
    return this.database.prepare('SELECT * FROM job_runs WHERE id=? AND pipeline_version=2').bind(id).first<DailyJobRow>();
  }
  async request(id: string) {
    return this.database.prepare('SELECT request_id,job_id,source,send_intent,scope_hash FROM daily_requests WHERE request_id=?').bind(id).first<RequestRow>();
  }
  async pool() {
    return (await this.database.prepare("SELECT symbol,name FROM instruments WHERE active=1 AND symbol!='SPY' ORDER BY symbol").all<{symbol: string; name: string}>()).results;
  }
  async revision() {
    return (await this.database.prepare("SELECT accepted_revision FROM daily_resources WHERE name='market'").first<{accepted_revision: number}>())?.accepted_revision ?? 0;
  }
  async admit(request: DailyRequest, target: string, poolVersion: string, algorithm: string, card: string, calendar: string, revision: number) {
    const previous = await this.request(request.requestId);
    if (previous) return this.mapped(previous, request);
    const id = crypto.randomUUID(), at = new Date().toISOString();
    await this.database.batch([
      this.database.prepare(`INSERT INTO job_runs(id,started_at,status,message,pipeline_version,active_key,requested_closed_day,scope_hash,pool_version,algorithm_version,card_version,calendar_version,input_revision,stage)
        SELECT ?,?,'queued','已持久受理；等待后台执行',?,?,?,?,?,?,?,?,?,'freezePool'
        WHERE NOT EXISTS(SELECT 1 FROM daily_requests WHERE request_id=?) ON CONFLICT(active_key) DO NOTHING`)
        .bind(id, at, PIPELINE_VERSION, request.scopeHash, target, request.scopeHash, poolVersion, algorithm, card, calendar, revision, request.requestId),
      this.database.prepare(`INSERT INTO daily_requests(request_id,source,requested_at,job_id,send_intent,schedule_occurrence,scope_hash)
        SELECT ?,?,?,id,?,?,? FROM job_runs WHERE active_key=? ON CONFLICT(request_id) DO NOTHING`)
        .bind(request.requestId, request.source, at, request.sendIntent, request.scheduleOccurrence, request.scopeHash, request.scopeHash),
    ]);
    const row = await this.request(request.requestId);
    if (!row) throw new Error('任务未持久受理，请重试同一请求编号');
    return this.mapped(row, request);
  }
  private async mapped(row: RequestRow, request: DailyRequest) {
    if (row.source !== request.source || row.send_intent !== request.sendIntent) throw new Error('请求编号已被不同来源使用');
    const job = await this.job(row.job_id);
    if (!job) throw new Error('任务映射不完整');
    return {requestId: row.request_id, job: jobDto(job), sendIntent: row.send_intent};
  }
  async status(now = Date.now()) {
    // SELECT only: deriving an interrupted view never reaps or retries a task.
    const [jobRows,currentRows,legacyRows,intentRows] = await this.database.batch([
      this.database.prepare('SELECT * FROM job_runs WHERE pipeline_version=2 ORDER BY started_at DESC,id DESC LIMIT 8'),
      this.database.prepare("SELECT r.id,r.trade_date,r.created_at,r.complete,c.accepted_revision,c.version,c.legacy FROM report_current c JOIN reports r ON r.id=c.report_id WHERE c.desk='desk'"),
      this.database.prepare('SELECT id,trade_date,created_at,complete FROM reports WHERE content_hash IS NULL ORDER BY trade_date DESC,created_at DESC,id DESC LIMIT 1'),
      this.database.prepare("SELECT job_id,MAX(CASE WHEN source='manual' THEN 1 ELSE 0 END) AS manual,MAX(CASE WHEN source='schedule' AND send_intent='original_schedule' THEN 1 ELSE 0 END) AS scheduled_send FROM daily_requests GROUP BY job_id"),
    ]);
    const intents = new Map((intentRows.results as {job_id:string;manual:number;scheduled_send:number}[]).map(r=>[r.job_id,r]));
    return {current: currentRows.results[0] ?? legacyRows.results[0] ?? null,
      jobs: (jobRows.results as DailyJobRow[]).map(j => ({...jobDto(j, now),
        manualRequested: !!intents.get(j.id)?.manual, originalScheduleSendRequested: !!intents.get(j.id)?.scheduled_send})),
      recovery: {cadence: 'hourly', guaranteedDelayMs: null}};
  }
  async existing(limit = 8) {
    return (await this.database.prepare(`SELECT id FROM job_runs WHERE pipeline_version=2 AND
      ((status IN ('queued','retry_wait') AND next_eligible_at<=${DB_NOW}) OR (status='running' AND lease_until<=${DB_NOW}))
      ORDER BY COALESCE(last_progress_at,started_at),id LIMIT ?`).bind(Math.max(1, Math.min(32, limit))).all<{id: string}>()).results;
  }
  async claim(jobId: string, expectedStage: DailyStage) {
    const token = crypto.randomUUID(), at = new Date().toISOString();
    const eligible = `id=? AND stage=? AND pipeline_version=2 AND status IN ('queued','retry_wait') AND next_eligible_at<=${DB_NOW} AND failed_attempts<3 AND active_budget_ms<=${WORK_BUDGET_MS - SLICE_BUDGET_MS}`;
    await this.database.batch([
      this.database.prepare(`INSERT INTO daily_attempts(id,job_id,attempt_no,started_at,status,checkpoint)
        SELECT id||':'||(failed_attempts+1),id,failed_attempts+1,?,'running',checkpoint FROM job_runs WHERE ${eligible}
        ON CONFLICT(job_id,attempt_no) DO NOTHING`).bind(at, jobId, expectedStage),
      this.database.prepare(`UPDATE job_runs SET status='running',active_token=?,lease_epoch=lease_epoch+1,lease_until=${DB_NOW}+?,slice_until=${DB_NOW}+25000,reserved_ms=?,attempt_id=id||':'||(failed_attempts+1),message='正在执行当前分片' WHERE ${eligible}`)
        .bind(token, LEASE_MS, SLICE_BUDGET_MS, jobId, expectedStage),
    ]);
    const job = await this.job(jobId);
    if (!job || job.active_token !== token) return null;
    return {job, fence: {jobId, token, epoch: job.lease_epoch, cursor: job.checkpoint, inputRevision: job.input_revision} satisfies WriteFence};
  }
  async checkpoint(fence: WriteFence, stage: DailyStage, payload: string, contentHash: string, usedMs: number) {
    return this.saveStep(fence,stage,[{symbol:'__pool__',kind:'manifest',payload,hash:contentHash}],usedMs);
  }
  async input<T>(job: DailyJobRow, symbol: string, kind: string): Promise<T | null> {
    const rows=(await this.database.prepare('SELECT payload,content_hash FROM daily_inputs WHERE job_id=? AND input_generation=? AND symbol=? AND kind=? ORDER BY chunk_no').bind(job.id,job.input_revision,symbol,kind).all<{payload:string;content_hash:string}>()).results;
    if(!rows.length)return null;
    const value=JSON.parse(rows.map(r=>r.payload).join('')) as T;
    if(rows.some(r=>r.content_hash!==rows[0].content_hash)||await hashFacts(value)!==rows[0].content_hash)throw new Error('冻结输入校验失败');
    return value;
  }
  async bundle(job:DailyJobRow,kinds:string[]=['manifest','report']) {
    const rows=(await this.database.prepare('SELECT symbol,kind,chunk_no,payload,content_hash FROM daily_inputs WHERE job_id=? AND input_generation=? AND kind IN (SELECT value FROM json_each(?)) ORDER BY symbol,kind,chunk_no').bind(job.id,job.input_revision,JSON.stringify(kinds)).all<{symbol:string;kind:string;chunk_no:number;payload:string;content_hash:string}>()).results;
    const groups=new Map<string,typeof rows>(),result=new Map<string,unknown>();
    for(const row of rows){const key=row.symbol+':'+row.kind;const group=groups.get(key)??[];group.push(row);groups.set(key,group);}
    for(const [key,group]of groups){if(group.some((r,i)=>r.chunk_no!==i||r.content_hash!==group[0].content_hash))throw new Error('冻结分块顺序或指纹无效');const value:unknown=JSON.parse(group.map(r=>r.payload).join(''));if(await hashFacts(value)!==group[0].content_hash)throw new Error('冻结输入校验失败');result.set(key,value);}
    return result;
  }
  async saved(job: DailyJobRow, kind: string) {
    return (await this.database.prepare('SELECT DISTINCT symbol FROM daily_inputs WHERE job_id=? AND input_generation=? AND kind=?').bind(job.id,job.input_revision,kind).all<{symbol:string}>()).results.map(r=>r.symbol);
  }
  async earningsState(symbol: string) {
    const calendar=await this.database.prepare('SELECT * FROM earnings_calendar WHERE symbol=?').bind(symbol).first<import('./earnings-read').CalendarRow>();
    const events=(await this.database.prepare('SELECT date,known_at AS knownAt,confidence FROM earnings_events WHERE symbol=? ORDER BY known_at,id').bind(symbol).all<import('./engine').EventDecision>()).results;
    return {calendar,events};
  }
  async saveStep(fence:WriteFence,stage:DailyStage,inputs:{symbol:string;kind:string;payload:string;hash:string}[],usedMs:number,patch:{tradeDate?:string;validationHash?:string}={}) {
    const owned=await this.job(fence.jobId);if(!owned||owned.active_token!==fence.token||owned.lease_epoch!==fence.epoch||owned.checkpoint!==fence.cursor)return false;
    const at=new Date().toISOString(),statements:D1PreparedStatement[]=[],chunkCounts=new Map<string,number>();
    for(const input of inputs){let chunk=0;
      for(let start=0;start<input.payload.length;chunk++){
        let end=Math.min(start+16000,input.payload.length);if(end<input.payload.length&&/[\uD800-\uDBFF]/.test(input.payload[end-1]))end--;
        const value=input.payload.slice(start,end);start=end;
        statements.push(this.database.prepare(`INSERT INTO daily_inputs(job_id,input_generation,symbol,kind,chunk_no,payload,content_hash)
          SELECT id,input_revision,?,?,?,?,? FROM job_runs WHERE ${OWNED} AND (SELECT COALESCE(SUM(length(CAST(payload AS BLOB))),0) FROM daily_inputs WHERE job_id=?)<67108864
          ON CONFLICT(job_id,input_generation,symbol,kind,chunk_no) DO UPDATE SET payload=excluded.payload,content_hash=excluded.content_hash`)
          .bind(input.symbol,input.kind,chunk,value,input.hash,...fenceValues(fence),fence.jobId));
      }
      chunkCounts.set(input.symbol+':'+input.kind,chunk);
    }
    statements.push(this.database.prepare(`UPDATE job_runs SET stage=?,trade_date=COALESCE(?,trade_date),validation_hash=COALESCE(?,validation_hash),checkpoint=checkpoint+1,status='queued',active_token=NULL,lease_until=0,
      active_budget_ms=active_budget_ms+?,reserved_ms=0,last_progress_at=?,message='当前分片已保存；等待后台续跑，实际恢复可能延迟' WHERE ${OWNED}`)
      .bind(stage,patch.tradeDate??null,patch.validationHash??null,Math.max(0,Math.min(25000,Math.ceil(usedMs))),at,...fenceValues(fence)));
    for(const input of inputs){
      statements.push(this.database.prepare(`INSERT INTO daily_events(job_id,kind,at,detail,assertion_ok) VALUES (?,'input-check',?,'saved',CASE WHEN (SELECT COUNT(*) FROM daily_inputs WHERE job_id=? AND input_generation=? AND symbol=? AND kind=? AND content_hash=?)=? THEN 1 ELSE 0 END)`)
        .bind(fence.jobId,at,fence.jobId,fence.inputRevision,input.symbol,input.kind,input.hash,chunkCounts.get(input.symbol+':'+input.kind)));
    }
    statements.push(this.database.prepare(`INSERT INTO daily_events(job_id,kind,at,detail,assertion_ok) VALUES (?,'checkpoint',?,'saved',CASE WHEN EXISTS(SELECT 1 FROM job_runs WHERE id=? AND status='queued' AND lease_epoch=? AND checkpoint=? AND input_revision=? AND active_token IS NULL AND last_progress_at=? AND slice_until>${DB_NOW}) THEN 1 ELSE 0 END)`)
      .bind(fence.jobId,at,fence.jobId,fence.epoch,fence.cursor+1,fence.inputRevision,at));
    await this.database.batch(statements);return true;
  }
  async recoverExpired(jobId:string) {
    const at=new Date().toISOString(),expired=`id=? AND pipeline_version=2 AND status='running' AND lease_until<=${DB_NOW}`;
    await this.database.batch([
      this.database.prepare(`UPDATE daily_attempts SET status='interrupted',finished_at=?,reason='执行者中断' WHERE id IN (SELECT attempt_id FROM job_runs WHERE ${expired})`).bind(at,jobId),
      this.database.prepare(`UPDATE job_runs SET failed_attempts=failed_attempts+1,active_budget_ms=active_budget_ms+reserved_ms,reserved_ms=0,active_token=NULL,lease_until=0,
        status=CASE WHEN failed_attempts+1>=3 OR active_budget_ms+reserved_ms>${WORK_BUDGET_MS-25000} THEN 'failed' ELSE 'retry_wait' END,
        active_key=CASE WHEN failed_attempts+1>=3 OR active_budget_ms+reserved_ms>${WORK_BUDGET_MS-25000} THEN NULL ELSE active_key END,
        finished_at=CASE WHEN failed_attempts+1>=3 OR active_budget_ms+reserved_ms>${WORK_BUDGET_MS-25000} THEN ? ELSE NULL END,
        next_eligible_at=${DB_NOW}+CASE WHEN failed_attempts=0 THEN 30000 ELSE 120000 END,message='执行已中断；检查点保留，等待后台恢复' WHERE ${expired}`).bind(at,jobId),
    ]);
  }
  async retry(fence:WriteFence,message:string) {
    const at=new Date().toISOString();
    await this.database.batch([
      this.database.prepare(`UPDATE daily_attempts SET status='failed',finished_at=?,reason=? WHERE id IN (SELECT attempt_id FROM job_runs WHERE ${OWNED})`).bind(at,message,...fenceValues(fence)),
      this.database.prepare(`UPDATE job_runs SET failed_attempts=failed_attempts+1,active_budget_ms=active_budget_ms+reserved_ms,reserved_ms=0,active_token=NULL,lease_until=0,
        status=CASE WHEN failed_attempts+1>=3 OR active_budget_ms+reserved_ms>${WORK_BUDGET_MS-25000} THEN 'failed' ELSE 'retry_wait' END,
        active_key=CASE WHEN failed_attempts+1>=3 OR active_budget_ms+reserved_ms>${WORK_BUDGET_MS-25000} THEN NULL ELSE active_key END,
        finished_at=CASE WHEN failed_attempts+1>=3 OR active_budget_ms+reserved_ms>${WORK_BUDGET_MS-25000} THEN ? ELSE NULL END,
        next_eligible_at=${DB_NOW}+CASE WHEN failed_attempts=0 THEN 30000 ELSE 120000 END,message=? WHERE ${OWNED}`).bind(at,message,...fenceValues(fence)),
      this.database.prepare(`INSERT INTO daily_events(job_id,kind,at,detail,assertion_ok) VALUES (?,'retry',?,? ,CASE WHEN EXISTS(
        SELECT 1 FROM job_runs j JOIN daily_attempts a ON a.id=j.attempt_id WHERE j.id=? AND j.pipeline_version=2
        AND j.status IN ('failed','retry_wait') AND j.active_token IS NULL AND j.lease_epoch=? AND j.checkpoint=? AND j.input_revision=?
        AND a.status='failed' AND a.finished_at=? AND j.message=? AND j.slice_until>${DB_NOW}) THEN 1 ELSE 0 END)`)
        .bind(fence.jobId,at,message,fence.jobId,fence.epoch,fence.cursor,fence.inputRevision,at,message),
    ]);
  }
  async reconcile(fence:WriteFence) {
    const pool=await this.pool(),revision=await this.revision(),at=new Date().toISOString();
    const poolVersion=await hashFacts(pool);
    await this.database.prepare(`UPDATE job_runs SET stage='freezePool',pool_version=?,input_revision=?,checkpoint=checkpoint+1,validation_hash=NULL,status='queued',
      active_budget_ms=active_budget_ms+reserved_ms,reserved_ms=0,active_token=NULL,lease_until=0,next_eligible_at=${DB_NOW}+30000,
      last_progress_at=?,message='输入基线已变化；重新核对完整冻结输入' WHERE ${OWNED}`).bind(poolVersion,revision,at,...fenceValues(fence)).run();
  }
  async expireBudget() {
    await this.database.prepare(`UPDATE job_runs SET status='failed',active_key=NULL,finished_at=?,message='累计执行预算或失败次数已耗尽'
      WHERE pipeline_version=2 AND status IN ('queued','retry_wait') AND (failed_attempts>=3 OR active_budget_ms>${WORK_BUDGET_MS-25000})`).bind(new Date().toISOString()).run();
  }
  async publish(fence:WriteFence,snapshot:import('./report').ReportSnapshot,card:unknown,markets:{symbol:string;fetchedAt:string}[],validationHash:string,earnings:{symbol:string;value:import('./daily-pipeline').FrozenEarnings}[]=[]) {
    const at=new Date().toISOString(),revision=fence.inputRevision+1;
    const own=`EXISTS(SELECT 1 FROM job_runs WHERE ${OWNED})`;
    const accepted=`EXISTS(SELECT 1 FROM daily_resources WHERE name='market' AND accepted_revision=${revision} AND (token IS NULL OR lease_until<=${DB_NOW}))`;
    const guard=`${own} AND ${accepted}`,args=()=>fenceValues(fence);
    await this.database.prepare("INSERT INTO daily_resources(name) VALUES ('market') ON CONFLICT(name) DO NOTHING").run();
    const statements:D1PreparedStatement[]=[
      this.database.prepare(`UPDATE daily_resources SET accepted_revision=accepted_revision+1 WHERE name='market' AND accepted_revision=? AND (token IS NULL OR lease_until<=${DB_NOW}) AND ${own}`).bind(fence.inputRevision,...args()),
      this.database.prepare(`INSERT INTO reports(id,trade_date,created_at,payload,card,complete,content_hash,input_revision)
        SELECT ?,?,?,?,?,1,?,? WHERE ${guard} ON CONFLICT(content_hash) DO NOTHING`).bind(snapshot.id,snapshot.tradeDate,snapshot.generatedAt,JSON.stringify(snapshot),JSON.stringify(card),snapshot.id,revision,...args()),
      this.database.prepare(`INSERT INTO report_current(desk,report_id,trade_date,accepted_revision,version,legacy)
        SELECT 'desk',id,trade_date,0,1,1 FROM reports WHERE content_hash IS NULL AND ${guard} ORDER BY trade_date DESC,created_at DESC,id DESC LIMIT 1 ON CONFLICT(desk) DO NOTHING`).bind(...args()),
    ];
    const frozen=`SELECT symbols.symbol,(SELECT group_concat(payload,'') FROM (SELECT payload FROM daily_inputs WHERE job_id=? AND input_generation=? AND symbol=symbols.symbol AND kind=? ORDER BY chunk_no)) AS payload
      FROM (SELECT DISTINCT symbol FROM daily_inputs WHERE job_id=? AND input_generation=? AND kind=?) symbols`;
    statements.push(
      this.database.prepare(`INSERT INTO bars(symbol,date,open,high,low,close,volume,raw_close,factor)
        SELECT m.symbol,json_extract(b.value,'$.date'),json_extract(b.value,'$.open'),json_extract(b.value,'$.high'),json_extract(b.value,'$.low'),json_extract(b.value,'$.close'),json_extract(b.value,'$.volume'),json_extract(b.value,'$.rawClose'),json_extract(b.value,'$.factor')
        FROM (${frozen}) m,json_each(m.payload,'$.bars') b WHERE ${guard}
        ON CONFLICT(symbol,date) DO UPDATE SET open=excluded.open,high=excluded.high,low=excluded.low,close=excluded.close,volume=excluded.volume,raw_close=excluded.raw_close,factor=excluded.factor`)
        .bind(fence.jobId,fence.inputRevision,'market',fence.jobId,fence.inputRevision,'market',...args()),
      this.database.prepare(`INSERT INTO scores(symbol,date,score,payload,version)
        SELECT m.symbol,json_extract(b.value,'$.date'),json_extract(b.value,'$.score'),b.value,json_extract(b.value,'$.version') FROM (${frozen}) m,json_each(m.payload) b WHERE ${guard}
        ON CONFLICT(symbol,date) DO UPDATE SET score=excluded.score,payload=excluded.payload,version=excluded.version`)
        .bind(fence.jobId,fence.inputRevision,'scores',fence.jobId,fence.inputRevision,'scores',...args()),
    );
    statements.push(this.database.prepare(`UPDATE instruments SET status='ready',error=NULL,updated_at=? WHERE symbol IN (SELECT json_extract(value,'$.symbol') FROM json_each(?)) AND ${guard}`).bind(at,JSON.stringify(markets.map(m=>({symbol:m.symbol}))),...args()));
    const calendars=earnings.filter(e=>e.value.info).map(e=>({symbol:e.symbol,...e.value.info}));
    statements.push(
      this.database.prepare(`INSERT INTO earnings_calendar(symbol,date,end_date,status,timing,source,source_url,mode,checked_at,next_check,revision,needs_recompute)
        SELECT json_extract(value,'$.symbol'),json_extract(value,'$.date'),json_extract(value,'$.endDate'),json_extract(value,'$.status'),json_extract(value,'$.timing'),json_extract(value,'$.source'),json_extract(value,'$.sourceUrl'),json_extract(value,'$.mode'),json_extract(value,'$.checkedAt'),${DB_NOW}+86400000,1,0 FROM json_each(?) WHERE ${guard}
        ON CONFLICT(symbol) DO UPDATE SET date=excluded.date,end_date=excluded.end_date,status=excluded.status,timing=excluded.timing,source=excluded.source,source_url=excluded.source_url,checked_at=excluded.checked_at,next_check=excluded.next_check,revision=earnings_calendar.revision+1,needs_recompute=0`).bind(JSON.stringify(calendars),...args()),
      this.database.prepare(`INSERT INTO earnings_events(symbol,date,known_at,source,recorded_at,confidence,source_url,timing)
        SELECT json_extract(value,'$.symbol'),json_extract(value,'$.newEvent.date'),json_extract(value,'$.newEvent.knownAt'),json_extract(value,'$.info.source'),?,json_extract(value,'$.newEvent.confidence'),json_extract(value,'$.info.sourceUrl'),json_extract(value,'$.info.timing') FROM json_each(?) WHERE ${guard}`).bind(at,JSON.stringify(earnings.filter(e=>e.value.newEvent).map(e=>({symbol:e.symbol,...e.value}))),...args()),
      this.database.prepare(`UPDATE instruments SET event_date=(SELECT json_extract(value,'$.date') FROM json_each(?) WHERE json_extract(value,'$.symbol')=instruments.symbol)
        WHERE symbol IN (SELECT json_extract(value,'$.symbol') FROM json_each(?)) AND ${guard}`).bind(JSON.stringify(calendars),JSON.stringify(calendars),...args()),
    );
    statements.push(
      this.database.prepare(`INSERT INTO report_current(desk,report_id,trade_date,accepted_revision,version,legacy)
        SELECT 'desk',id,trade_date,?,1,0 FROM reports WHERE id=? AND complete=1 AND ${guard}
        ON CONFLICT(desk) DO UPDATE SET report_id=excluded.report_id,trade_date=excluded.trade_date,accepted_revision=excluded.accepted_revision,version=report_current.version+1,legacy=0
        WHERE excluded.trade_date>report_current.trade_date OR (excluded.trade_date=report_current.trade_date AND excluded.accepted_revision>report_current.accepted_revision)`)
        .bind(revision,snapshot.id,...args()),
      this.database.prepare(`UPDATE daily_attempts SET status='ready',finished_at=? WHERE id IN(SELECT attempt_id FROM job_runs WHERE ${OWNED}) AND ${accepted}`).bind(at,...args()),
      this.database.prepare(`UPDATE job_runs SET status=CASE WHEN (SELECT created_at FROM reports WHERE id=?)=? THEN 'ready' ELSE 'reused' END,report_id=?,finished_at=?,completed_epoch=lease_epoch,
        active_key=NULL,active_budget_ms=active_budget_ms+reserved_ms,reserved_ms=0,message='完整日报已保存；飞书状态独立' WHERE ${OWNED} AND validation_hash=? AND ${accepted}`)
        .bind(snapshot.id,snapshot.generatedAt,snapshot.id,at,...args(),validationHash),
      this.database.prepare(`INSERT INTO daily_commits(job_id,report_id,completed_epoch,committed_at,assertion_ok) VALUES (?,?,?,?,
        CASE WHEN EXISTS(SELECT 1 FROM job_runs j JOIN reports r ON r.id=j.report_id JOIN daily_attempts a ON a.id=j.attempt_id
          WHERE j.id=? AND j.pipeline_version=2 AND j.status IN ('ready','reused') AND j.active_token=? AND j.lease_epoch=? AND j.completed_epoch=? AND j.checkpoint=? AND j.input_revision=?
          AND j.lease_until>${DB_NOW} AND j.slice_until>${DB_NOW} AND j.validation_hash=? AND r.id=? AND r.complete=1 AND r.content_hash=? AND a.status='ready' AND a.finished_at=j.finished_at
          AND EXISTS(SELECT 1 FROM report_current c WHERE c.desk='desk' AND c.trade_date>=r.trade_date AND (c.trade_date>r.trade_date OR c.accepted_revision>=?)) AND ${accepted}) THEN 1 ELSE 0 END)`)
        .bind(fence.jobId,snapshot.id,fence.epoch,at,fence.jobId,fence.token,fence.epoch,fence.epoch,fence.cursor,fence.inputRevision,validationHash,snapshot.id,snapshot.id,revision),
    );
    await this.database.batch(statements);
    return this.job(fence.jobId);
  }
  async originalDelivery(requestId:string) {
    return this.database.prepare("SELECT j.report_id,r.schedule_occurrence FROM daily_requests r JOIN job_runs j ON j.id=r.job_id WHERE r.request_id=? AND r.source='schedule' AND r.send_intent='original_schedule' AND r.schedule_occurrence IS NOT NULL AND j.status IN ('ready','reused')").bind(requestId).first<{report_id:string;schedule_occurrence:string}>();
  }
  async fail(fence: WriteFence, message: string, status:'failed'|'partial'='failed') {
    const at = new Date().toISOString();
    return this.database.batch([
      this.database.prepare(`UPDATE daily_attempts SET status='failed',reason=?,finished_at=?
        WHERE id IN (SELECT attempt_id FROM job_runs WHERE ${OWNED})`)
        .bind(message, at, ...fenceValues(fence)),
      this.database.prepare(`UPDATE job_runs SET status=?,message=?,finished_at=?,active_key=NULL,
        active_budget_ms=active_budget_ms+reserved_ms,reserved_ms=0,active_token=NULL,lease_until=0 WHERE ${OWNED}`)
        .bind(status, message, at, ...fenceValues(fence)),
      this.database.prepare(`INSERT INTO daily_events(job_id,kind,at,detail,assertion_ok)
        VALUES (?,'failed',?,?,CASE WHEN EXISTS(SELECT 1 FROM job_runs j JOIN daily_attempts a ON a.id=j.attempt_id
          WHERE j.id=? AND j.status IN ('failed','partial') AND j.lease_epoch=? AND j.finished_at=? AND a.status='failed' AND a.finished_at=?) THEN 1 ELSE 0 END)`)
        .bind(fence.jobId, at, message, fence.jobId, fence.epoch, at, at),
    ]);
  }
}

// The legacy market/calendar writers share this resource fence. External fetches
// happen outside the critical section; each actual SQL mutation is guarded.
import {AsyncLocalStorage} from 'node:async_hooks';
type ResourceFence = {token: string; epoch: number; revision: number; pending?: Promise<void>};
const marketContext = new AsyncLocalStorage<ResourceFence>();
const literal = (value: string) => "'" + value.replaceAll("'", "''") + "'";
const resourceGuard = (f: ResourceFence) => `EXISTS(SELECT 1 FROM daily_resources WHERE name='market' AND token=${literal(f.token)} AND epoch=${f.epoch} AND accepted_revision=${f.revision} AND lease_until>${DB_NOW})`;

export async function withMarketWrite<T>(operation: () => Promise<T>): Promise<T> {
  if (marketContext.getStore()) return operation();
  const database = getRawDb(), token = crypto.randomUUID();
  let row:{token:string;epoch:number;accepted_revision:number}|null=null;
  for(let attempt=0;attempt<12;attempt++){
    await database.prepare(`INSERT INTO daily_resources(name,token,epoch,lease_until) VALUES ('market',?,1,${DB_NOW}+120000)
      ON CONFLICT(name) DO UPDATE SET token=excluded.token,epoch=daily_resources.epoch+1,lease_until=excluded.lease_until WHERE daily_resources.lease_until<=${DB_NOW} OR daily_resources.token IS NULL`).bind(token).run();
    row=await database.prepare("SELECT token,epoch,accepted_revision FROM daily_resources WHERE name='market'").first<{token:string;epoch:number;accepted_revision:number}>();
    if(row?.token===token)break;
    await new Promise(resolve=>setTimeout(resolve,20));
  }
  if(!row||row.token!==token)throw new Error('已有行情写入正在进行，请稍后重试');
  const fence = {token, epoch: row.epoch, revision: row.accepted_revision};
  try { return await marketContext.run(fence, operation); }
  finally { await database.prepare(`UPDATE daily_resources SET token=NULL,lease_until=0 WHERE name='market' AND token=? AND epoch=?`).bind(token, fence.epoch).run(); }
}

// Limited grammar for the existing, fixed SQL templates (no caller SQL). Reject
// unsupported mutations rather than permit an unfenced writer. Tests exercise
// VALUES, INSERT SELECT/json_each, conflict upserts, UPDATE and DELETE forms.
export function guardMarketSql(sql: string, guard: string) {
  if (/^(SELECT|PRAGMA)\b/i.test(sql.trim())) return sql;
  if (/^INSERT\s+INTO\s+/i.test(sql)) {
    const values = /\bVALUES\s*\(([^()]*)\)/i;
    if (values.test(sql)) return sql.replace(values, (_, list: string) => `SELECT ${list} WHERE ${guard}`);
    if (/\bSELECT\b/i.test(sql)) {
      if (/\bWHERE\b/i.test(sql)) return sql.replace(/\bWHERE\b/i, `WHERE ${guard} AND`);
      const offset = sql.search(/\bON CONFLICT\b/i);
      return offset < 0 ? sql + ` WHERE ${guard}` : sql.slice(0, offset) + ` WHERE ${guard} ` + sql.slice(offset);
    }
  }
  if (/^(UPDATE|DELETE)\s+/i.test(sql) && /\bWHERE\b/i.test(sql)) return sql.replace(/\bWHERE\b/i, `WHERE ${guard} AND`);
  throw new Error('不支持的写入模板；未允许绕过写保护');
}

export function fencedMarketDb(database: D1Database) {
  function statement(text: string, values: unknown[] = []) {
    const mutating = !/^SELECT\b/i.test(text.trim());
    const fence = marketContext.getStore();
    if (mutating && !fence) throw new Error('行情写入缺少写保护上下文');
    const materialize = () => database.prepare(mutating ? guardMarketSql(text, resourceGuard(fence!)) : text).bind(...values);
    return {
      bind: (...args: unknown[]) => statement(text, args),
      first: <T = Record<string, unknown>>() => materialize().first<T>(),
      all: <T = Record<string, unknown>>() => materialize().all<T>(),
      run: async () => mutating ? (await commit([materialize], fence!))[0] : materialize().run(),
      materialize,
    };
  }
  async function commit(statements: (() => D1PreparedStatement)[], fence: ResourceFence) {
    // Materialize at execution, and serialize nested batches within this owner.
    // Preprepared later waves must observe the latest accepted revision.
    const previous=fence.pending??Promise.resolve();let release!:()=>void;
    fence.pending=new Promise<void>(resolve=>{release=resolve;});await previous;
    try {
    const expected = fence.revision + 1;
    const result = await database.batch([
      ...statements.map(make=>make()),
      database.prepare(`UPDATE daily_resources SET accepted_revision=accepted_revision+1 WHERE name='market' AND ${resourceGuard(fence)}`),
      database.prepare(`INSERT INTO daily_events(kind,at,detail,assertion_ok) VALUES ('market-write',?,'accepted',
        CASE WHEN EXISTS(SELECT 1 FROM daily_resources WHERE name='market' AND token=? AND epoch=? AND accepted_revision=? AND lease_until>${DB_NOW}) THEN 1 ELSE 0 END)`)
        .bind(new Date().toISOString(), fence.token, fence.epoch, expected),
    ]);
    fence.revision = expected;
    return result.slice(0, statements.length);
    } finally {release();}
  }
  return {
    prepare: statement,
    batch: async (statements: ReturnType<typeof statement>[]) => {
      const fence = marketContext.getStore();
      if (!fence) throw new Error('批量写入缺少写保护上下文');
      return commit(statements.map(s => s.materialize), fence);
    },
  } as unknown as D1Database;
}
