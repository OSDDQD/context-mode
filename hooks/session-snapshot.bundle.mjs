function a(t){return t.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&apos;")}var D=10;function p(t,r=4){return[...new Set(t.filter(o=>o.length>0))].slice(0,r).map(o=>o.length>80?o.slice(0,80):o)}function m(t,r){if(r.length===0)return"";let e=r.map(n=>`"${a(n)}"`).join(", ");return`
    For full details:
    ${a(t)}(
      queries: [${e}],
      source: "session-events"
    )`}function G(t,r){if(t.length===0)return"";let e=new Map;for(let g of t){let b=g.data,h=e.get(b);h||(h={ops:new Map},e.set(b,h));let d;g.type==="file_write"?d="write":g.type==="file_read"?d="read":g.type==="file_edit"?d="edit":d=g.type,h.ops.set(d,(h.ops.get(d)??0)+1)}let o=Array.from(e.entries()).slice(-D),u=[],i=[];for(let[g,{ops:b}]of o){let h=Array.from(b.entries()).map(([S,y])=>`${S}\xD7${y}`).join(", "),d=g.split("/").pop()??g;u.push(`    ${a(d)} (${a(h)})`),i.push(`${d} ${Array.from(b.keys()).join(" ")}`)}let s=p(i);return[`  <files count="${e.size}">`,...u,m(r,s),"  </files>"].join(`
`)}function X(t,r){if(t.length===0)return"";let e=[],n=[];for(let i of t)e.push(`    ${a(i.data)}`),n.push(i.data);let o=p(n);return[`  <errors count="${t.length}">`,...e,m(r,o),"  </errors>"].join(`
`)}function J(t,r){if(t.length===0)return"";let e=new Set,n=[],o=[];for(let s of t)e.has(s.data)||(e.add(s.data),n.push(`    ${a(s.data)}`),o.push(s.data));if(n.length===0)return"";let u=p(o);return[`  <decisions count="${n.length}">`,...n,m(r,u),"  </decisions>"].join(`
`)}function U(t,r){if(t.length===0)return"";let e=new Set,n=[],o=[];for(let s of t)e.has(s.data)||(e.add(s.data),s.type==="rule_content"?n.push(`    ${a(s.data)}`):n.push(`    ${a(s.data)}`),o.push(s.data));if(n.length===0)return"";let u=p(o);return[`  <rules count="${n.length}">`,...n,m(r,u),"  </rules>"].join(`
`)}function z(t,r){if(t.length===0)return"";let e=[],n=[];for(let i of t)e.push(`    ${a(i.data)}`),n.push(i.data);let o=p(n);return[`  <git count="${t.length}">`,...e,m(r,o),"  </git>"].join(`
`)}function K(t){if(t.length===0)return"";let r=[],e={};for(let s of t)try{let c=JSON.parse(s.data);typeof c.subject=="string"?r.push(c.subject):typeof c.taskId=="string"&&typeof c.status=="string"&&(e[c.taskId]=c.status)}catch{}if(r.length===0)return"";let n=new Set(["completed","deleted","failed"]),o=Object.keys(e).sort((s,c)=>Number(s)-Number(c)),u=[];for(let s=0;s<r.length;s++){let c=o[s],g=c?e[c]??"pending":"pending";n.has(g)||u.push(r[s])}if(u.length===0)return"";let i=[];for(let s of u)i.push(`    [pending] ${a(s)}`);return i.join(`
`)}function P(t,r){let e=K(t);if(!e)return"";let n=[];for(let s of t)try{let c=JSON.parse(s.data);typeof c.subject=="string"&&n.push(c.subject)}catch{}let o=p(n);return[`  <task_state count="${e.split(`
`).length}">`,e,m(r,o),"  </task_state>"].join(`
`)}function H(t,r,e){if(t.length===0&&r.length===0)return"";let n=[],o=[];if(t.length>0){let s=t[t.length-1];n.push(`    cwd: ${a(s.data)}`),o.push("working directory")}for(let s of r)n.push(`    ${a(s.data)}`),o.push(s.data);let u=p(o);return["  <environment>",...n,m(e,u),"  </environment>"].join(`
`)}function Q(t,r){if(t.length===0)return"";let e=[],n=[];for(let i of t){let s=i.type==="subagent_completed"?"completed":i.type==="subagent_launched"?"launched":"unknown";e.push(`    [${s}] ${a(i.data)}`),n.push(`subagent ${i.data}`)}let o=p(n);return[`  <subagents count="${t.length}">`,...e,m(r,o),"  </subagents>"].join(`
`)}function V(t,r){if(t.length===0)return"";let e=new Map;for(let s of t){let c=s.data.split(":")[0].trim();e.set(c,(e.get(c)??0)+1)}let n=[],o=[];for(let[s,c]of e)n.push(`    ${a(s)} (${c}\xD7)`),o.push(`skill ${s} invocation`);let u=p(o);return[`  <skills count="${t.length}">`,...n,m(r,u),"  </skills>"].join(`
`)}function W(t,r){if(t.length===0)return"";let e=new Set,n=[],o=[];for(let s of t)e.has(s.data)||(e.add(s.data),n.push(`    ${a(s.data)}`),o.push(s.data));if(n.length===0)return"";let u=p(o);return[`  <roles count="${n.length}">`,...n,m(r,u),"  </roles>"].join(`
`)}function Y(t){if(t.length===0)return"";let r=t[t.length-1];return`  <intent mode="${a(r.data)}"/>`}function Z(t){if(t.length===0)return"";let r=t[t.length-1];return["  <session_goal>","  The active objective for this session. Keep working toward it until it is met; do not ask the user to restate it.",`    ${a(r.data)}`,"  </session_goal>"].join(`
`)}var tt=3,nt=400;function et(t,r){let e=[...t];return e.length<=r?t:e.slice(0,r).join("")}function st(t){if(t.length===0)return"";let e=t.slice(-tt).map(n=>{let o=et(n.data??"",nt);return o?`    <message>${a(o)}</message>`:""}).filter(Boolean);return e.length===0?"":[`  <recent_user_messages count="${e.length}">`,...e,"  </recent_user_messages>"].join(`
`)}function it(t,r){let e=r?.compactCount??1,n=r?.searchTool??"ctx_search",o=new Date().toISOString(),u=[],i=[],s=[],c=[],g=[],b=[],h=[],d=[],S=[],y=[],$=[],k=[],v=[],E=[];for(let f of t)switch(f.category){case"file":u.push(f);break;case"task":i.push(f);break;case"rule":s.push(f);break;case"decision":c.push(f);break;case"cwd":g.push(f);break;case"error":b.push(f);break;case"env":h.push(f);break;case"git":d.push(f);break;case"subagent":S.push(f);break;case"intent":y.push(f);break;case"goal":$.push(f);break;case"skill":k.push(f);break;case"role":v.push(f);break;case"user-prompt":E.push(f);break}let l=[];l.push(`  <how_to_search>
  Each section below contains a summary of prior work.
  For FULL DETAILS, run the exact tool call shown under each section.
  Do NOT ask the user to re-explain prior work. Search first.
  Do NOT invent your own queries \u2014 use the ones provided.
  </how_to_search>`);let w=Z($);w&&l.push(w);let L=G(u,n);L&&l.push(L);let T=X(b,n);T&&l.push(T);let _=J(c,n);_&&l.push(_);let j=U(s,n);j&&l.push(j);let M=z(d,n);M&&l.push(M);let O=P(i,n);O&&l.push(O);let q=H(g,h,n);q&&l.push(q);let B=Q(S,n);B&&l.push(B);let N=V(k,n);N&&l.push(N);let x=W(v,n);x&&l.push(x);let C=Y(y);C&&l.push(C);let F=st(E);F&&l.push(F);let A=`<session_resume events="${t.length}" compact_count="${e}" generated_at="${o}">`,I="</session_resume>",R=l.join(`

`);return R?`${A}

${R}

${I}`:`${A}
${I}`}export{it as buildResumeSnapshot,K as renderTaskState};
