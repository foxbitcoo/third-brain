const sections = markdown => {
  const body = typeof markdown === 'string' ? markdown.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '') : '';
  const [intro,...rest]=body.split(/^## /m);
  const introduction=intro.split('\n').map(line=>line.trim()).filter(line=>line && !line.startsWith('# '));
  return [...(introduction.length ? [{title:'说明',lines:introduction}] : []),...rest.map(part => {
    const [title, ...lines] = part.split('\n');
    return { title:title.trim(), lines:lines.map(line=>line.trim()).filter(Boolean) };
  })];
};

export function diagnosticGuideDocument(agent) {
  const groups=sections(agent?.skill?.markdown);
  const version=typeof agent?.skill?.version==='string' ? agent.skill.version : null;
  if(!version || !groups.length) return null;
  return { title:agent.skill.title || '业务数据诊断', version, sections:groups };
}

export function loopNodeDocument(agent, id) {
  const doc=diagnosticGuideDocument(agent);
  if(!doc)return null;
  const loop=doc.sections.find(s=>s.title==='循环');
  const step=n=>loop?.lines.find(line=>line.startsWith(`${n}. `))?.replace(/^\d+\. /,'');
  const paragraph=title=>doc.sections.find(s=>s.title===title)?.lines || [];
  const steps=(...numbers)=>numbers.map(step).filter(Boolean);
  const mappings={
    routing:{title:'模型分流与 Query 改写',groups:[{title:'唯一口径与条件判断',lines:paragraph('模型分流与 Query 改写')}],source:'模型分流与 Query 改写'},
    simple:{title:'单次查数规范',groups:[{title:'单次查询条件',lines:paragraph('模型分流与 Query 改写').filter(line=>line.includes('单次查数'))},{title:'真实执行与复核',lines:steps(3,8)}],source:'模型分流与 Query 改写 / 循环 · 第3、8项'},
    resolve:{title:'问题与指标口径',groups:[{title:'核对范围',lines:steps(1)}],source:'循环 · 第1项'},
    plan:{title:'查数方案规范',groups:[{title:'查询规划',lines:steps(2)},{title:'继续条件',lines:agent?.loop?.continuation ? [agent.loop.continuation] : []}],source:'循环 · 第2项'},
    query:{title:'只读取数规范',groups:[{title:'执行与回执',lines:steps(3)},{title:'工具与职责',lines:paragraph('工具与职责')}],source:'循环 · 第3项 / 工具与职责'},
    review:{title:'结果核查规范',groups:[
      {title:'程序校验',lines:(agent.evaluation || []).filter(item=>item.kind==='programmatic').map(item=>({execution:'查询回执与结果范围',citations:'引用与数据来源',numbers:'分子、分母及数值'}[item.id] || item.title))},
      {title:'分析判断',lines:agent.evaluation?.some(item=>item.id==='answer') ? ['是否回答原问题','继续下钻或请求补充'] : []},
    ],source:'循环 · 第4—6项 / 边界与评估',caveat:(agent.evaluation || []).find(item=>item.id==='answer')?.description,focusSteps:[4,5,6]},
    decision:{title:'继续与停止规范',groups:[{title:'是否回答原问题',lines:steps(8)},{title:'停止条件',lines:agent?.loop?.stopping || []}],source:'循环 · 第8项 / 边界与评估'},
    report:{title:'待审报告规范',groups:[{title:'报告内容',lines:steps(7)},{title:'结论边界',lines:paragraph('边界与评估').slice(-1)}],source:'循环 · 第7项 / 边界与评估'},
    human:{title:'人工补充规范',groups:[{title:'补充与继续',lines:steps(8)},{title:'资料与权限',lines:paragraph('资料与权限')}],source:'循环 · 第8项 / 资料与权限'},
  };
  const node=mappings[id];
  if(!node || !node.groups.some(group=>group.lines.length))return null;
  return {...node,version:doc.version,documentTitle:doc.title};
}

export function fullDocumentFocus(id, sectionTitle, line) {
  const step=typeof line==='string' ? Number(line.match(/^(\d+)\. /)?.[1]) : null;
  const steps={resolve:[1],plan:[2],query:[3],review:[4,5,6],decision:[8],report:[7],human:[8]};
  if(['routing','simple'].includes(id)&&sectionTitle==='模型分流与 Query 改写')return id==='routing'||line.includes('单次查数');
  return sectionTitle==='循环' && (steps[id] || []).includes(step);
}
