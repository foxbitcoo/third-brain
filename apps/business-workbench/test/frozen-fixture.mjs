// Minimal contract scaffolding for tests only. No office narrative, sample
// project, personal profile or runnable demo dataset is bundled with the app.
const at='2026-09-04T18:00:00+08:00';
const ids=['neutral-knowledge','neutral-onboarding','neutral-service','neutral-archive'];
export default {
 schema_version:'business-qa-v1',dataset_id:'contract-fixture-v1',as_of:at,
 cases:ids.map((id,index)=>{
  const evidence=Array.from({length:index===0?4:2},(_,n)=>({id:`${id}-E00${n+1}`,source_type:['im','document','transcript','document'][n],source_title:`来源 ${n+1}`,occurred_at:at,speaker:'测试成员',text:`证据占位 ${n+1}`,locator:`记录 ${n+1}`,url:`https://example.invalid/record/${n+1}`}));
  return {id,title:`测试条目 ${index+1}`,question:'测试问题',scope:'测试范围',as_of:at,evidence,
   runs:Array.from({length:index===0?3:2},(_,n)=>({id:`${id}-run-${n}`,route:['A','B','C'][n],model:`test-model-${n}`,provider:'synthetic-test',status:'NOT_RUN',
    answer:{summary:'结论占位',developments:[{text:'事实占位',evidence_ids:[evidence[0].id]}],viewpoints:[],decisions:[],open_questions:[],next_steps:[]},
    metrics:{latency_ms:null,input_tokens:null,output_tokens:null,cost_cny:null},audit:{citations:'not_checked',review_status:'PENDING_USER'}}))};
 })
};
