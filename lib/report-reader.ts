// One coherent read wins. Cancelled/older reads never replace visible content.
export class ReportReader {
 private sequence=0;
 private controller:AbortController|null=null;
 async read<T>(load:(signal:AbortSignal)=>Promise<T>):Promise<T|null>{
  const sequence=++this.sequence;this.controller?.abort();const controller=new AbortController();this.controller=controller;
  try{const value=await load(AbortSignal.any([controller.signal,AbortSignal.timeout(20_000)]));return sequence===this.sequence&&!controller.signal.aborted?value:null;}
  catch(error){if(sequence!==this.sequence||controller.signal.aborted)return null;throw error;}
 }
 cancel(){this.sequence++;this.controller?.abort();}
}
export function reportPollDelay(active:boolean){return active?5000:30000;}
