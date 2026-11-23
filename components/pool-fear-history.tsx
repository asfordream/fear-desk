"use client";
import {useEffect,useState} from 'react';
import {CartesianGrid,Line,LineChart,ResponsiveContainer,Tooltip,XAxis,YAxis} from 'recharts';
import {clientApi} from '@/lib/client-api';
import {elapsedTradingDates} from '@/lib/trading-calendar';

type Point={date:string;mean:number|null;valid:number;total:number;strike:number|null};
const format=(score:number)=>score.toFixed(0);

function Detail({point}:{point:Point}){
  if(point.mean===null)return <p>{point.date} · {point.total?'暂无有效评分':'暂无已保存日报'}</p>;
  const share=point.valid>0&&point.strike!==null
    ? `${point.strike}/${point.valid}（${(100*point.strike/point.valid).toFixed(1)}%）` : '—';
  return <p>{point.date} · 恐慌值 <strong>{format(point.mean)} 分</strong> · {point.valid}/{point.total} 只参与计算 · 击球区 {share}</p>;
}

export default function PoolFearHistory(){
  const [points,setPoints]=useState<Point[]>([]);
  const [status,setStatus]=useState<'loading'|'ready'|'error'>('loading');
  const [range,setRange]=useState(60);
  const [selected,setSelected]=useState('');
  useEffect(()=>{
    let active=true;
    async function load(){
      try{
        const rows=await clientApi('/api/desk/history');
        if(active){setPoints(rows);setStatus('ready');}
      }catch{if(active)setStatus('error');}
    }
    void load();
    const timer=setInterval(()=>{if(!document.hidden)void load();},30000);
    return ()=>{active=false;clearInterval(timer);};
  },[]);
  const first=points[0]?.date;
  const last=points.at(-1)?.date;
  const days=first&&last?elapsedTradingDates(first,last):null;
  const byDate=new Map(points.map(point=>[point.date,point]));
  const dates=days?[...new Set([first!,...days,...byDate.keys()])].sort():[...byDate.keys()];
  const visible=dates.slice(-range).map(date=>byDate.get(date)??{date,mean:null,valid:0,total:0,strike:null});
  const current=visible.find(point=>point.date===selected)??visible.at(-1);
  return <section className="watchlist-section" aria-label="观察池整体恐慌值历史走势">
    <div className="section-head chart-heading">
      <div><h2>观察池整体恐慌值走势</h2><p>{last?`收盘日报历史更新至 ${last}`:'来自已保存的完整收盘日报'}</p></div>
      <select aria-label="历史走势范围" value={range} onChange={e=>setRange(Number(e.target.value))}>
        {[20,60,120].map(n=><option key={n} value={n}>近 {n} 个交易日</option>)}
      </select>
    </div>
    {status==='error'&&<p role="status">历史走势暂时无法读取，稍后自动重试。</p>}
    {current?<><div className="chart pool-fear-chart"><ResponsiveContainer width="100%" height="100%">
      <LineChart data={visible} onClick={event=>{if(typeof event?.activeLabel==='string')setSelected(event.activeLabel);}}>
        <CartesianGrid vertical={false} stroke="var(--desk-line)" strokeDasharray="3 5"/>
        <XAxis dataKey="date" tickFormatter={date=>date.slice(5)} minTickGap={45}/>
        <YAxis width={38} domain={[0,100]} ticks={[0,50,100]}/>
        <Tooltip filterNull={false} content={({active,label})=>{
          const point=active&&visible.find(row=>row.date===label);
          return point?<div style={{background:'var(--background)',padding:8,border:'1px solid var(--desk-line)'}}><Detail point={point}/></div>:null;
        }}/>
        <Line dataKey="mean" stroke="var(--desk-accent)" strokeWidth={2} dot={{r:2}} isAnimationActive={false}/>
      </LineChart>
    </ResponsiveContainer></div>
    <label>查看交易日 <select value={current.date} onChange={e=>setSelected(e.target.value)}>
      {visible.map(point=><option key={point.date}>{point.date}</option>)}
    </select></label>
    <div aria-live="polite"><Detail point={current}/></div></>:status!=='error'&&<p>{status==='loading'?'正在读取历史走势…':'暂无已保存的完整收盘日报。'}</p>}
  </section>;
}
