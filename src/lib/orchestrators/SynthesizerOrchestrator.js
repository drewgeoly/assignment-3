import { geminiGenerate } from '../gemini.js';
import { ConfidantAgent } from '../agents/ConfidantAgent.js';
import { MirrorAgent } from '../agents/MirrorAgent.js';
import { RoasterAgent } from '../agents/RoasterAgent.js';

const SYNTHESIS_SCHEMA = {
  type: 'OBJECT',
  properties: {
    agent: { type: 'STRING' },
    reasons: { type: 'STRING' },
    response: { type: 'STRING' }
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
    const candidateDrafts = {};
    for (const agentName of Object.keys(this.agentByName)) {
      candidateDrafts[agentName] = await this._respondWith(agentName, contents);
    }

    const candidateDigest = Object.entries(candidateDrafts)
      .map(([name, text]) => `Agent: ${name}\nReply:\n${text || '(no draft)'}`)
      .join('\n\n');

    const synthesizerPrompt = `
        You are the synthesizer for a 20-year-old chill college-friend chatbot.
        You receive draft replies from three personas: "confidant", "mirror", and "roaster".

        Think through:
          1) What vibe and needs the user is signaling in the latest exchange.
          2) Strengths/risks of each draft (tone, safety, usefulness).
          3) Whether to use one draft as-is, lightly edit it, or weave two together—only if the result still sounds like ONE clear persona.

        Constraints:
        - Output JSON only; no markdown or commentary.
        - Keep the final reply under ~120 words, conversational lowercase, emoji sparingly.
        - Safety overrides jokes: if user asks for serious support or vents heavy topics, choose/confidant.
        - If user is distant/terse or needs reciprocity, choose mirror.
        - If it is playful low-stakes banter, choose roaster.

        Return exactly:
        {
          "agent": "mirror",
          "response": "final text to send to the user",
          "reasons": "brief note on why this persona/edits work"
        }
    `;

    const synthesizerContents = [
      ...contents,
      {
        role: 'user',
        parts: [{
          text: `Candidate replies from your specialists:\n\n${candidateDigest}\n\n` +
                `Choose or edit the best fit and respond with JSON matching the schema.`
        }]
      }
    ];

    const result = await geminiGenerate({
      contents: synthesizerContents,
      systemPrompt: synthesizerPrompt,
      config: { responseMimeType: 'application/json', responseSchema: SYNTHESIS_SCHEMA }
    });

    let agent = 'mirror';
    let reasons = 'Defaulted to mirror because synthesis failed';
    let response = candidateDrafts[agent] || '';

    try {
      const parsed = JSON.parse(result.text || '{}');
      const rawAgent = String(parsed?.agent || '').trim().toLowerCase();
      if (rawAgent && this.agentByName[rawAgent]) agent = rawAgent;
      if (parsed?.response) response = String(parsed.response).trim();
      else if (candidateDrafts[agent]) response = candidateDrafts[agent];
      if (parsed?.reasons) reasons = String(parsed.reasons);
    } catch (_) {}

    if (!response) response = await this._respondWith(agent, contents);

    const frameSet = { frames: { persona: { value: agent, rationale: [reasons] } } };
    return { assistantMessage: response, frameSet, agent, reasons };
  }
}
