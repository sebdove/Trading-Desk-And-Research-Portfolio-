// Headless copy of the PVSRA Vector Desk consensus model (same rules as the desk, 'protected' preset)
(function(root){const ENG=(()=>{
const BO_HOURS=[7,8,9,10,11,12,13,14,15,16,17,18,19,20];
const P={brk:0,climaxOnly:1,hours:[7,8,9,10,11,12,13,14,15,16],stopBuf:1.5,fixedRR:2,horizon:120,minScore:70,dailyTrend:1};
function agg(b,tf){const out=[];let cur=null;const off=tf===604800?345600:0;
  for(const x of b){const k=Math.floor((x.time-off)/tf)*tf+off;
    if(!cur||cur.time!==k){cur={time:k,open:x.open,high:x.high,low:x.low,close:x.close,volume:x.volume};out.push(cur)}
    else{if(x.high>cur.high)cur.high=x.high;if(x.low<cur.low)cur.low=x.low;cur.close=x.close;cur.volume+=x.volume}}return out}
function pvsra(b,L=10){return b.map((x,i)=>{const bull=x.close>=x.open;if(i<L)return{cls:'normal',bull,ratio:null};
  let s=0,mx=0;for(let j=i-L;j<i;j++){s+=b[j].volume;const sv=(b[j].high-b[j].low)*b[j].volume;if(sv>mx)mx=sv}
  const avg=s/L,sv=(x.high-x.low)*x.volume,ratio=avg?x.volume/avg:0;
  return{cls:(ratio>=2||(mx>0&&sv>=mx))?'climax':ratio>=1.5?'rising':'normal',bull,ratio}})}
function ema(v,n){const k=2/(n+1),o=new Array(v.length);let e=v[0];for(let i=0;i<v.length;i++){e=i?v[i]*k+e*(1-k):v[0];o[i]=e}return o}
function calcZones(b,pv){const zones=[],active=[];
  for(let j=0;j<b.length;j++){const x=b[j];
    for(let a=active.length-1;a>=0;a--){const z=active[a];
      if(x.low<=z.top&&x.high>=z.bot){if(x.low<=z.bot&&x.high>=z.top){z.rec=j;active.splice(a,1)}else if(x.low>z.bot)z.top=x.low;else z.bot=x.high;
        if(z.top-z.bot<=0){z.rec=j;active.splice(a,1)}}}
    const p=pv[j];if(p.cls!=='normal'){const top=Math.max(x.open,x.close),bot=Math.min(x.open,x.close);
      if(top>bot){const z={i:j,bull:p.bull,kind:p.cls,top,bot,top0:top,bot0:bot,rec:-1};zones.push(z);active.push(z)}}}return zones}
function atrCalc(b,n=14){const o=new Array(b.length);let a=0;
  for(let i=0;i<b.length;i++){const tr=i?Math.max(b[i].high-b[i].low,Math.abs(b[i].high-b[i-1].close),Math.abs(b[i].low-b[i-1].close)):b[i].high-b[i].low;
    a=i<n?(a*i+tr)/(i+1):(a*(n-1)+tr)/n;o[i]=a}return o}
function signals(bars,pv,dr,e,A,zones,tf){const intraday=tf<14400,barsFor=(s,mn,mx)=>Math.max(mn,Math.min(mx,Math.round(s/tf)));
  const n=bars.length,out=[];let lastB=-99,lastS=-99,zs=0;
  for(let i=60;i<n;i++){const b=bars[i],p=pv[i],a=A[i];if(p.cls==='normal'||!a)continue;if(P.climaxOnly&&p.cls!=='climax')continue;
    if(P.hours&&intraday&&!P.hours.includes(new Date(b.time*1000).getUTCHours()))continue;
    const up=dr.c[i]>e[89][i]&&dr.c[i]>dr.c[i-5],dn=dr.c[i]<e[89][i]&&dr.c[i]<dr.c[i-5];let side=0,setup='';
    const lo3=Math.min(b.low,bars[i-1].low,bars[i-2].low),hi3=Math.max(b.high,bars[i-1].high,bars[i-2].high);
    if(up&&p.bull&&lo3<=dr.h[i]&&b.close>dr.c[i]){side=1;setup='Dragon pullback'}
    else if(dn&&!p.bull&&hi3>=dr.l[i]&&b.close<dr.c[i]){side=-1;setup='Dragon pullback'}
    else{for(let k=1;k<=3&&!side;k++){const j=i-k,q=pv[j],cb=bars[j];if(q.cls!=='climax'||j<21)continue;
        let mn=Infinity,mx=-Infinity;for(let m=j-20;m<j;m++){if(bars[m].low<mn)mn=bars[m].low;if(bars[m].high>mx)mx=bars[m].high}
        if(!q.bull&&cb.low<=mn&&p.bull&&b.close>cb.open){side=1;setup='Climax reversal'}else if(q.bull&&cb.high>=mx&&!p.bull&&b.close<cb.open){side=-1;setup='Climax reversal'}}}
    if(!side)continue;if(side>0&&i-lastB<6||side<0&&i-lastS<6)continue;side>0?lastB=i:lastS=i;
    if(P.dailyTrend&&!(side*(b.close-e.d50[i])>0))continue;
    const entry=b.close;let stop=side>0?Math.min(b.low,dr.l[i])-P.stopBuf*a:Math.max(b.high,dr.h[i])+P.stopBuf*a;
    if(Math.abs(entry-stop)<.5*a)stop=entry-side*.5*a;const risk=Math.abs(entry-stop);
    let target=null,magnet=false,best=Infinity;
    for(const z of zones){if(z.i>=i)break;if(z.rec<0||z.rec>i){const edge=side>0?z.bot0:z.top0,d=(edge-entry)*side;if(d>.5*a&&d<best){best=d;target=edge}}}
    if(target!=null)magnet=true;else target=entry+side*2*a;if(P.fixedRR)target=entry+side*P.fixedRR*risk;const rr=Math.abs(target-entry)/risk;
    let s=40;if(setup!=='Climax reversal')s+=(side>0?up:dn)?20:-10;else s+=(side>0?dn:up)?-5:5;s+=p.cls==='climax'?15:7;if(p.ratio>2.5)s+=5;
    s+=(side>0?entry>e[200][i]:entry<e[200][i])?10:-5;if(magnet&&rr>=1.5)s+=10;if(rr<1)s-=15;s=Math.max(5,Math.min(95,Math.round(s)));
    let outcome='open',exit=null;const hz=barsFor(P.horizon*900,20,3000);
    for(let j=i+1;j<n&&j<=i+hz;j++){const x=bars[j];if(side>0?x.low<=stop:x.high>=stop){outcome='loss';exit=j;break}if(side>0?x.high>=target:x.low<=target){outcome='win';exit=j;break}}
    if(outcome==='open'&&i+hz<n){outcome='timeout';exit=i+hz}
    out.push({i,side,score:s,outcome,exit,setup,entry,stop,target})}return out}
function breakoutModel(bars,A,d50,tf){const barsFor=(s,mn,mx)=>Math.max(mn,Math.min(mx,Math.round(s/tf)));
  const n=bars.length,N=tf<=3600?Math.round(86400/tf):20,useH=tf<14400,cd=Math.max(4,N>>2),HB=barsFor(360000,50,4000);
  const hh=new Array(n).fill(null),ll=new Array(n).fill(null),dq=[],dq2=[];
  for(let i=0;i<n;i++){if(i>=N){hh[i]=bars[dq[0]].high;ll[i]=bars[dq2[0]].low}
    while(dq.length&&bars[dq[dq.length-1]].high<=bars[i].high)dq.pop();dq.push(i);if(dq[0]<=i-N)dq.shift();
    while(dq2.length&&bars[dq2[dq2.length-1]].low>=bars[i].low)dq2.pop();dq2.push(i);if(dq2[0]<=i-N)dq2.shift()}
  const trades=[];let lb=-1e9,ls=-1e9;
  for(let i=N+1;i<n;i++){const c=bars[i].close,a=A[i];if(!a||hh[i]==null||hh[i-1]==null)continue;
    if(useH&&!BO_HOURS.includes(new Date(bars[i].time*1000).getUTCHours()))continue;
    let side=0;if(c>hh[i]&&bars[i-1].close<=hh[i-1])side=1;else if(c<ll[i]&&bars[i-1].close>=ll[i-1])side=-1;if(!side)continue;
    if(!(side*(c-d50[i])>0))continue;if(side>0?i-lb<cd:i-ls<cd)continue;side>0?lb=i:ls=i;
    const entry=c,risk=2.5*a;let stop=entry-side*risk,exit=null,outcome='open';
    for(let j=i+1;j<n&&j<=i+HB;j++){const x=bars[j];if(((side>0?x.low:x.high)-stop)*side<=0){exit=j;outcome='closed';break}
      const ns=x.close-side*4*A[j];stop=side>0?Math.max(stop,ns):Math.min(stop,ns)}
    if(outcome==='open'&&i+HB<n){exit=i+HB;outcome='closed'}trades.push({i,side,exit,outcome,entry,stop,N})}return trades}
function momentumDaily(base,bars){const days=agg(base,86400),pos=new Map(days.map((d,k)=>[d.time,k]));
  const st=days.map((d,k)=>{const j=k-1;if(j<28)return null;let s=0;for(const L of[7,14,28])s+=Math.sign(days[j].close/days[j-L].close-1);return s/3});
  return bars.map(x=>{const k=pos.get(Math.floor(x.time/86400)*86400);return k==null?null:st[k]})}
// build consensus for bars at timeframe tf from base bars (base tf <= tf)
function build(base,tf,pre){const bars=pre?base:agg(base,tf);const pv=pvsra(bars);const H=bars.map(b=>b.high),L=bars.map(b=>b.low),Cl=bars.map(b=>b.close);
  const dr={h:ema(H,34),l:ema(L,34),c:ema(Cl,34)},e={89:ema(Cl,89),200:ema(Cl,200)};const zones=calcZones(bars,pv);
  const days=agg(base,86400),dE=ema(days.map(d=>d.close),50),pos=new Map(days.map((d,k)=>[d.time,k]));
  e.d50=bars.map(x=>{const k=pos.get(Math.floor(x.time/86400)*86400);return k>=10?dE[k-1]:NaN});
  const A=atrCalc(bars),sig=signals(bars,pv,dr,e,A,zones,tf).filter(x=>x.score>=P.minScore),bo=breakoutModel(bars,A,e.d50,tf),mo=momentumDaily(base,bars);
  const n=bars.length,pvv=new Float32Array(n),bov=new Float32Array(n),s=new Float32Array(n);
  const fill=(arr,i,ex,side)=>{for(let j=i;j<=Math.min(ex==null?n-1:ex-1,n-1);j++)arr[j]=side};
  sig.forEach(t=>fill(pvv,t.i,t.outcome==='open'?null:t.exit,t.side));bo.forEach(t=>fill(bov,t.i,t.outcome==='open'?null:t.exit,t.side));
  for(let i=0;i<n;i++)s[i]=Math.round(100*(pvv[i]+bov[i]+(mo[i]||0))/3);return{bars,A,s,pv:pvv,bo:bov,mo,sig,boT:bo,d50:e.d50}}
// consensus trades (desk logic): returns trades with entry/exit index & prices
function trades(V,M){const{bars,A,s}=V,n=bars.length,out=[];let pos=null;
  for(let i=1;i<n;i++){const x=bars[i];
    if(pos){const sd=pos.side;let px=null,why='';if(((sd>0?x.low:x.high)-pos.stop)*sd<=0){px=sd>0?Math.min(pos.stop,x.open):Math.max(pos.stop,x.open);why='stop'}
      else if(s[i]*sd<M.exit){px=x.close;why='exit'}
      if(px!=null){out.push({...pos,exit:i,px,why,t1:x.time});pos=null}}
    if(!pos){let sd=s[i]>=M.entry&&(M.reentry||s[i-1]<M.entry)?1:s[i]<=-M.entry&&(M.reentry||s[i-1]>-M.entry)?-1:0;if(sd<0&&M.longOnly)sd=0;
      if(sd&&A[i]){const risk=M.stopK*A[i];pos={i,side:sd,entry:x.close,risk,stop:x.close-sd*risk,t0:x.time,score:s[i]}}}}
  if(pos)out.push({...pos,exit:n-1,px:bars[n-1].close,why:'open',t1:bars[n-1].time});return out}
const MODELS={v1:{entry:30,exit:10,stopK:2.5,reentry:0,longOnly:0},v2:{entry:30,exit:10,stopK:2.5,reentry:1,longOnly:0},v3:{entry:30,exit:10,stopK:2.5,reentry:1,longOnly:1}};
return{agg,build,trades,MODELS,ema,atrCalc}})();if(typeof module!=="undefined")module.exports=ENG;else root.ENG=ENG})(typeof window!=="undefined"?window:globalThis);
