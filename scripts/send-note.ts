#!/usr/bin/env tsx
import { JulesClient } from '../src/jules-client.js';

const client = new JulesClient(process.env.JULES_API_KEY!);
const sessionId = process.argv[2];
const message = process.argv.slice(3).join(' ');
if (!sessionId || !message) {
  console.error('Usage: send-note.ts <session_id> <message...>');
  process.exit(1);
}
const result = await client.sendMessage(sessionId, message);
console.log('OK — message sent to session', sessionId, '| state:', result.state);
