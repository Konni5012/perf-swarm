const $ = (id) => document.getElementById(id);
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const number = (n) => new Intl.NumberFormat('en-US').format(n ?? 0);
const compact = (n) => new Intl.NumberFormat('en-US',{notation:'compact',maximumFractionDigits:1}).format(n ?? 0);
const clock = (at) => new Date(at).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit',second:'2-digit'});
const duration = (ms) => { const s=Math.max(0,Math.round(ms/1000)); return s<60 ? `${s}s` : s<3600 ? `${Math.floor(s/60)}m ${s%60}s` : `${Math.floor(s/3600)}h ${Math.floor(s%3600/60)}m`; };
const badge = (status) => `<span class="status ${esc(status)}">${esc(status)}</span>`;
let runs=[], selectedRun='', data, graphMode='time', selectedAgent='', inspectorTab='activity', selectedTurn='', dmPair='', boardLimit=80, dmLimit=80, inspectorLimit=60, fetching=false;
const expanded = new Set();
const rendered = new WeakMap();
function setHtml(element, html){if(rendered.get(element)===html)return;rendered.set(element,html);element.innerHTML=html;}
const initial = new URLSearchParams(location.search).get('run');
let currentView=['swarms','threads','agents'].includes(location.hash.slice(1))?location.hash.slice(1):'swarms', selectedThread=null, threadOrder='activity', threadFilter='all', messageMode='preview', returnFocus;
function runTitle(run){
  const group=run.key?.includes('/')?run.key.split('/')[0].replace(/^live-/, '').replace(/-runs$/, '').replaceAll('-', ' '):'';
  if(group&&!/^\d/.test(group))return group;
  const title=run.objective.replace(/https?:\/\/\S+/g,'').split(/[.!?]\s/)[0].trim();
  return title.length>64?title.slice(0,61)+'…':title;
}
function budgetBar(tokens,max){if(!max)return '';return `<span class="usage-bar"><span data-width="${max?Math.min(100,tokens/max*100):0}"></span></span>`;}
function setView(view){currentView=view;document.querySelectorAll('.view').forEach(el=>el.hidden=el.id!==`${view}-view`);document.querySelectorAll('.top-nav button').forEach(el=>el.classList.toggle('active',el.dataset.view===view));$('view-label').textContent=view==='swarms'?'':`/ ${view}`;history.replaceState(null,'',`${selectedRun?'?run='+encodeURIComponent(selectedRun):''}#${view}`);}
function color(id) { let hash=0; for(const c of id)hash=(hash*31+c.charCodeAt(0))>>>0; return ['rust','teal','violet','blue','olive','umber'][hash%6]; }
function displayName(id) { return data?.agents?.find(agent=>agent.id===id)?.name ?? id; }
function avatar(id) { return `<span class="avatar ${id==='user'?'user':''}">${esc(id.startsWith('worker-') ? displayName(id).slice(0,2):id==='user'?'U':'S')}</span>`; }
function author(id) { return `<button class="author ${color(id)}" data-action="agent" data-agent="${esc(id)}">${esc(displayName(id))}</button>`; }
function savedRender(id, html) {
  const element=$(id); const scroll=element.scrollTop;
  const opened=[...element.querySelectorAll('details[open][data-key]')].map(d=>d.dataset.key);
  setHtml(element,html); element.scrollTop=scroll;
  for(const d of element.querySelectorAll('details[data-key]')) if(opened.includes(d.dataset.key)) d.open=true;
}
async function request(path) { const response=await fetch(path); if(!response.ok) throw new Error(await response.text()); return response.json(); }
async function refresh() {
  if(fetching) return; fetching=true;
  try {
    runs=await request('/api/runs');
    if(!runs.some(r=>r.key===selectedRun)) selectedRun=runs.some(r=>r.key===initial)?initial:(runs[0]?.key??'');
    renderRuns(); $('empty').hidden=!!runs.length; $('content').hidden=!runs.length;
    if(runs.length) { const key=selectedRun; const result=await request(`/api/run?run=${encodeURIComponent(key)}`); if(key===selectedRun){data=result;render();} }
    $('error').hidden=true; $('updated').textContent=`Updated ${clock(Date.now())}`;
  } catch(error) { $('error').textContent=`Connection interrupted · ${error.message}`; $('error').hidden=false; $('updated').textContent='Disconnected'; }
  finally {fetching=false;}
}
function layout() {
  document.querySelectorAll('[data-left]:not([data-width])').forEach(el=>el.style.left=Number(el.dataset.left)+'%');
  document.querySelectorAll('[data-height]').forEach(el=>el.style.height=Number(el.dataset.height)+'px');
  document.querySelectorAll('[data-width]').forEach(el=>{ el.style.width=Number(el.dataset.width)+'%'; if(el.dataset.left!==undefined)el.style.left=Number(el.dataset.left)+'%'; });
}
function renderRuns() {
  const query=$('signal-search').value.toLowerCase();
  $('run-count').textContent=runs.length;
  $('live-count').textContent=`| ${runs.filter(r=>r.status==='running').length} live`;
  const html=runs.filter(r=>!query||`${r.objective} ${r.id} ${r.model}`.toLowerCase().includes(query)).map(r=>`<button class="run-item ${r.key===selectedRun?'current':''}" data-action="run" data-run="${esc(r.key)}" title="${esc(r.objective)}"><span class="run-heading">${badge(r.status)}<time class="run-date">${esc(new Date(r.createdAt).toLocaleString())}</time><span class="run-title">${esc(runTitle(r))}</span>${r.model?`<span class="run-model">✧ ${esc(r.model)}</span>`:''}</span><span class="run-runtime">${duration(r.elapsedMs??0)}</span><span class="run-meta"><span>${r.agents} agents</span><span>${r.threads??1} threads</span><span>${r.messages??0} msgs</span><span>${compact(r.tokens)} tokens</span>${budgetBar(r.tokens,r.maxTokens)}<span class="budget-note">${r.maxTokens?`${compact(r.tokens)} of ${compact(r.maxTokens)} tokens`:'reported usage'}</span></span></button>`).join('')||'<div class="no-messages">No swarms match.</div>';
  setHtml($('run-list'),html);layout();
}
function render() {
  const s=data.state,turns=data.spans.filter(s=>s.type==='turn');
  $('run-id').textContent=runTitle({...s,key:selectedRun});$('run-id').title=s.objective;
  $('objective-preview').textContent=s.objective;$('objective-full').textContent=s.objective;
  setHtml($('metrics'),`<div class="summary-runtime">${duration(s.elapsedMs)}</div><div class="summary-sub">${data.agents.length} AGENTS · LOCAL / READ ONLY</div>${badge(s.status)}<div class="summary-model">✧ ${esc(s.config.model)} <small>SWARM MODEL</small></div><div class="summary-total">${compact(s.tokens)}<small>TOKENS</small></div><div class="summary-usage">${number(turns.length)} turns | ${number(s.board.length+s.dms.length)} msgs</div><div class="summary-budget">${budgetBar(s.tokens,s.config.maxTokens)}${s.config.maxTokens?`${compact(Math.max(0,s.config.maxTokens-s.tokens))} tokens left of ${compact(s.config.maxTokens)}`:'includes cached context'}</div>`);
  renderGraph();renderMessages();renderThreads();renderTrace();renderAgents();renderOutcome();if(selectedAgent)renderInspector();if(selectedThread)renderThreadDialog();setView(currentView);layout();
}
function flame(left,width,label,actor,id,extra='',title='') {
  if(width<=0)return '';
  return `<button class="flame ${extra} ${actor?color(actor):''}" data-left="${Math.max(0,left)}" data-width="${Math.max(.12,Math.min(100-left,width))}" data-action="${id?'turn':'agent'}" data-agent="${esc(actor)}" data-turn="${esc(id)}" title="${esc(title||label)}">${esc(label)}</button>`;
}
function graphRow(label,content,actor='') { return `<div class="graph-row"><button class="graph-label" data-action="agent" data-agent="${esc(actor)}">${esc(label)}</button><div class="graph-track">${content}</div></div>`; }
function renderGraph() {
  const s=data.state, turns=data.spans.filter(t=>t.type==='turn');
  document.querySelectorAll('[data-action="graph-mode"]').forEach(b=>b.classList.toggle('selected',b.dataset.mode===graphMode));
  if(graphMode==='time') {
    const start=Math.min(Date.parse(s.createdAt),...turns.map(t=>t.start));
    const end=s.status==='running'?Date.now():Math.max(start+1000,Date.parse(data.events.at(-1)?.at??s.createdAt),...turns.map(t=>t.end??t.start));
    const range=Math.max(1000,end-start); let html=graphRow('SWARM',flame(0,100,`${s.workers.length} workers · ${duration(range)} wall time`,'','', 'root'));
    for(const a of data.agents) {
      const own=turns.filter(t=>t.actor===a.id);
      html+=graphRow(a.role==='helper'?'↳ '+a.id.split('/').at(-1):displayName(a.id),own.map((t,i)=>flame((t.start-start)/range*100,((t.end??end)-t.start)/range*100,`T${i+1}${t.tokens!==undefined?' · '+compact(t.tokens):''}`,a.id,t.id,`${a.role==='helper'?'helper':''} ${t.inferred?'inferred':''} ${t.status}`,`${a.id} · Turn ${i+1} · ${duration((t.end??end)-t.start)} · ${t.inferred?'estimated from activity events':t.status}${t.tokens!==undefined?' · '+number(t.tokens)+' reported tokens':''}`)).join('')||'<span class="loading">No recorded turns</span>',a.id);
    }
    setHtml($('graph'),html);$('graph-range').textContent=`${clock(start)} → ${clock(end)}`;
    $('graph-hint').textContent='Horizontal width = elapsed wall time. Parallel workers have separate lanes; click to inspect.';
  } else {
    const total=Math.max(1,s.tokens);let groupOffset=0,groupRow='',agentRow='',turnRow='';
    for(const worker of s.workers) {
      const group=data.agents.filter(a=>a.id===worker.id||a.parent===worker.id);
      const sum=group.reduce((n,a)=>n+a.tokens,0), groupWidth=sum/total*100;
      groupRow+=flame(groupOffset,groupWidth,`${worker.id} · ${compact(sum)}`,worker.id,'','tokens');
      let offset=groupOffset;
      for(const a of group) {
        const width=a.tokens/total*100;
        agentRow+=flame(offset,width,`${a.role==='helper'?'↳ ':''}${a.id.split('/').at(-1)} · ${compact(a.tokens)}`,a.id,'',a.role==='helper'?'helper':'tokens');
        const own=turns.filter(t=>t.actor===a.id&&t.tokens!==undefined);
        let recorded=0;
        own.forEach((t,i)=>{const tw=Math.min(t.tokens,Math.max(0,a.tokens-recorded))/total*100;turnRow+=flame(offset+recorded/total*100,tw,`T${i+1} · ${compact(t.tokens)}`,a.id,t.id,'tokens');recorded+=t.tokens;});
        const unassigned=Math.max(0,a.tokens-recorded);
        if(unassigned)turnRow+=flame(offset+recorded/total*100,unassigned/total*100,'Earlier / unattributed',a.id,'','inferred',`${number(unassigned)} tokens have no recorded turn attribution`);
        offset+=width;
      }
      groupOffset+=groupWidth;
    }
    if(data.unattributedTokens)groupRow+=flame(groupOffset,data.unattributedTokens/total*100,'Unattributed','','','other');
    $('graph').innerHTML=graphRow('SWARM',flame(0,100,`${number(s.tokens)} reported tokens`,'','','root'))+graphRow('WORKER GROUPS',groupRow)+graphRow('AGENTS',agentRow)+graphRow('TURNS',turnRow);
    $('graph-hint').textContent='Width = reported token use. Helpers nest within parent groups. Missing turn attribution is shown explicitly.';
    $('graph-range').textContent='Reported usage · includes cached context';
  }
  layout();
}
function messageHtml(m,dm=false,prefix='') {
  const key=`${prefix}${dm?'dm':'board'}-${m.id}`;const long=m.text.length>1000;
  return `<article class="message ${color(m.author)}"><time class="message-time" title="${esc(new Date(m.at).toLocaleString())}">${clock(m.at)}</time><div class="message-body"><div class="message-head">${author(m.author)}${dm?`<span class="arrow">→</span>${author(m.to)}`:''}<span class="message-chars">${dm?esc(m.status??'sent')+(m.requiresAck?' · ack requested':'')+' · ':''}▸ ${number(m.text.length)} chars</span></div><p class="${messageMode==='preview'&&!expanded.has(key)?'collapsed':''}">${esc(m.text)}</p>${long?`<button class="expand" data-action="expand" data-key="${esc(key)}">${expanded.has(key)?'Show less':'Expand message ↓'}</button>`:''}</div></article>`;
}
function pairKey(dm){return [dm.author,dm.to].sort().join(' ↔ ');}
function renderMessages() {
  const s=data.state;const query=$('board-search').value.toLowerCase();
  const board=s.board.filter(m=>!query||`${m.author} ${m.text}`.toLowerCase().includes(query));
  $('board-count').textContent=s.board.length;
  savedRender('board',`${board.length>boardLimit?'<button class="load-earlier" data-action="more-board">Load earlier messages</button>':''}${board.slice(-boardLimit).reverse().map(m=>messageHtml(m)).join('')||'<div class="no-messages">No board messages match.</div>'}`);
  $('dm-count').textContent=s.dms.length;const pairs=[...new Set(s.dms.map(pairKey))];
  const pairHtml=pairs.map(pair=>`<button class="pair-chip ${pair===dmPair?'selected':''}" data-action="pair" data-pair="${esc(pair)}">${esc(pair.split(' ↔ ').map(displayName).join(' ↔ '))}</button>`).join('');
  setHtml($('dm-filter'),pairHtml);
  $('dm-reset').hidden=!dmPair;
  const dms=s.dms.filter(m=>(!dmPair||pairKey(m)===dmPair)&&(!query||`${m.author} ${m.to} ${m.text}`.toLowerCase().includes(query)));
  savedRender('dms',`${dms.length>dmLimit?'<button class="load-earlier" data-action="more-dm">Load earlier messages</button>':''}${dms.slice(-dmLimit).reverse().map(m=>messageHtml(m,true)).join('')||'<div class="no-messages">No direct messages yet.</div>'}`);
}
function renderAgents() {
  const query=$('agent-search').value.toLowerCase();$('agent-count').textContent=data.agents.length;
  const total=Math.max(1,data.state.tokens);
  const html=data.agents.filter(a=>!query||`${a.id} ${a.name??''} ${a.model} ${a.status}`.toLowerCase().includes(query)).map(a=>{
    const tasks=data.state.tasks.filter(t=>t.owner===a.id);const helpers=data.state.children.filter(c=>c.parent===a.id);
    return `<tr tabindex="0" data-action="agent" data-agent="${esc(a.id)}" aria-label="Inspect ${esc(a.id)}"><td><div class="agent-name">${avatar(a.id)}${esc(displayName(a.id))}</div><span class="agent-sub">${a.parent?'Helper for '+esc(a.parent):a.id===data.state.integrator?'Integrator · main worker':'Main worker'}${helpers.length?' · '+helpers.length+' helpers':''}</span></td><td class="model">${esc(a.model)}</td><td>${badge(a.stallSince?'stalled':a.waiting?'waiting':a.status==='tapped_out'?'tapped out':a.parked?'sleeping':a.status)}<small>${a.lastHeartbeatAt?'active '+clock(a.lastHeartbeatAt):''}</small></td><td><span class="tokens-number">${a.tokensKnown===false?'—':number(a.tokens)}</span><div class="small-bar"><i data-width="${Math.min(100,a.tokens/total*100)}"></i></div></td><td>${number(a.turns)}</td><td class="work-note">${tasks.length?tasks.filter(t=>t.status==='done').length+'/'+tasks.length+' tasks done':a.role==='helper'?'Bounded subtask':'No assigned tasks'}</td><td class="row-arrow">↗</td></tr>`;
  }).join('');
  setHtml($('agent-rows'),html);layout();
}
function renderOutcome() {
  const s=data.state, entries=Object.entries(s.tapouts);
  $('outcome-phase').outerHTML=`<span id="outcome-phase" class="status">${esc(s.outcome?.status??'working')}</span>`;
  setHtml($('outcome-content'),`<div class="outcome-body"><div class="pause-note">${esc(s.phase??'implementation')} · generation ${s.frozenGeneration??s.artifactGeneration??0}${s.frozenGeneration!==undefined?' frozen':''}</div><div class="tapouts">${s.workers.map(w=>{const t=s.tapouts[w.id];return `<div class="tapout" title="${esc(t?.reason??'Working')}"><strong>${author(w.id)}</strong><span>${esc(t?.outcome??'Working')}</span></div>`;}).join('')}</div><div class="pause-note">${entries.length}/${s.workers.length} workers tapped out</div>${s.outcome?`<details class="outcome-report" open><summary>Run outcome: ${esc(s.outcome.status)}</summary>${s.outcome.reasons.map(r=>`<p>${esc(r)}</p>`).join('')}</details>`:''}${s.pauseReason?`<p class="pause-note">Paused: ${esc(s.pauseReason)}</p>`:''}</div>`);
}
function openInspector(agent,turn='') {
  if(!data)return;
  if(!data.agents.some(a=>a.id===agent))return;
  selectedAgent=agent;selectedTurn=turn;inspectorTab=turn?'activity':'messages';inspectorLimit=60;
  if(turn){const turns=data.spans.filter(t=>t.actor===agent&&t.type==='turn');const index=turns.findIndex(t=>t.id===turn);if(index>=0)inspectorLimit=Math.max(inspectorLimit,turns.length-index);}
  returnFocus=document.activeElement;$('inspector').hidden=false;$('scrim').hidden=false;renderInspector();$('close-inspector').focus();
}
function renderInspector() {
  const a=data.agents.find(a=>a.id===selectedAgent); if(!a)return;
  const turns=data.spans.filter(t=>t.actor===a.id&&t.type==='turn');const helpers=data.agents.filter(c=>c.parent===a.id);
  const messages=[...data.state.board.filter(m=>m.author===a.id).map(m=>({...m,kind:'board'})),...data.state.dms.filter(m=>m.author===a.id||m.to===a.id).map(m=>({...m,kind:'dm'}))].sort((a,b)=>b.at.localeCompare(a.at));
  const tasks=data.state.tasks.filter(t=>t.owner===a.id);const tapout=data.state.tapouts[a.id];
  let body='';
  if(inspectorTab==='activity') {
    body=turns.length?turns.slice(-inspectorLimit).reverse().map((t)=>{
      const index=turns.indexOf(t)+1, items=data.spans.filter(i=>i.parent===t.id);
      return `<details class="turn-card" data-key="${esc(t.id)}" ${selectedTurn===t.id?'open':''}><summary><strong>Turn ${index}</strong>${badge(t.status)}<span class="muted">${duration((t.end??Date.now())-t.start)}</span></summary><div class="turn-meta">${clock(t.start)}${t.end?' → '+clock(t.end):' · live'} · ${t.tokens!==undefined?number(t.tokens)+' reported tokens':'Token split unavailable'}${t.inferred?' · estimated from historical activity events':''}</div>${items.map(i=>`<details class="item-card" data-key="${esc(i.id)}"><summary>${esc(i.type)} <span class="muted">· ${duration((i.end??Date.now())-i.start)} · ${esc(i.status)}</span></summary><pre>${esc(i.detail||'No additional detail recorded.')}</pre></details>`).join('')||'<p class="muted">No tool detail recorded for this turn.</p>'}</details>`;
    }).join(''):'<div class="no-messages">No turns recorded yet.</div>';
    if(turns.length>inspectorLimit)body+='<button class="load-earlier" data-action="more-inspector">Load earlier turns</button>';
    const events=data.events.filter(e=>e.actor===a.id&&['approval','output','recovery','tap-out'].includes(e.type)).slice(-20).reverse();
    if(events.length)body+='<div class="mini-title">OUTPUT & REVIEW EVENTS</div>'+events.map((e,i)=>`<details class="activity-event" data-key="event-${i}-${esc(e.at)}"><summary>${clock(e.at)} · ${esc(e.type)}</summary><p>${esc(e.message)}</p></details>`).join('');
  } else if(inspectorTab==='messages') {
    body=messages.slice(0,inspectorLimit).map(m=>messageHtml(m,m.kind==='dm','inspector-')).join('')||'<div class="no-messages">No board posts or DMs for this agent.</div>';
    if(messages.length>inspectorLimit)body+='<button class="load-earlier" data-action="more-inspector">Load earlier messages</button>';
  } else if(inspectorTab==='browser') {
    const active=data.state.status==='running';
    body=active?`<div class="browser-view"><img id="browser-frame" alt="Live browser for ${esc(displayName(a.id))}"><p class="muted">Read-only live view. Closing this panel leaves the agent running. A frame appears once this agent uses its browser.</p></div>`:'<p class="muted">The browser is inactive while this swarm is paused or finished.</p>';
  } else {
    body=tasks.map(t=>`<article class="task-card"><h3>${esc(t.title)}</h3>${badge(t.status)}<p>${esc(t.description)}</p>${t.result?`<details><summary>Result & evidence</summary><p>${esc(t.result)}</p></details>`:''}</article>`).join('')||'<div class="no-messages">No claimed tasks.</div>';
    if(a.task)body+=`<article class="task-card"><h3>Parent assignment</h3><p>${esc(a.task)}</p>${a.result?`<p>${esc(a.result)}</p>`:''}</article>`;
  }
  const html=`${avatar(a.id)}<h2>${esc(a.id)}</h2>${badge(a.status)}<p class="model">${esc(a.model)} · ${esc(a.role)}</p><div class="inspector-metrics"><div><strong>${a.tokensKnown===false?'—':compact(a.tokens)}</strong><small>Reported tokens</small></div><div><strong>${turns.length}</strong><small>Recorded turns</small></div><div><strong>${helpers.length}</strong><small>Helpers</small></div></div><dl class="metadata">${a.parent?`<dt>Parent</dt><dd>${author(a.parent)}</dd>`:''}${a.threadId?`<dt>Codex thread</dt><dd>${esc(a.threadId)}</dd>`:''}${a.workspace?`<dt>Workspace</dt><dd>${esc(a.workspace)}</dd>`:''}${a.restarts!==undefined?`<dt>Recovery attempts</dt><dd>${a.restarts}</dd>`:''}${a.lastError?`<dt>Last error</dt><dd>${esc(a.lastError)}</dd>`:''}${tapout?`<dt>Tap-out · ${esc(tapout.outcome)}</dt><dd>${esc(tapout.reason)}</dd>`:''}</dl>${helpers.length?'<div class="mini-title">HELPERS</div>'+helpers.map(h=>`<p>${author(h.id)} ${badge(h.status)}</p>`).join(''):''}<div class="inspector-tabs">${a.role==='worker'?`<button data-action="inspector-tab" data-tab="browser" class="${inspectorTab==='browser'?'selected':''}">Open browser</button>`:''}<button data-action="inspector-tab" data-tab="activity" class="${inspectorTab==='activity'?'selected':''}">Activity</button><button data-action="inspector-tab" data-tab="messages" class="${inspectorTab==='messages'?'selected':''}">Messages ${messages.length}</button><button data-action="inspector-tab" data-tab="tasks" class="${inspectorTab==='tasks'?'selected':''}">Tasks ${tasks.length}</button></div>${body}`;
  const scroll=$('inspector').scrollTop;savedRender('inspector-content',html);$('inspector').scrollTop=scroll;
  const frame=$('browser-frame'); if(frame&&!document.hidden)frame.src=`/api/browser-frame?run=${encodeURIComponent(selectedRun)}&worker=${encodeURIComponent(a.id)}&frame=${Date.now()}`;
  selectedTurn='';
}
function closeInspector() { selectedAgent='';selectedTurn='';$('inspector').hidden=true;$('scrim').hidden=true;if(returnFocus?.isConnected)returnFocus.focus(); }
function threadData(){
  const s=data.state;
  return [{key:'board',title:'Primary thread',messages:s.board,kind:'board',members:[...new Set([...s.workers.map(w=>w.id),...s.board.map(m=>m.author)])]},...[...new Set(s.dms.map(pairKey))].map(pair=>({key:pair,title:pair,messages:s.dms.filter(m=>pairKey(m)===pair),kind:'dm',members:pair.split(' ↔ ')}))];
}
function timeline(messages){
  const start=Date.parse(data.state.createdAt),end=Math.max(start+1,...[...data.state.board,...data.state.dms].map(m=>Date.parse(m.at))),range=end-start;
  return '<span class="timeline-line"></span>'+messages.slice(-150).map(m=>`<span class="timeline-dot ${color(m.author)}" data-left="${(Date.parse(m.at)-start)/range*100}" title="${esc(m.author)} · ${clock(m.at)}"></span>`).join('');
}
function renderThreads(){
  const query=$('signal-search').value.toLowerCase();
  const threads=threadData().filter(t=>(threadFilter==='all'||t.kind===threadFilter)&&(!query||`${t.title} ${t.members.join(' ')} ${t.messages.at(-1)?.text??''}`.toLowerCase().includes(query)));
  threads.sort((a,b)=>threadOrder==='volume'?b.messages.length-a.messages.length:(b.messages.at(-1)?.at??'').localeCompare(a.messages.at(-1)?.at??''));
  const html=threads.map(t=>{
    const last=t.messages.at(-1);
    return `<article class="thread-row"><div class="thread-top"><button class="thread-name" data-action="thread" data-thread="${esc(t.key)}">${esc(t.title)}</button>${t.kind==='board'?badge(data.state.status):''}<div class="thread-timeline">${timeline(t.messages)}</div><span class="thread-volume">${t.messages.length}</span></div><div class="thread-members"><span>Agents:</span>${t.members.map(author).join('')}</div><button class="thread-preview" data-action="thread" data-thread="${esc(t.key)}">${last?`<p><span class="author-label ${color(last.author)}">${esc(displayName(last.author))}:</span> ${esc(last.text)}</p>`:'No messages yet.'}</button></article>`;
  }).join('')||'<div class="no-messages">No threads match.</div>';
  setHtml($('thread-list'),html);layout();
}
function openThread(key){
  selectedThread=key;boardLimit=dmLimit=80;messageMode='preview';$('board-search').value='';
  $('thread-dialog').hidden=false;$('thread-scrim').hidden=false;renderThreadDialog();$('close-thread').focus();
}
function closeThread(){selectedThread=null;$('thread-dialog').hidden=true;$('thread-scrim').hidden=true;document.querySelector(`[data-action="view"][data-view="threads"]`).focus();}
function renderThreadDialog(){
  const t=threadData().find(t=>t.key===selectedThread);if(!t){closeThread();return;}
  const s=data.state;dmPair=t.kind==='dm'?t.key:'';
  $('thread-title').textContent=t.title;
  setHtml($('thread-meta'),`<strong>${t.kind==='board'?'public':'direct · operator visible'}</strong> · ${t.messages.length} messages · ${t.messages.length?clock(t.messages[0].at):'no activity yet'}`);
  setHtml($('thread-budget'),`<strong>TOKEN BUDGET</strong>${budgetBar(s.tokens,s.config.maxTokens)}<span>${number(s.tokens)} reported tokens${s.config.maxTokens?' | '+compact(Math.max(0,s.config.maxTokens-s.tokens))+' left of '+compact(s.config.maxTokens):' | includes cached context'}</span>`);
  setHtml($('thread-members'),'<span>MEMBERS</span> '+t.members.map(author).join(''));
  $('board').hidden=t.kind!=='board';$('dms').hidden=t.kind!=='dm';
  document.querySelectorAll('[data-action="message-mode"]').forEach(el=>el.classList.toggle('selected',el.dataset.mode===messageMode));
  renderMessages();layout();
}
function renderTrace(){
  const messages=[...data.state.board,...data.state.dms],items=data.spans.filter(s=>s.type!=='turn'&&s.type!=='agentMessage'),start=Date.parse(data.state.createdAt);
  const end=Math.max(start+1000,...messages.map(m=>Date.parse(m.at)),...data.spans.map(s=>s.end??s.start)),range=end-start;
  const bins=Array.from({length:100},()=>({messages:0,tools:0,at:0}));
  for(const m of messages){const i=Math.max(0,Math.min(99,Math.floor((Date.parse(m.at)-start)/range*100)));bins[i].messages++;}
  for(const item of items){const i=Math.max(0,Math.min(99,Math.floor((item.start-start)/range*100)));bins[i].tools++;}
  const max=Math.max(1,...bins.map(b=>b.messages+b.tools));
  $('trace-start').textContent=clock(start);$('trace-end').textContent=clock(end);$('trace-count').innerHTML=`<strong>${number(messages.length)} messages</strong> | ${items.length?number(items.length)+' recorded tool items':'tool detail unavailable'}`;
  setHtml($('trace'),bins.map((b,i)=>`<button class="trace-bin ${b.messages?'messages':''}" data-height="${3+(b.messages+b.tools)/max*24}" data-action="view" data-view="threads" title="${clock(start+i/100*range)} · ${b.messages} messages · ${b.tools} tool items" aria-label="Activity at ${clock(start+i/100*range)}"></button>`).join(''));
}
document.addEventListener('click',event=>{
  const el=event.target.closest('[data-action]');if(!el)return;
  switch(el.dataset.action){
    case 'view':setView(el.dataset.view);break;
    case 'run':selectedRun=el.dataset.run;dmPair='';boardLimit=dmLimit=80;closeInspector();closeThread();setView('threads');refresh();break;
    case 'thread':openThread(el.dataset.thread);break;
    case 'thread-order':threadOrder=el.dataset.order;document.querySelectorAll('[data-action="thread-order"]').forEach(b=>b.classList.toggle('selected',b.dataset.order===threadOrder));renderThreads();break;
    case 'thread-filter':threadFilter=el.dataset.filter;document.querySelectorAll('[data-action="thread-filter"]').forEach(b=>b.classList.toggle('selected',b.dataset.filter===threadFilter));renderThreads();break;
    case 'message-mode':messageMode=el.dataset.mode;renderThreadDialog();break;
    case 'show-messages':boardLimit=data.state.board.length;dmLimit=data.state.dms.length;messageMode='raw';renderThreadDialog();break;
    case 'agent':openInspector(el.dataset.agent);break;
    case 'turn':openInspector(el.dataset.agent,el.dataset.turn);break;
    case 'graph-mode':graphMode=el.dataset.mode;renderGraph();break;
    case 'pair':dmPair=el.dataset.pair;renderMessages();break;
    case 'expand':expanded.has(el.dataset.key)?expanded.delete(el.dataset.key):expanded.add(el.dataset.key);renderMessages();if(selectedAgent)renderInspector();break;
    case 'more-board':boardLimit+=100;renderMessages();break;
    case 'more-dm':dmLimit+=100;renderMessages();break;
    case 'more-inspector':inspectorLimit+=100;renderInspector();break;
    case 'inspector-tab':inspectorTab=el.dataset.tab;renderInspector();break;
  }
  layout();
});
$('refresh').addEventListener('click',refresh);$('close-inspector').addEventListener('click',closeInspector);$('scrim').addEventListener('click',closeInspector);
$('close-thread').addEventListener('click',closeThread);$('thread-scrim').addEventListener('click',closeThread);
$('dm-reset').addEventListener('click',()=>{dmPair='';renderMessages();});
$('board-search').addEventListener('input',renderMessages);$('agent-search').addEventListener('input',renderAgents);
$('signal-search').addEventListener('input',()=>{renderRuns();if(data)renderThreads();});
window.addEventListener('hashchange',()=>{const view=location.hash.slice(1);if(['swarms','threads','agents'].includes(view))setView(view);});
document.addEventListener('keydown',event=>{
  if(event.key==='Escape'){if(selectedAgent)closeInspector();else if(selectedThread)closeThread();}
  if(event.key==='/'&&!event.target.matches('input,textarea')){event.preventDefault();$('signal-search').focus();}
  if(event.key==='Enter'&&event.target.matches('tr[data-action="agent"]'))openInspector(event.target.dataset.agent);
  if(event.key==='Tab'){
    const dialog=selectedAgent?$('inspector'):selectedThread?$('thread-dialog'):null;if(!dialog)return;
    const focusable=[...dialog.querySelectorAll('button,input,summary,[tabindex="0"]')].filter(el=>el.getClientRects().length);
    const first=focusable[0],last=focusable.at(-1);
    if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus();}
    else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}
  }
});
setView(currentView);refresh();setInterval(refresh,2000);
