import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile, symlink } from "node:fs/promises";
import { join } from "node:path";
import { get } from "node:http";
import { buildSpans, discoverRuns, readDashboard, startDashboard } from "../src/dashboard.js";
import { fixture } from "./helpers.js";
import type { TelemetryEvent } from "../src/types.js";

test("dashboard distinguishes historical dispatches from native turns and attributes token deltas", async () => {
  const {store, cleanup} = await fixture(1);
  try {
    const at = (n: number) => new Date(1000+n).toISOString();
    store.state.createdAt=at(0); store.state.status="paused";
    const spans=buildSpans(store.state,[
      {at:at(0),type:"worker",actor:"worker-0001",message:"Working"},
      {at:at(100),type:"pause",message:"Runtime limit"},
      {at:at(200),type:"worker",actor:"worker-0001",message:"Working"},
      {at:at(300),type:"pause",message:"Paused"},
    ],[
      {at:at(200),actor:"worker-0001",kind:"turn-start",turnId:"t2"},
      {at:at(210),actor:"worker-0001",kind:"usage",turnId:"t2",tokens:12},
      {at:at(220),actor:"worker-0001",kind:"item-start",turnId:"t2",itemId:"cmd",itemType:"commandExecution",detail:"node --check index.js"},
      {at:at(250),actor:"worker-0001",kind:"item-end",turnId:"t2",itemId:"cmd",itemType:"commandExecution",status:"completed"},
      {at:at(290),actor:"worker-0001",kind:"usage",turnId:"t2",tokens:3},
      {at:at(300),actor:"worker-0001",kind:"turn-end",turnId:"t2",status:"interrupted"},
    ]);
    const turns=spans.filter(s=>s.type==="turn"); assert.equal(turns.length,2);
    assert.equal(turns[0]!.inferred,true); assert.equal(turns[0]!.tokens,undefined); assert.equal(turns[0]!.end,1100);
    assert.equal(turns[1]!.tokens,15); assert.equal(turns[1]!.end,1300); assert.equal(turns[1]!.status,"interrupted");
    const item=spans.find(s=>s.type==="commandExecution")!;assert.equal(item.parent,turns[1]!.id);assert.equal(item.end!-item.start,30);assert.equal(item.detail,"node --check index.js");
  }finally{await cleanup();}
});

test("dashboard exposes all operator DMs and helper usage without modifying state",async()=>{
  const {store,directory,cleanup}=await fixture(2);
  try{
    store.state.tokens=45;store.state.workers[0]!.accountedTokens=20;store.state.workers[1]!.accountedTokens=10;
    store.state.children.push({id:"worker-0001/sub-1",parent:"worker-0001",task:"Test",status:"completed",accountedTokens:5});
    store.dm("worker-0001","worker-0002","Private coordination");store.post("worker-0002","<script>alert(1)</script>");
    const event:TelemetryEvent={at:new Date().toISOString(),actor:"worker-0001",kind:"turn-start",turnId:"t1"};store.telemetry(event);
    const view=await readDashboard(directory);assert.equal(view.state.dms.length,1);assert.equal(view.agents.length,3);assert.equal(view.unattributedTokens,10);assert.equal(view.agents[0]!.turns,1);assert.equal(view.precise,true);assert.equal(store.state.status,"ready");

    assert.equal((await discoverRuns(directory)).size,1);
  }finally{await cleanup();}
});

test("GUI serves scoped read-only run data and rejects hostile origins, traversal, and symlink discovery",async()=>{
  const {store,directory,cleanup}=await fixture(1);let dashboard;
  try{
    const root=join(directory,"groups");await mkdir(join(root,"bench"),{recursive:true});
    const run=join(root,"bench","saved");await mkdir(run);await writeFile(join(run,"state.json"),JSON.stringify(store.state));
    await symlink(directory,join(root,"external"));
    dashboard=await startDashboard({stateDir:root,port:0});
    const runs=await fetch(dashboard.url+"/api/runs").then(r=>r.json()) as any[];assert.equal(runs.length,1);assert.equal(runs[0].key,"bench/saved");
    const response=await fetch(dashboard.url+"/api/run?run=bench%2Fsaved");assert.equal(response.status,200);assert.match(response.headers.get("Content-Security-Policy")!,/frame-ancestors 'none'/);
    assert.equal((await response.json() as any).state.id,"test-run");
    assert.equal((await fetch(dashboard.url+"/api/run?run=..%2F..%2F")).status,404);
    assert.equal((await fetch(dashboard.url+"/api/run?run=bench%2Fsaved",{method:"POST"})).status,405);
    assert.equal((await fetch(dashboard.url+"/api/runs",{headers:{Origin:"https://untrusted.test"}})).status,403);
    const hostStatus = await new Promise<number|undefined>((resolve,reject)=>{ get(dashboard!.url+"/api/runs",{headers:{Host:"untrusted.test"}},response=>{response.resume();resolve(response.statusCode);}).on("error",reject); });
    assert.equal(hostStatus,403);
  }finally{if(dashboard)await new Promise<void>(resolve=>dashboard.server.close(()=>resolve()));await cleanup();}
});
