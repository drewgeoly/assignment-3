import { geminiGenerate } from '../gemini.js';
import { ExampleAgent } from '../agents/Agent.js';
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

  async _respondWith(agentName, contents) {
    const agent = this.agentByName[agentName] || this.agentByName.mirror;
    const res = await agent.respond(contents);
    return res?.text || '';
  }


  async orchestrate(contents) {
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
      agent = parsed?.agent;
      if (parsed?.reasons) reasons = String(parsed.reasons);
    } catch (_) {}

    const text = await this.respondWithAgent(agent, userMessage, context);

    const frameSet = { frames: { persona: { value: agent, rationale: [reasons] } } };
    return { assistantMessage: text || '', frameSet, agent, reasons };
  }
}


