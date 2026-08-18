import type { ChatMessage, ConversationSummary } from '$lib/types/chat';
import { getAdminClient } from './client';

type DbConversation = { id: string; title: string; updated_at: string; expires_at: string };
type DbMessage = { id: string; role: ChatMessage['role']; kind: ChatMessage['kind']; content: Record<string, unknown>; created_at: string };

export async function listConversations(userId: string): Promise<ConversationSummary[]> {
  const { data, error } = await getAdminClient().from('conversations')
    .select('id,title,updated_at,expires_at')
    .eq('user_id', userId)
    .order('updated_at', { ascending: false })
    .limit(100);
  if (error) throw error;
  return ((data ?? []) as DbConversation[]).map((row) => ({
    id: row.id, title: row.title, updatedAt: row.updated_at, expiresAt: row.expires_at
  }));
}

export async function listMessages(userId: string, conversationId: string): Promise<ChatMessage[]> {
  const admin = getAdminClient();
  const { data: owned, error: ownershipError } = await admin.from('conversations')
    .select('id').eq('id', conversationId).eq('user_id', userId).maybeSingle();
  if (ownershipError) throw ownershipError;
  if (!owned) throw new Error('Conversation not found');
  const { data, error } = await admin.from('messages')
    .select('id,role,kind,content,created_at')
    .eq('conversation_id', conversationId)
    .eq('user_id', userId)
    .order('created_at', { ascending: true });
  if (error) throw error;
  return ((data ?? []) as DbMessage[]).map((row) => ({
    id: row.id,
    role: row.role,
    kind: row.kind,
    text: typeof row.content.text === 'string' ? row.content.text : undefined,
    job: row.kind === 'job' ? row.content.job as ChatMessage['job'] : undefined,
    createdAt: row.created_at
  }));
}

export async function createConversation(userId: string, title: string): Promise<ConversationSummary> {
  const safeTitle = title.trim().replace(/\s+/g, ' ').slice(0, 120) || 'New conversation';
  const { data, error } = await getAdminClient().from('conversations')
    .insert({ user_id: userId, title: safeTitle })
    .select('id,title,updated_at,expires_at')
    .single();
  if (error) throw error;
  const row = data as DbConversation;
  return { id: row.id, title: row.title, updatedAt: row.updated_at, expiresAt: row.expires_at };
}

export async function addMessage(
  userId: string,
  conversationId: string,
  message: Pick<ChatMessage, 'role' | 'kind' | 'text' | 'job'>
) {
  const admin = getAdminClient();
  const { data: owned, error: ownershipError } = await admin.from('conversations')
    .select('id').eq('id', conversationId).eq('user_id', userId).maybeSingle();
  if (ownershipError) throw ownershipError;
  if (!owned) throw new Error('Conversation not found');
  const content = message.kind === 'job' ? { job: message.job } : { text: message.text ?? '' };
  const { data, error } = await admin.from('messages')
    .insert({ conversation_id: conversationId, user_id: userId, role: message.role, kind: message.kind, content })
    .select('id,created_at')
    .single();
  if (error) throw error;
  const { error: updateError } = await admin.from('conversations')
    .update({ updated_at: new Date().toISOString() }).eq('id', conversationId).eq('user_id', userId);
  if (updateError) throw updateError;
  return data as { id: string; created_at: string };
}
