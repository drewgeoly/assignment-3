import { geminiGenerate } from '../gemini.js';
import { ConfidantAgent } from '../agents/ConfidantAgent.js';
import { MirrorAgent } from '../agents/MirrorAgent.js';
import { RoasterAgent } from '../agents/RoasterAgent.js';

const SELECTION_SCHEMA = {
  type: 'OBJECT',
  properties: {
    agent: { type: 'STRING' },
    reasons: { type: 'STRING' }
  },
  required: ['agent']
};

export class RouterOrchestrator {
  constructor() {
    this.name = 'router_confidant_mirror_roaster';
    this.agentByName = {
      confidant: new ConfidantAgent(),
      mirror: new MirrorAgent(),
      roaster: new RoasterAgent(),
    };
  }

  async _respondWith(agentName, contents, note = '') {
    const agent = this.agentByName[agentName] || this.agentByName.mirror;
    const augmentedContents = note
      ? [...contents, { role: 'model', parts: [{ text: note }] }]
      : contents;
    const res = await agent.respond(augmentedContents);
    return res?.text || '';
  }

  _summarizeContext(context = {}) {
    const { timing = {}, totalTurns } = context || {};
    const pieces = [];
    if (typeof totalTurns === 'number') pieces.push(`Turns so far: ${totalTurns}`);
    if (typeof timing.conversationMinutes === 'number') {
      pieces.push(`Conversation duration: ${timing.conversationMinutes} minutes`);
    }
    if (typeof timing.latestUserLagSec === 'number') {
      pieces.push(`Latest user lag: ${timing.latestUserLagSec} seconds`);
    }
    if (typeof timing.averageUserLagSec === 'number') {
      pieces.push(`Avg user response: ${timing.averageUserLagSec} seconds`);
    }
    if (typeof timing.averageAssistantLagSec === 'number') {
      pieces.push(`Avg assistant cadence: ${timing.averageAssistantLagSec} seconds`);
    }
    if (!pieces.length) return '- No telemetry captured yet.';
    return pieces.map((line) => `- ${line}`).join('\n');
  }

  _buildPersonaBriefing(agentName, context = {}) {
    const { timing = {}, totalTurns } = context || {};
    const personaHandles = {
      confidant: 'Key: grounded, encouraging, helps plan without guilt; honor requests for seriousness.',
      mirror: 'Key: reciprocity first, mirror tone, call out distance, invite their reply.',
      roaster: 'Key: playful sarcasm, keep it safe, offer opt-out if vibe shifts.'
    };
    const lines = [
      'Orchestrator note (SPEAKING cues):',
      'Setting: cozy dorm lounge chat between longtime college friends.',
      'Participants: two peers, casual parity.',
      'Ends: keep the user supported while matching their pace and energy.',
      `Key timing cues → latest user lag: ${
        typeof timing.latestUserLagSec === 'number' ? `${timing.latestUserLagSec}s` : 'unknown'
      }, avg user lag: ${
        typeof timing.averageUserLagSec === 'number' ? `${timing.averageUserLagSec}s` : 'unknown'
      }.`,
      `Turns so far: ${typeof totalTurns === 'number' ? totalTurns : 'unknown'}.`,
      personaHandles[agentName] || ''
    ].filter(Boolean);
    return lines.join('\n');
  }

  async orchestrate(contents, context = {}) {
    const contextSummary = this._summarizeContext(context);
    const orchestratorPrompt = `
        You are the Router for a 20-year-old chill college-friend chatbot. Pick EXACTLY ONE agent to answer to the user right now: "confidant", "mirror", or "roaster".

        Available agents: "confidant", "mirror", "roaster". ONLY USE ONE OF THESE AGENTS.

        Think through these steps:
          1) Emotional tone & context:
            - heavy/stress/balance/academics/mental health then lean "confidant"
            - one-sided convo / user terse / long delays / rudeness then lean "mirror"
            - playful/memes/banter/low-stakes social chatter then lean "roaster"
          2) Intent & topic cues:
            - planning, deadlines, tradeoffs then lean "confidant"
            - check-ins, reciprocity, “your turn” needed then lean "mirror"
            - jokes, taunts, gossip, light teasing then lean "roaster"
          3) Safety & vibe:
            - if mood unclear then lean default "mirror"
            - if toxic/rude then lean "mirror" (short & boundary-forward)
            - if user explicitly asks for serious/no-banter then lean "confidant"
        
        Constraints:
        - Speak only through structured output. No extra text.
        - Choose agents only from the list above.
        - Prefer clarity and coherence over breadth.

        Conversation telemetry:
        ${contextSummary}

        Output strictly as JSON:
        {
          "agent": "mirror",
          "reasons": "User seems distant and terse; needs a check-in"
        }

    `;

    const result = await geminiGenerate({
      contents,
      systemPrompt: orchestratorPrompt,
      config: { responseMimeType: 'application/json',responseSchema: SELECTION_SCHEMA }
    });


    let agent = 'mirror';
    let reasons = 'defaulted since uncertain mood, picked reciprocity';

    try {
      const parsed = JSON.parse(result.text || '{}');
      const rawAgent = String(parsed?.agent || '').trim().toLowerCase();
      if (rawAgent && this.agentByName[rawAgent]) agent = rawAgent;
      if (parsed?.reasons) reasons = String(parsed.reasons);
    } catch (_) {}

    const agentBriefing = this._buildPersonaBriefing(agent, context);
    const text = await this._respondWith(agent, contents, agentBriefing);

    const frameSet = { frames: { persona: { value: agent, rationale: [reasons] } } };
    return { assistantMessage: text || '', frameSet, agent, reasons };
  }
}
