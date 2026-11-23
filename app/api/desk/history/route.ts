import {getRawDb} from '@/db';
import {access,failure,success} from '@/lib/http';

export async function GET(req:Request){
  try{
    await access(req);
    const {results}=await getRawDb().prepare(`
      WITH snapshots AS (
        SELECT trade_date,payload,ROW_NUMBER() OVER (
          PARTITION BY trade_date ORDER BY created_at DESC,id DESC
        ) AS position
        FROM reports WHERE complete=1
      )
      SELECT trade_date AS date,
        json_extract(payload,'$.summary.mean') AS mean,
        json_extract(payload,'$.summary.valid') AS valid,
        json_extract(payload,'$.summary.total') AS total,
        json_extract(payload,'$.summary.bands[0].count') AS strike
      FROM snapshots WHERE position=1
      ORDER BY trade_date DESC LIMIT 120
    `).all();
    return success(results.reverse());
  }catch(e){return failure(e);}
}
