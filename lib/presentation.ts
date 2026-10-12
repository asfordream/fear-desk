type ScoreValue = { score: number | null };
type ScorePair = { latest?: ScoreValue | null; previous?: ScoreValue | null };

export function scoreChange(current?: ScoreValue | null, previous?: ScoreValue | null): number | null {
  if (current?.score == null || previous?.score == null) return null;
  return current.score - previous.score;
}

export function changeTone(value: number | null): 'up' | 'down' | 'flat' {
  return value == null || value === 0 ? 'flat' : value > 0 ? 'up' : 'down';
}

export function compareScoreChanges(a: ScorePair, b: ScorePair): number {
  const da = scoreChange(a.latest, a.previous);
  const db = scoreChange(b.latest, b.previous);
  if (da == null) return db == null ? 0 : 1;
  if (db == null) return -1;
  return db - da;
}

export function manualSendState(input:{configured:boolean;complete:boolean;status?:string|null;sending?:boolean}){
 if(input.sending||input.status==='sending')return {disabled:true,label:'发送中',reason:'正在确认投递结果，请勿重复提交'};
 if(input.status==='unknown')return {disabled:true,label:'发送结果待核对',reason:'结果尚不确定，重复发送已阻断'};
 if(input.status==='sent')return {disabled:true,label:'已发送',reason:'此日报已有成功回执；不表示今天的定时任务已完成'};
 if(!input.configured)return {disabled:true,label:'发送此日报到飞书群',reason:'等待发送配置加载或完善'};
 if(!input.complete)return {disabled:true,label:'发送此日报到飞书群',reason:'尚无完整日报，生成及完整性校验通过后可发送'};
 return {disabled:false,label:'发送此日报到飞书群',reason:'手动发送当前日报；自动推送按排程日独立去重'};
}
