import {removeSymbol} from '@/lib/store';import {ticker} from '@/lib/provider';import {access,success,failure} from '@/lib/http';
export async function DELETE(req:Request,{params}:{params:Promise<{symbol:string}>}){try{await access(req);return success(await removeSymbol(ticker((await params).symbol)));}catch(e){return failure(e);}}
