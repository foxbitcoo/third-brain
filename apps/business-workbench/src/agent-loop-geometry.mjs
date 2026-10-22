// Separate ports and outer lanes keep routing, query loops and human returns apart.
export const agentLoopSize = { width: 1100, height: 1050 };
export const agentLoopNodes = [
  { id:'resolve',x:20,y:70,width:250,height:140,title:'明确问题与原图',detail:'引用原话 · 看板 · 日期 · 指标' },
  { id:'routing',x:430,y:70,width:200,height:140,title:'唯一明确数值？',detail:'模型分流与 Query 改写',shape:'diamond' },
  { id:'simple',x:20,y:330,width:250,height:140,title:'单次查数方案',detail:'口径与条件完备 · 一次核算' },
  { id:'plan',x:790,y:70,width:250,height:140,title:'多轮分析方案',detail:'归因假设 · 已授权下钻路径' },
  { id:'query',x:790,y:330,width:250,height:140,title:'德普只读取数',detail:'发送改写 Query · 取得真实回执' },
  { id:'review',x:790,y:590,width:250,height:140,title:'核查结果',detail:'总体与分组 · 数值 · 原问覆盖' },
  { id:'decision',x:430,y:600,width:200,height:120,title:'能否回答原问题？',detail:'继续与停止条件',shape:'diamond' },
  { id:'report',x:20,y:590,width:250,height:140,title:'待审报告',detail:'结论 · 依据 · 未确认事项' },
  { id:'human',x:400,y:850,width:260,height:140,title:'人工补充',detail:'补充口径 · 对齐原图 · 业务事实' },
];
export const agentLoopRoutes = [
  {id:'resolve-routing',from:'resolve',to:'routing',tone:'neutral',points:[[270,140],[426,140]]},
  {id:'routing-plan',from:'routing',to:'plan',tone:'neutral',points:[[630,140],[786,140]]},
  {id:'routing-simple',from:'routing',to:'simple',tone:'primary',points:[[530,210],[530,270],[145,270],[145,326]]},
  {id:'simple-query',from:'simple',to:'query',tone:'primary',points:[[270,400],[786,400]]},
  {id:'plan-query',from:'plan',to:'query',tone:'neutral',points:[[915,210],[915,326]]},
  {id:'query-review',from:'query',to:'review',tone:'neutral',points:[[915,470],[915,586]]},
  {id:'review-decision',from:'review',to:'decision',tone:'primary',points:[[790,660],[634,660]]},
  {id:'decision-report',from:'decision',to:'report',tone:'primary',points:[[430,660],[274,660]]},
  {id:'decision-query',from:'decision',to:'query',tone:'primary',points:[[530,600],[530,510],[720,510],[720,440],[786,440]]},
  {id:'decision-human',from:'decision',to:'human',tone:'human',points:[[530,720],[530,846]]},
  {id:'routing-human',from:'routing',to:'human',tone:'human',points:[[530,70],[530,20],[5,20],[5,920],[396,920]]},
  {id:'human-routing',from:'human',to:'routing',tone:'return',points:[[660,920],[1080,920],[1080,44],[580,44],[580,101]]},
];
export const agentLoopLabels = [
  {route:'routing-plan',x:710,y:120,text:'归因／多维',tone:'return',anchor:'middle'},
  {route:'routing-simple',x:250,y:250,text:'明确数值答案',tone:'primary'},
  {route:'routing-human',x:28,y:810,text:'必要条件缺失',tone:'human'},
  {route:'decision-report',x:350,y:640,text:'可以回答',tone:'primary',anchor:'middle'},
  {route:'decision-query',x:550,y:555,text:'仍需下钻',secondLine:'重写 Query 后继续',tone:'primary'},
  {route:'decision-human',x:550,y:790,text:'缺口径或业务事实',tone:'human'},
  {route:'human-routing',x:860,y:946,text:'补充后重新分流',tone:'return',anchor:'middle'},
];
