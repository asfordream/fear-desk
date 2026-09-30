import Reports from '@/components/reports';
export default async function Page({params}:{params:Promise<{id:string}>}){return <Reports id={(await params).id}/>;}
