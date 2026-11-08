// Deterministic synthetic markets for tests
function rng(seed){let a=seed>>>0;return()=>{a|=0;a=a+0x6D2B79F5|0;let t=Math.imul(a^a>>>15,1|a);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296}}
function series(seed,n,tf,{drift=0.0003,vol=0.02,start=1577836800,price=100,q=5e6}={}){const r=rng(seed);const S={t:[],o:[],h:[],l:[],c:[],q:[]};let p=price,d=0;
 for(let i=0;i<n;i++){d=0.98*d+drift*(r()-0.45);const o=p;p=Math.max(0.01,p*(1+d+vol*(r()-0.5)));const hi=Math.max(o,p)*(1+vol*0.3*r()),lo=Math.min(o,p)*(1-vol*0.3*r());
  S.t.push(start+i*tf);S.o.push(o);S.h.push(hi);S.l.push(lo);S.c.push(p);S.q.push(q*(0.5+r()*(r()<0.05?6:1)))}return S}
module.exports={series,rng};
