import { Agent } from '@mastra/core/agent';
import { getLlmProvider } from '../../llm';
import { ASO_AUDIT_SKILL } from '../skills/aso-audit';

/**
 * The ASO Auditor agent.
 *
 * Its instructions *are* the `aso-audit` skill document — judgement lives in
 * that file, not in code. It is deliberately tool-free: the workflow has
 * already gathered every input by the time the agent runs, so the agent's
 * one job is to turn that data into a scored, structured `AuditDraft`. Keeping
 * it tool-free also means it runs on any model, including local ones (e.g.
 * Ollama's Gemma) that don't support function calling.
 */
export const asoAuditor = new Agent({
  id: 'aso-auditor',
  name: 'ASO Auditor',
  instructions: ASO_AUDIT_SKILL,
  model: getLlmProvider().model(),
});
