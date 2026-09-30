import {overview} from '@/lib/store';import {access,success,failure} from '@/lib/http';
export async function GET(req:Request){try{await access(req);return success(await overview());}catch(e){return failure(e);}}
