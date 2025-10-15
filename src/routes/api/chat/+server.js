import { json } from '@sveltejs/kit';
import { RouterOrchestrator } from '$lib/orchestrators/RouterOrchestrator.js';
import { SynthesizerOrchestrator } from '$lib/orchestrators/SynthesizerOrchestrator.js';

const ACTIVE_ORCHESTRATOR = 'synth'; // switch to 'router' when you want direct routing

/**

 */
export async function POST({ request }) {
  const body = await request.json();
  const { history } = body || {};

  if (!Array.isArray(history)) {
    return json({ error: 'history array is required' }, { status: 400 });
  }

  const parseTimestamp = (value) => {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string') {
      const ts = Date.parse(value);
      return Number.isNaN(ts) ? null : ts;
    }
    return null;
  };

  const historyWithTiming = history.map((msg, idx) => {
    const sentAtMs = parseTimestamp(msg.sentAt);
    const prevSentAt = idx > 0 ? parseTimestamp(history[idx - 1]?.sentAt) : null;
    const lagFromPreviousSec =
      sentAtMs !== null && prevSentAt !== null
        ? Math.max(0, Math.round((sentAtMs - prevSentAt) / 1000))
        : null;
    return { ...msg, sentAtMs, lagFromPreviousSec };
  });

  const firstTimestamp = historyWithTiming.find((m) => typeof m.sentAtMs === 'number')?.sentAtMs ?? null;
  const lastTimestamp =
    [...historyWithTiming].reverse().find((m) => typeof m.sentAtMs === 'number')?.sentAtMs ?? null;

  const conversationMinutes =
    firstTimestamp !== null && lastTimestamp !== null
      ? Number(((lastTimestamp - firstTimestamp) / 60000).toFixed(1))
      : null;

  const toAverage = (nums) => {
    if (!nums.length) return null;
    const avg = nums.reduce((sum, n) => sum + n, 0) / nums.length;
    return Number(avg.toFixed(1));
  };

  const userLags = historyWithTiming
    .filter((m) => m.role === 'user' && typeof m.lagFromPreviousSec === 'number')
    .map((m) => m.lagFromPreviousSec);
  const assistantLags = historyWithTiming
    .filter((m) => m.role !== 'user' && typeof m.lagFromPreviousSec === 'number')
    .map((m) => m.lagFromPreviousSec);

  const latestUserLagSec =
    [...historyWithTiming]
      .reverse()
      .find((m) => m.role === 'user' && typeof m.lagFromPreviousSec === 'number')
      ?.lagFromPreviousSec ?? null;

  const orchestrationContext = {
    totalTurns: history.length,
    timing: {
      conversationMinutes,
      latestUserLagSec,
      averageUserLagSec: toAverage(userLags),
      averageAssistantLagSec: toAverage(assistantLags)
    },
    history: historyWithTiming
  };

  try {
    const orchestrator =
      ACTIVE_ORCHESTRATOR === 'router' ? new RouterOrchestrator() : new SynthesizerOrchestrator();
    const contents = history.map((m) => ({
      role: m.role === 'user' ? 'user' : 'model',
      parts: [{ text: m.content }]
    }));
    
    const { assistantMessage, frameSet, agent, reasons } = await orchestrator.orchestrate(
      contents,
      orchestrationContext
    );
    console.log({ agent, reasons, assistantMessage });
    return json({
      assistantMessage,
      replierInput: {
        frameSet,
        contextCount: history.length,
        agent,
        reasons,
        timing: orchestrationContext.timing
      }
    });
  } catch (err) {
    const msg = String(err?.message || err || '').toLowerCase();
    if (msg.includes('gemini_api_key') || msg.includes('gemini') || msg.includes('api key')) {
      return json({ error: 'Gemini API key not found' }, { status: 400 });
    }
    return json({ error: 'Pipeline error', details: String(err?.message || err) }, { status: 500 });
  }
}
