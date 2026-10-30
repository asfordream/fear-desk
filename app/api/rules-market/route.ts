import {getRawDb} from '@/db';
import {access,success,failure} from '@/lib/http';
// A single batch keeps watchlist membership and adjusted bars in one D1 snapshot.
export async function GET(req:Request){try{await access(req);const db=getRawDb();const [instruments,bars]=await db.batch([db.prepare("SELECT symbol FROM instruments WHERE active=1 AND symbol!='SPY' ORDER BY symbol"),db.prepare("SELECT b.symbol,b.date,b.close FROM bars b JOIN instruments i ON i.symbol=b.symbol WHERE i.active=1 AND b.symbol!='SPY' ORDER BY b.symbol,b.date")]);return success({instruments:instruments.results,bars:bars.results});}catch(e){return failure(e);}}
