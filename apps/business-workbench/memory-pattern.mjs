// One user-facing pattern shared by extraction, the reader and retrieval.
export const MEMORY_PATTERN_VERSION = 'memory-seven-sections/v1';
export const MEMORY_DIRECTIONS = Object.freeze([
 {id:'S1',label:'成本核算与优化',terms:['成本','账单','账本','计费','token','消耗','智点']},
 {id:'S2',label:'指标监控与汇报',terms:['汇报','月报','周报','活跃','DAU','频次','增长']},
 {id:'S3',label:'异常排查与口径',terms:['异常','口径','下跌','下降','漏斗','迁移','韦恩','交集']},
 {id:'OTHER',label:'其他分析经验',terms:[]},
]);
const strings=value=>Array.isArray(value)?value.filter(v=>typeof v==='string'&&v.trim()):[];
export function memoryDirection(record={}) {
 const explicit=record.direction?.id||record.directionId;
 const known=MEMORY_DIRECTIONS.find(d=>d.id===explicit);
 if(known)return known;
 // Legacy display fallback only. The extraction model supplies the direction for new records.
 const text=[record.title,record.question,record.originalQuestion].join(' ').toLowerCase();
 return MEMORY_DIRECTIONS.slice(0,3).map(d=>({d,score:d.terms.filter(t=>text.includes(t.toLowerCase())).length})).sort((a,b)=>b.score-a.score).find(x=>x.score)?.d||MEMORY_DIRECTIONS.at(-1);
}
export function memoryPattern(record={}) {
 const original=record.originalModelOutput||{},app=original.applicability||{};
 return {
  question:record.question||original.questionPattern?.typicalQuestion||record.title||'',
  steps:(record.steps||[]).filter(s=>s?.action),
  outputs:strings(record.outputs),
  useWhen:strings(record.useWhen).length?strings(record.useWhen):strings(app.useWhen).length?strings(app.useWhen):[record.question?`遇到“${record.question}”这类问题时，参考下面的分析方法。`:'同方向、相同口径的问题，可参考分析方法。'],
  doNotUseWhen:strings(record.doNotUseWhen).length?strings(record.doNotUseWhen):strings(app.doNotUseWhen).length?strings(app.doNotUseWhen):strings(record.boundaries),
  currentMaterials:[...new Set([...strings(record.currentMaterials||record.inputs),...strings(original.uncertainties)])],
  direction:memoryDirection(record),
  relation:record.relation||original.questionPattern?.relation||'SAME_DIRECTION',
  cadence:record.cadence||original.questionPattern?.cadence||'按本次问题确定',
 };
}
export function memoryDirectionCounts(records=[]) {
 return MEMORY_DIRECTIONS.map(d=>({...d,count:records.filter(r=>memoryDirection(r).id===d.id).length})).filter(d=>d.count);
}

export function readableMemoryText(value='') {
 const slots={'统计周期':'本期','业务范围':'本次业务范围','已核验来源':'已核验的数据源','模型版本':'本次模型版本','统一计费单位':'统一计费单位'};
 return String(value).replace(/\{\{([^{}]+)\}\}/g,(_all,key)=>slots[key]||key);
}
