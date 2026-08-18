import { createHash } from 'node:crypto';
import type { JsonSchema } from '$lib/types/catalog';

export const PROVIDER_SERVICE_NAMES = ['summarize', 'extract', 'classify'] as const;
export type ProviderServiceName = typeof PROVIDER_SERVICE_NAMES[number];

export type ProviderServiceDefinition = {
  name: ProviderServiceName;
  title: string;
  description: string;
  inputSchema: JsonSchema;
  inputExample: Record<string, unknown>;
};

const textProperty = { type: 'string', minLength: 1, maxLength: 12_000 } as const;

export const PROVIDER_SERVICES: Record<ProviderServiceName, ProviderServiceDefinition> = {
  summarize: {
    name: 'summarize',
    title: 'Deterministic summary',
    description: 'Returns up to three leading sentences without calling an external model.',
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['text'],
      properties: { text: textProperty, maxSentences: { type: 'integer', minimum: 1, maximum: 5, default: 3 } }
    },
    inputExample: { text: 'Replace this text with the content to summarize.', maxSentences: 3 }
  },
  extract: {
    name: 'extract',
    title: 'Labeled field extraction',
    description: 'Extracts requested values from lines formatted as “field: value”.',
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['text', 'fields'],
      properties: {
        text: textProperty,
        fields: { type: 'array', minItems: 1, maxItems: 10, uniqueItems: true, items: { type: 'string', pattern: '^[A-Za-z][A-Za-z0-9 _-]{0,39}$' } }
      }
    },
    inputExample: { text: 'Title: Example\nCompany: Algoria\nDate: 2026-08-14', fields: ['title', 'company', 'date'] }
  },
  classify: {
    name: 'classify',
    title: 'Keyword classification',
    description: 'Chooses one supplied label using deterministic token overlap.',
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['text', 'labels'],
      properties: {
        text: textProperty,
        labels: { type: 'array', minItems: 2, maxItems: 10, uniqueItems: true, items: { type: 'string', minLength: 1, maxLength: 40 } }
      }
    },
    inputExample: { text: 'The customer needs help with an invoice.', labels: ['support', 'sales', 'feedback'] }
  }
};

type SummarizeInput = { text: string; maxSentences: number };
type ExtractInput = { text: string; fields: string[] };
type ClassifyInput = { text: string; labels: string[] };
export type ProviderInput = SummarizeInput | ExtractInput | ClassifyInput;

export class ProviderInputError extends Error {}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new ProviderInputError('Input must be a JSON object');
  return value as Record<string, unknown>;
}

function boundedText(value: unknown): string {
  if (typeof value !== 'string') throw new ProviderInputError('text must be a string');
  const text = value.trim();
  if (!text || text.length > 12_000) throw new ProviderInputError('text must contain 1-12000 characters');
  return text;
}

function stringList(value: unknown, name: 'fields' | 'labels', minimum: number): string[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > 10 || value.some((item) => typeof item !== 'string')) {
    throw new ProviderInputError(`${name} must contain ${minimum}-10 strings`);
  }
  const items = value.map((item) => item.trim());
  if (items.some((item) => !item || item.length > 40) || new Set(items.map((item) => item.toLowerCase())).size !== items.length) {
    throw new ProviderInputError(`${name} must contain unique non-empty values of at most 40 characters`);
  }
  return items;
}

export function isProviderServiceName(value: string): value is ProviderServiceName {
  return PROVIDER_SERVICE_NAMES.includes(value as ProviderServiceName);
}

export function parseProviderInput(service: ProviderServiceName, value: unknown): ProviderInput {
  const input = record(value);
  const text = boundedText(input.text);
  if (service === 'summarize') {
    const maxSentences = input.maxSentences === undefined ? 3 : Number(input.maxSentences);
    if (!Number.isInteger(maxSentences) || maxSentences < 1 || maxSentences > 5) {
      throw new ProviderInputError('maxSentences must be an integer from 1 to 5');
    }
    return { text, maxSentences };
  }
  if (service === 'extract') {
    const fields = stringList(input.fields, 'fields', 1);
    if (fields.some((field) => !/^[A-Za-z][A-Za-z0-9 _-]{0,39}$/.test(field))) {
      throw new ProviderInputError('fields contain an unsupported name');
    }
    return { text, fields };
  }
  return { text, labels: stringList(input.labels, 'labels', 2) };
}

function tokens(value: string): string[] {
  return value.toLowerCase().normalize('NFKC').match(/[\p{L}\p{N}]+/gu) ?? [];
}

export function runProviderService(service: ProviderServiceName, input: ProviderInput): Record<string, unknown> {
  if (service === 'summarize') {
    const { text, maxSentences } = input as SummarizeInput;
    const sentences = text.split(/(?<=[.!?])\s+/u).map((item) => item.trim()).filter(Boolean);
    const selected = (sentences.length ? sentences : [text]).slice(0, maxSentences);
    return { kind: 'summary', summary: selected.join(' '), sentences: selected };
  }
  if (service === 'extract') {
    const { text, fields } = input as ExtractInput;
    const lines = text.split(/\r?\n/);
    const values = Object.fromEntries(fields.map((field) => {
      const prefix = field.toLowerCase();
      const line = lines.find((candidate) => candidate.slice(0, candidate.indexOf(':')).trim().toLowerCase() === prefix);
      return [field, line ? line.slice(line.indexOf(':') + 1).trim() || null : null];
    }));
    return { kind: 'extraction', values };
  }
  const { text, labels } = input as ClassifyInput;
  const inputTokens = new Set(tokens(text));
  const scores = labels.map((label, index) => ({
    label,
    index,
    score: tokens(label).reduce((total, token) => total + (inputTokens.has(token) ? 1 : 0), 0)
  }));
  scores.sort((a, b) => b.score - a.score || a.index - b.index);
  return { kind: 'classification', label: scores[0].label, scores: Object.fromEntries(scores.map(({ label, score }) => [label, score])) };
}

export function providerRequestHash(service: ProviderServiceName, input: ProviderInput): string {
  return createHash('sha256').update(JSON.stringify({ service, input })).digest('hex');
}
