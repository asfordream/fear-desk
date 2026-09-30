import Desk from '@/components/desk';
export default async function Page({params}:{params:Promise<{symbol:string}>}){return <Desk symbol={(await params).symbol}/>;}
