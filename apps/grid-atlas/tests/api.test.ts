import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createLocalDatabase } from '../server/local-db.ts';
import { handleApi, type ApiEnvironment } from '../server/api.ts';
import { captureSnapshot, inventoryRevisionGuard, readInventory, readInventoryWithRevision, seedDatabase, sourceReplacementStatements } from '../server/database.ts';
import { GATES, MODEL_VERSION, type Assessment, type ImportPayload, type Project, type Source } from '../shared/types.ts';

const migration = readFileSync(new URL('../migrations/0001_initial.sql', import.meta.url), 'utf8');
const today = new Date().toISOString().slice(0,10);
const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0,10);
const source: Source = { id:'test-register',name:'Official fixture register',region:'TEST',types:['generation','storage','load'],url:'https://example.org/register',coverage:'full_register',sourceAsOf:yesterday,lastCheckedAt:yesterday,refreshCadence:'weekly',recordCount:3,gaps:['Fixture only'],adapter:'fixture' };
function project(id: string, values: Partial<Project> = {}): Project { return { id,sourceId:source.id,sourceRecordId:id,name:id,types:['generation'],region:'TEST',state:'NY',status:'active',generationMw:100,storageMw:null,loadMw:null,capacityStatus:'known',eligible:true,exclusionReason:null,sourceUrl:source.url,sourceAsOf:yesterday,rawStatus:'Active request',identityScope:'source_record',...values }; }
const projects = [project('alpha'), project('hybrid',{types:['generation','storage'],storageMw:null,capacityStatus:'partial'}), project('reference',{status:'reference',eligible:false,exclusionReason:'Aggregate reference'})];
function evidence(gate: Assessment['gate'], values: Partial<Omit<Assessment,'id'|'recordedAt'>> = {}): Omit<Assessment,'id'|'recordedAt'> { return {projectId:'alpha',gate,status:'not_started',progress:0,basis:'official',sourceUrl:'https://example.org/evidence',effectiveAt:yesterday,publishedAt:yesterday,observedAt:new Date(Date.now()-1000).toISOString(),rationale:'Official statement: not begun',modelVersion:MODEL_VERSION,...values}; }
function call(env: ApiEnvironment, path: string, payload?: unknown, options: { headers?:Record<string,string>; origin?:string; method?:string } = {}) {
  const url = (options.origin ?? 'http://127.0.0.1:5176') + path;
  const headers = new Headers(options.headers);
  if (payload !== undefined) headers.set('Content-Type','application/json');
  return handleApi(new Request(url,{method:options.method ?? (payload === undefined ? 'GET':'POST'),headers,body:payload === undefined ? undefined : JSON.stringify(payload)}),env);
}
function fixture() { const db=createLocalDatabase(':memory:');db.exec(migration);return {db,env:{DB:db,LOCAL_DEV:'1'} satisfies ApiEnvironment}; }
async function seeded() { const f=fixture(); await seedDatabase(f.db,{projects,sources:[source]});return f; }
function imported(values: Partial<ImportPayload> = {}): ImportPayload { return {sourceId:source.id,source:{...source,recordCount:3},projects,completeScope:true,retrievedAt:new Date().toISOString(),sourceSha256:'a'.repeat(64),...values}; }

test('health fails closed for uninitialized database and unauthenticated production writes',async()=>{
  const db=createLocalDatabase(':memory:');
  try {
    assert.equal((await call({DB:db},'/api/health')).status,503);
    assert.equal((await call({DB:db},'/api/bootstrap',{projects,sources:[source]})).status,401);
  }finally{db.close();}
});
test('bootstrap validates all rows, stores day precision and is once only',async()=>{
  const {db,env}=fixture();try{
    const bad=await call(env,'/api/bootstrap',{projects:[...projects,project('bad',{eligible:true,state:'AK'})],sources:[source]}); assert.equal(bad.status,400);assert.equal((await readInventory(db)).projects.length,0);
    const good=await call(env,'/api/bootstrap',{projects,sources:[source]});assert.equal(good.status,201,await good.text());
    assert.equal((await readInventory(db)).sources[0].lastCheckedAt,yesterday);
    assert.equal((await call(env,'/api/bootstrap',{projects,sources:[source]})).status,409);
    assert.equal((await seedDatabase(db,{projects:[],sources:[]})).seeded,false);
  }finally{db.close();}
});
test('shipped bootstrap is accepted by production API with bounded SQL count',async()=>{
  const {db}=fixture();let statements=0;
  const counted={prepare(sql:string){statements++;return db.prepare(sql);},batch:db.batch.bind(db)};
  try{
    const input=JSON.parse(readFileSync(new URL('../data/bootstrap.json',import.meta.url),'utf8'));
    const result=await call({DB:counted,ADMIN_TOKEN:'test-secret'},'/api/bootstrap',{projects:input.projects,sources:input.sources},{headers:{Authorization:'Bearer test-secret'},origin:'https://grid.example.org'});
    assert.equal(result.status,201,await result.text());assert.ok(statements<=50,`D1 statements ${statements} exceed free request limit`);
    assert.equal((await readInventory(db)).projects.length,input.projects.length);
  }finally{db.close();}
});
test('production auth and local cross-origin boundaries are enforced',async()=>{
  const {db,env}=await seeded();try{
    assert.equal((await (await call(env,'/api/health')).json()).canWrite,true);
    assert.equal((await call(env,'/api/snapshots',{}, {headers:{Origin:'https://evil.example'}})).status,401);
    assert.equal((await call(env,'/api/snapshots',{}, {origin:'https://grid.example.org'})).status,401);
    const prod={DB:db,ADMIN_TOKEN:'secret'};
    assert.equal((await (await call(prod,'/api/health',undefined,{origin:'https://grid.example.org'})).json()).canWrite,false);
    assert.equal((await call(prod,'/api/snapshots',{}, {origin:'https://grid.example.org',headers:{Authorization:'Bearer wrong'}})).status,401);
    assert.equal((await call(prod,'/api/snapshots',{}, {origin:'https://grid.example.org',headers:{Authorization:'Bearer secret'}})).status,201);
    const health=await (await call({...prod,SCHEDULE_ENABLED:'1',SCHEDULE_CADENCE:'monthly'},'/api/health')).json();assert.equal(health.schedule.configured,true);assert.match(health.schedule.cadence,/매월/);assert.equal(health.schedule.lastRunAt,null);
  }finally{db.close();}
});
test('unknown projects are distinct from no progress and search does not change mean scope',async()=>{
  const {db,env}=await seeded();try{
    const initial=await (await call(env,'/api/dashboard')).json();assert.equal(initial.summary.eligibleCount,2);assert.equal(initial.summary.unknownCount,2);assert.equal(initial.summary.pointMean,null);
    for(const gate of GATES){const response=await call(env,'/api/assessments',evidence(gate));assert.equal(response.status,201,await response.text());}
    let state=await (await call(env,'/api/dashboard?q=hybrid')).json();assert.equal(state.total,1);assert.equal(state.summary.pointMean,100);assert.equal(state.summary.scoredCount,1);assert.equal(state.summary.unknownCount,1);
    const update=await call(env,'/api/assessments',evidence('technical',{status:'in_progress',progress:.5,basis:'estimate',effectiveAt:today,publishedAt:today,observedAt:new Date().toISOString(),rationale:'Reviewed documented study milestone'}));assert.equal(update.status,201,await update.text());
    state=await (await call(env,'/api/dashboard?status=unknown')).json();assert.equal(state.summary.pointMean,90);assert.equal(state.summary.estimatedCount,1);assert.equal(state.total,1);assert.equal(state.projects[0].project.id,'hybrid');
    const detail=await(await call(env,'/api/projects/alpha?limit=1')).json();assert.equal(detail.score.point,90);assert.equal(detail.assessments.length,1);assert.equal(detail.totalAssessments,6);assert.equal(detail.assessmentsTruncated,true);
  }finally{db.close();}
});
test('assessment append is strict, content idempotent and immutable',async()=>{
  const {db,env}=await seeded();try{
    const input=evidence('technical');
    const a=await(await call(env,'/api/assessments',input)).json();const b=await(await call(env,'/api/assessments',input)).json();assert.equal(b.duplicate,true);assert.deepEqual(a.assessment,b.assessment);
    assert.equal((await call(env,'/api/assessments',{...input,recordedAt:'2000-01-01T00:00:00Z'})).status,400);
    assert.equal((await call(env,'/api/assessments',{...input,basis:'estimate',rationale:''})).status,400);
    assert.equal((await call(env,'/api/assessments',{...input,status:'in_progress',progress:.33,basis:'estimate'})).status,400);
    assert.equal((await call(env,'/api/assessments',{...input,effectiveAt:'2099-01-01'})).status,400);
    assert.equal((await call(env,'/api/assessments',{...input,sourceUrl:'https://name:password@example.org/evidence'})).status,400);
    assert.equal((await call(env,'/api/assessments',{...input,projectId:'reference'})).status,400);
    await assert.rejects(db.prepare('UPDATE assessments SET recorded_at=? WHERE id=?').bind('2000-01-01T00:00:00Z',a.assessment.id).run(),/immutable/);
    await assert.rejects(db.prepare('DELETE FROM assessments WHERE id=?').bind(a.assessment.id).run(),/immutable/);
  }finally{db.close();}
});
test('no baseline fallback; snapshots cannot backdate; knownAt prevents retrospective evidence leakage',async()=>{
  const {db,env}=await seeded();try{
    const past=await(await call(env,'/api/dashboard?asOf=2000-01-01')).json();assert.equal(past.available,false);assert.equal(past.projects.length,0);assert.equal(past.snapshot,null);
    assert.equal((await call(env,'/api/snapshots',{capturedAt:'2000-01-01T00:00:00Z'})).status,400);
    const old=await(await call(env,'/api/dashboard')).json();
    const knownAt=new Date().toISOString();await new Promise(resolve=>setTimeout(resolve,2));
    for(const gate of GATES) await call(env,'/api/assessments',evidence(gate));
    const now=await(await call(env,'/api/dashboard')).json();assert.equal(now.summary.pointMean,100);
    const then=await(await call(env,'/api/dashboard?knownAt='+encodeURIComponent(knownAt))).json();assert.equal(then.summary.pointMean,null);
    const snap=await captureSnapshot(db);assert.notEqual(snap.snapshot.id,old.snapshot.id);assert.equal((await captureSnapshot(db)).duplicate,true);
    const history=await(await call(env,'/api/dashboard?historyLimit=1')).json();assert.equal(history.history.length,1);assert.equal(history.historyTruncated,true);
    await assert.rejects(db.prepare('DELETE FROM snapshots WHERE id=?').bind(snap.snapshot.id).run(),/immutable/);
  }finally{db.close();}
});
test('imports reject empty wipes, false scope, conflict IDs and duplicate canonical identities',async()=>{
  const {db,env}=await seeded();try{
    for(const bad of [imported({projects:[]}),imported({completeScope:false as true}),imported({sourceSha256:'invalid'}),imported({projects:[project('a',{sourceId:'other'})]}),imported({projects:[project('alpha'),project('alias',{sourceRecordId:'alpha'})],source:{...source,recordCount:2}})]) assert.equal((await call(env,'/api/import',bad)).status,400);
    const otherSource={...source,id:'other',recordCount:1};
    assert.equal((await call(env,'/api/import',imported({sourceId:'other',source:otherSource,projects:[project('alpha',{sourceId:'other'})]}))).status,409);
    assert.equal((await readInventory(db)).projects.length,3);
  }finally{db.close();}
});
test('imports validate capacity, mainland eligibility and source scope before writes',async()=>{
  const {db,env}=await seeded();try{
    for(const badProject of [project('x',{generationMw:null,capacityStatus:'known'}),project('x',{storageMw:100}),project('x',{state:'AK'}),project('x',{status:'reference'}),project('x',{generationMw:-1}),project('x',{sourceAsOf:'2099-01'})]){
      const response=await call(env,'/api/import',imported({projects:[badProject],source:{...source,recordCount:1}}));assert.equal(response.status,400);
    }
    assert.equal((await call(env,'/api/import',imported({source:{...source,coverage:'aggregate'}}))).status,400);
    assert.equal((await readInventory(db)).projects.length,3);
  }finally{db.close();}
});
test('imports reject future source cutoffs, dates after acquisition and identity reassignment',async()=>{
  const {db,env}=await seeded();try{
    assert.equal((await call(env,'/api/import',imported({source:{...source,sourceAsOf:'2099-01-01'}}))).status,400);
    assert.equal((await call(env,'/api/import',imported({retrievedAt:'2000-01-01T00:00:00Z'}))).status,400);
    assert.equal((await call(env,'/api/import',imported({source:{...source,recordCount:1},projects:[project('alpha',{sourceRecordId:'different-request'})]}))).status,409);
    assert.equal((await call(env,'/api/import',imported({source:{...source,recordCount:1},projects:[project('different-id',{sourceRecordId:'alpha'})]}))).status,409);
    assert.equal((await readInventory(db)).projects.length,3);
  }finally{db.close();}
});
test('atomic source replacement rolls back on failure and archived sources stay immutable',async()=>{
  const {db,env}=await seeded();try{
    const before=await(await call(env,'/api/dashboard')).json();
    db.exec("CREATE TRIGGER reject_bad BEFORE INSERT ON inventory_chunks WHEN NEW.payload LIKE '%reject-me%' BEGIN SELECT RAISE(ABORT,'test failure'); END;");
    assert.equal((await call(env,'/api/import',imported({projects:[project('reject-me')],source:{...source,recordCount:1}}))).status,503);
    assert.equal((await readInventory(db)).projects.length,3);
    const accepted=await call(env,'/api/import',imported({projects:[project('replacement')],source:{...source,name:'Updated registry',recordCount:1}}));assert.equal(accepted.status,200,await accepted.text());
    assert.equal((await readInventory(db)).projects[0].id,'replacement');
    const pending=await(await call(env,'/api/dashboard')).json();assert.equal(pending.snapshot.id,before.snapshot.id);assert.equal(pending.sources[0].name,source.name);
    await call(env,'/api/snapshots',{});const updated=await(await call(env,'/api/dashboard')).json();assert.equal(updated.sources[0].name,'Updated registry');assert.equal(updated.total,1);assert.equal(updated.history[0].snapshot.id,before.snapshot.id);
    const raw=await db.prepare('SELECT payload FROM snapshot_chunks WHERE snapshot_id=?').bind(updated.snapshot.id).all<{payload:string}>();
    const provenance=raw.results.flatMap(r=>JSON.parse(r.payload)).find(r=>r.kind==='source_import');assert.equal(provenance.value.sourceSha256,'a'.repeat(64));assert.equal(provenance.value.timeBasis,'retrieved');
  }finally{db.close();}
});
test('optimistic revision guard rejects stale source writes atomically',async()=>{
  const {db}=await seeded();try{
    const {revision}=await readInventoryWithRevision(db);
    await db.batch([inventoryRevisionGuard(db,revision),...sourceReplacementStatements(db,{...source,recordCount:1},[project('first')],new Date().toISOString(),'a'.repeat(64))]);
    await assert.rejects(db.batch([inventoryRevisionGuard(db,revision),...sourceReplacementStatements(db,{...source,recordCount:1},[project('stale')],new Date().toISOString(),'b'.repeat(64))]));
    assert.equal((await readInventory(db)).projects[0].id,'first');
  }finally{db.close();}
});
test('CSV follows list filters, protects spreadsheet formulas and preserves unknown blank values',async()=>{
  const {db}=fixture();const env={DB:db,LOCAL_DEV:'1'};try{
    await seedDatabase(db,{sources:[{...source,recordCount:1}],projects:[project('formula',{name:'=CMD()',generationMw:null,capacityStatus:'unknown'})]});
    const csv=await call(env,'/api/export?q=formula');assert.equal(csv.status,200);assert.match(csv.headers.get('Content-Type')!,/text\/csv/);assert.match(await csv.text(),/"'=CMD\(\)"/);
    assert.equal((await call(env,'/api/export?asOf=2000-01-01')).status,404);
    assert.equal((await call(env,'/api/dashboard?pageSize=101')).status,400);assert.equal((await call(env,'/api/dashboard?knownAt=2024-02-30T00%3A00%3A00Z')).status,400);
  }finally{db.close();}
});
test('collection runs preserve status history and completed entries cannot be overwritten',async()=>{
  const {db,env}=await seeded();try{
    const startedAt=new Date(Date.now()-1000).toISOString();const run={id:'run-test',startedAt,finishedAt:null,status:'running',details:'Acquisition started'};
    assert.equal((await call(env,'/api/runs',run)).status,201);
    assert.equal((await call(env,'/api/runs',{...run,finishedAt:new Date().toISOString(),status:'partial',details:'One source needs review'})).status,201);
    assert.equal((await call(env,'/api/runs',{...run,finishedAt:new Date().toISOString(),status:'success'})).status,409);
    const list=await(await call(env,'/api/runs?limit=1')).json();assert.equal(list.runs[0].status,'partial');assert.equal(list.truncated,false);
    assert.equal((await(await call(env,'/api/health')).json()).schedule.lastRunStatus,'partial');
  }finally{db.close();}
});

test('KST midnight permits current-day input and previous-day queries exclude the next-day snapshot',async t=>{
  const {db,env}=fixture();
  t.mock.timers.enable({apis:['Date'],now:Date.parse('2026-10-08T14:59:59.999Z')});
  try{
    const initial=await seedDatabase(db,{projects,sources:[source]});
    assert.equal(initial.snapshot!.capturedAt,'2026-10-08T14:59:59.999Z');
    t.mock.timers.setTime(Date.parse('2026-10-08T15:00:00.000Z'));
    for(const gate of GATES){
      const response=await call(env,'/api/assessments',evidence(gate,{effectiveAt:'2026-10-09',publishedAt:'2026-10-09',observedAt:'2026-10-08T15:00:00.000Z'}));
      assert.equal(response.status,201,await response.text());
    }
    const current=await captureSnapshot(db);
    const previousDay=await(await call(env,'/api/dashboard?asOf=2026-10-08')).json();
    assert.equal(previousDay.snapshot.id,initial.snapshot!.id);
    assert.equal(previousDay.summary.pointMean,null);
    assert.ok(previousDay.history.every((point:{snapshot:{id:string}})=>point.snapshot.id!==current.snapshot.id));
    const sameDayResponse=await call(env,'/api/dashboard?asOf=2026-10-09');
    assert.equal(sameDayResponse.status,200);
    const sameDay=await sameDayResponse.json();assert.equal(sameDay.snapshot.id,current.snapshot.id);assert.equal(sameDay.summary.pointMean,100);
    assert.equal(sameDay.history.at(-1).summary.pointMean,100);
    assert.equal((await(await call(env,'/api/dashboard')).json()).summary.pointMean,100);
    const earlierKnowledge=await(await call(env,'/api/dashboard?asOf=2026-10-09&knownAt=2026-10-08T14%3A59%3A59.999Z')).json();
    assert.equal(earlierKnowledge.snapshot.id,initial.snapshot!.id);assert.equal(earlierKnowledge.summary.pointMean,null);
    assert.equal((await call(env,'/api/dashboard?asOf=2026-10-10')).status,400);
    const detail=await(await call(env,'/api/projects/alpha?asOf=2026-10-08')).json();assert.equal(detail.snapshot.id,initial.snapshot!.id);assert.equal(detail.totalAssessments,0);
    const csv=await(await call(env,'/api/export?asOf=2026-10-08')).text();assert.ok(csv.includes(`"${initial.snapshot!.capturedAt}","2026-10-08"`));assert.ok(!csv.includes(`"${current.snapshot.capturedAt}","2026-10-08"`));
  }finally{t.mock.timers.reset();db.close();}
});

test('source date-only chronology uses the KST acquisition day without rewriting original dates',async t=>{
  const {db,env}=fixture();
  t.mock.timers.enable({apis:['Date'],now:Date.parse('2026-10-08T15:00:00.000Z')});
  try{
    const currentProjects=projects.map(p=>({...p,sourceAsOf:'2026-10-09'}));
    const currentSource={...source,sourceAsOf:'2026-10-09',lastCheckedAt:'2026-10-09'};
    const payload=imported({source:currentSource,projects:currentProjects,retrievedAt:'2026-10-08T15:00:00.000Z'});
    const accepted=await call(env,'/api/import',payload);assert.equal(accepted.status,200,await accepted.text());
    const stored=await readInventory(db);assert.equal(stored.sources[0].sourceAsOf,'2026-10-09');assert.equal(stored.sources[0].lastCheckedAt,'2026-10-09');assert.equal(stored.projects[0].sourceAsOf,'2026-10-09');
    assert.equal((await call(env,'/api/import',{...payload,retrievedAt:'2026-10-08T14:59:59.999Z'})).status,400);
    assert.equal((await call(env,'/api/import',{...payload,source:{...currentSource,lastCheckedAt:'2026-10-08T15:00:00.001Z'}})).status,400);
    assert.equal((await call(env,'/api/import',{...payload,source:{...currentSource,sourceAsOf:'2026-10-10'}})).status,400);
  }finally{t.mock.timers.reset();db.close();}
});
