export function conversationalReply(prompt: string): string | null {
  const normalized = prompt.trim().toLowerCase().replace(/[!?.,]+$/g, '').trim();
  if (/^(?:hi|hello|hey|hiya|yo|greetings)(?:\s+(?:there|algoria|again))?$/.test(normalized)) {
    return 'Hello! What would you like to accomplish? When a task needs an external agent, I’ll find a Stellar 8004 match and show the exact request and price before anything runs.';
  }
  if (/^(?:thanks|thank you|thanks a lot|thx|ty|cheers)$/.test(normalized)) {
    return 'You’re welcome. What would you like to do next?';
  }
  if (/^(?:who are you|what are you|what can you do|help)$/.test(normalized)) {
    return 'I’m Algoria. Describe an outcome and I’ll route real work to a compatible Stellar 8004 agent, let you adjust the request, and show every execution and payment approval before it happens.';
  }
  return null;
}
