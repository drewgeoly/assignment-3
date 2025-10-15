import { geminiGenerate } from '../gemini.js';
import { ConfidantAgent } from '../agents/ConfidantAgent.js';
import { MirrorAgent } from '../agents/MirrorAgent.js';
import { RoasterAgent } from '../agents/RoasterAgent.js';

const SYNTHESIS_SCHEMA = {
  type: 'OBJECT',
  properties: {
    agent: { type: 'STRING' },
    reasons: { type: 'STRING' },
    response: { type: 'STRING' },
    components: {
      type: 'ARRAY',
      items: { type: 'STRING' }
    }
  },
  required: ['agent', 'response']
};

export class SynthesizerOrchestrator {
  constructor() {
    this.name = 'cmr_synth';
    this.agentByName = {
      confidant: new ConfidantAgent(),
      mirror: new MirrorAgent(),
      roaster: new RoasterAgent(),
    };
  }

  async _respondWith(agentName, contents) {
    const agent = this.agentByName[agentName] || this.agentByName.mirror;
    const res = await agent.respond(contents);
    return res?.text?.trim() || '';
  }

  async orchestrate(contents) {
    const drafts = {};
    for (const name of Object.keys(this.agentByName)) {
      drafts[name] = await this._respondWith(name, contents);
    }

    const digest = Object.entries(drafts)
      .map(([name, reply]) => `Agent: ${name}\nPersona draft:\n${reply || '(empty draft)'}`)
      .join('\n\n');

    const aggregatorPrompt = `
        You are the aggregator for a 20-year-old chill college friend chatbot.
        You have three persona specialists:
          • confidant → grounded, encouraging, realistic planning
          • mirror → reciprocal, reflective, nudges mutual sharing
          • roaster → playful banter, teasing with care

        Workflow:
          1. Read the latest conversation (contents preceding this instruction).
          2. Review each draft, noting what it contributes (insight, tone, risks).
          3. Decide which persona should be the anchor voice. You may weave in lines or moves from the other drafts if it strengthens the reply.
             - safety or heavy topics → confidant anchor
             - distant / terse user → mirror anchor
             - playful / low stakes → roaster anchor
          4. Produce ONE coherent reply (<=120 words) that sounds like a single friend but can incorporate ideas or phrasing from multiple drafts.
             Always attribute in your own planning which drafts you borrowed from.

        Output strictly JSON, no prose. Schema:
        {
          "agent": "confidant",           // anchor persona you sounded most like
          "response": "final text to send to the user",
          "reasons": "brief why this blend works / what pieces you borrowed",
          "components": ["confidant", "mirror"] // optional; list personas whose ideas you used
        }

        Keep the tone natural, mostly lowercase, emojis only if they appeared in a selected draft or fit the anchor voice. Safety > jokes.
        Limit the reasons to a few concise points or sentences that would help the user understand your choice.
    `;

    const synthesizerContents = [
      ...contents,
      {
        role: 'user',
        parts: [{
          text: `Persona drafts available for synthesis:\n\n${digest}\n\nReturn JSON per instructions above.`
        }]
      }
    ];

    const result = await geminiGenerate({
      contents: synthesizerContents,
      systemPrompt: aggregatorPrompt,
      config: { responseMimeType: 'application/json', responseSchema: SYNTHESIS_SCHEMA }
    });

    let agent = 'mirror';
    let reasons = 'defaulted to mirror; synthesis fell back';
    let response = drafts[agent] || '';

    try {
      const parsed = JSON.parse(result.text || '{}');
      const rawAgent = String(parsed?.agent || '').trim().toLowerCase();
      if (rawAgent && this.agentByName[rawAgent]) agent = rawAgent;
      if (parsed?.response) response = String(parsed.response).trim();
      else if (drafts[agent]) response = drafts[agent];
      if (parsed?.reasons) reasons = String(parsed.reasons);
    } catch (_) {}

    if (!response) response = await this._respondWith(agent, contents);

    const frameSet = { frames: { persona: { value: agent, rationale: [reasons] } } };
    return { assistantMessage: response, frameSet, agent, reasons };
  }
}
