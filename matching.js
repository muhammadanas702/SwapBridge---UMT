// Pure matching engine: no DB, no HTTP. Unit-testable on its own.
const today=()=>new Date().toISOString().slice(0,10);
const live=r=>r.status==='active'&&(!r.expires||r.expires>=today());
export const canMatch=(a,b,blocks=[])=>
  a.id!==b.id&&a.uid!==b.uid&&live(a)&&live(b)&&
  a.course===b.course&&a.term===b.term&&
  a.cur===b.want&&a.want===b.cur&&
  !blocks.some(([x,y])=>(x===a.uid&&y===b.uid)||(x===b.uid&&y===a.uid));
export const explain=(course,cur,want)=>`${course}: you are in ${cur} and want ${want}; they are in ${want} and want ${cur}. Exact reciprocal fit - same course, same term, both requests live.`;
