import React, { useId } from 'react';
import { IconFile } from '@douyinfe/semi-icons';
import { agentLoopSize, agentLoopNodes, agentLoopRoutes, agentLoopLabels } from './agent-loop-geometry.mjs';
import './agent-loop.css';

const position = node => ({ left: `${node.x / agentLoopSize.width * 100}%`, top: `${node.y / agentLoopSize.height * 100}%`, width: `${node.width / agentLoopSize.width * 100}%`, height: `${node.height / agentLoopSize.height * 100}%` });
const boundedLimit = value => Number.isSafeInteger(value) && value > 0 ? value : null;

export default function AgentLoopDiagram({ selected = 'review', onSelect, limits = {} }) {
  const markerId = useId().replace(/:/g, '');
  const rounds = boundedLimit(limits.maxRounds ?? limits.rounds);
  const queries = boundedLimit(limits.maxQueries ?? limits.queries);
  return <section className="agent-loop-diagram" aria-label="业务数据诊断流程">
    <div className="agent-loop-scroll" tabIndex={0} aria-label="分析流程图，窄屏可横向滚动">
      <div className="agent-loop-canvas">
        <svg className="agent-loop-lines" viewBox={`0 0 ${agentLoopSize.width} ${agentLoopSize.height}`} aria-hidden="true" focusable="false">
          <defs>{['neutral', 'primary', 'human', 'return'].map(tone => <marker key={tone} id={`${markerId}-${tone}`} viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" className={`agent-loop-arrow agent-loop-arrow-${tone}`} /></marker>)}</defs>
          {agentLoopRoutes.map(route => <polyline key={route.id} data-route={route.id} points={route.points.map(point => point.join(',')).join(' ')} className={`agent-loop-route agent-loop-route-${route.tone}`} markerEnd={`url(#${markerId}-${route.tone})`} />)}
          {agentLoopLabels.map(label => <text key={label.route} x={label.x} y={label.y} textAnchor={label.anchor || 'start'} className={`agent-loop-label agent-loop-label-${label.tone}`}><tspan x={label.x}>{label.text}</tspan>{label.secondLine && <tspan x={label.x} dy="26" className="agent-loop-label-secondary">{label.secondLine}</tspan>}</text>)}
          {agentLoopNodes.filter(node=>node.shape==='diamond').map(node=><polygon key={node.id} points={`${node.x+node.width/2},${node.y} ${node.x+node.width},${node.y+node.height/2} ${node.x+node.width/2},${node.y+node.height} ${node.x},${node.y+node.height/2}`} className={`agent-loop-diamond${selected===node.id?' agent-loop-diamond-selected':''}`} />)}
        </svg>
        <span className="agent-loop-start">人工发起</span>
        {agentLoopNodes.map(node => <button key={node.id} type="button" data-node={node.id} className={`agent-loop-node${node.shape === 'diamond' ? ' agent-loop-node-decision' : ''}${selected === node.id ? ' agent-loop-node-selected' : ''}`} style={position(node)} aria-pressed={selected === node.id} aria-label={`${node.title}，查看对应文档`} onClick={() => onSelect?.(node.id)}>
          {node.shape === 'diamond' ? <><strong>{node.title}</strong><span className="agent-loop-decision-detail">{node.detail}</span></> : <>
            <div className="agent-loop-node-body"><IconFile className="agent-loop-node-icon" aria-hidden="true" /><strong>{node.title}</strong></div>
            <span className="agent-loop-node-detail">{node.detail}</span>
            <span className="agent-loop-node-link">查看文档 ↗</span>
          </>}
        </button>)}
      </div>
    </div>
    <p className="agent-loop-limits">{rounds && queries ? `最多 ${rounds} 轮 · 最多 ${queries} 次查数` : '分析轮次与查数额度以当前任务限制为准'}<span>达到限制、执行异常或权限变化时停止</span></p>
  </section>;
}
