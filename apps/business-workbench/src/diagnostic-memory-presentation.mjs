export const memoryStatus = status => ({ CANDIDATE: '待核验', SOURCE_VERIFIED: '原文已核对', USER_CONFIRMED: '已确认', CONFLICT: '存在冲突', DISABLED: '已停用', SUPERSEDED: '已有新版本' })[status] || '状态待核对';
export const memoryKind = kind => ({ METRIC_DEFINITION: '指标口径', ANALYSIS_RULE: '分析经验', DATED_FACT: '业务事实' })[kind] || '记忆';

export function memoryInjectionView(run) {
  const receipts = (run?.usage?.receipts || []).filter(receipt => receipt.memoryInjection).map(receipt => {
    const injection = receipt.memoryInjection;
    return { stage: receipt.stage, round: receipt.round, responded: injection.status === 'PROVIDER_RESPONDED', memoryIds: injection.memoryIds || [], systemPromptHash: injection.systemPromptSha256, blockHash: injection.blockSha256, block: injection.block || '' };
  });
  const injected = receipts.filter(receipt => receipt.responded && receipt.memoryIds.length);
  const selected = run?.memorySnapshot?.selected?.length || 0;
  if (injected.length) return { label: `已用于回答 · ${injected.length} 次`, description: '以下回执来自实际发出的模型请求；不代表模型已正确采用或结论已核实。', receipts };
  if (selected) return { label: '已找到，尚未收到回答', description: '已保存匹配记忆快照；只有请求发出并取得响应后，才记为已注入。', receipts };
  if (run?.memorySnapshot) return { label: '没有找到适用记忆', description: '本次未选择适用的记忆，不将空快照视为已注入。', receipts };
  return { label: '未留下记忆使用记录', description: '此任务未保存 Memory 快照及注入回执，不补写历史执行记录。', receipts };
}

export const memoryStageLabel=stage=>({'memory-test':'记忆方法试验（未查数）',route:'理解问题',rewrite:'整理查数问题',plan:'准备分析',review:'检查结果'})[stage]||'分析过程';
