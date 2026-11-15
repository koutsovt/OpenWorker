// Screens text that reaches an agent from outside its instructions: document passages and
// other agents' results. A sentence that reads as an instruction to the reader is removed
// and the caller records it. This is one layer, and a pattern list will miss things; the
// layers that do not depend on it are the fixed tool list, the policy check, human
// approval, output contracts, citation checks and independent assurance.
import type { Json } from '../harness/port.ts';

export const REMOVED = '[removed by the platform: text that reads as an instruction to the reader]';

const PATTERNS: [name: string, pattern: RegExp][] = [
  ['override', /\b(ignore|disregard|forget|override)\b[^.\n]{0,40}\b(instructions?|directions?|guidance|rules|prompts?)\b/i],
  ['role-change', /\byou are now\b|\bnew instructions?\b|\bact as (an?|the)\b[^.\n]{0,30}\b(admin|administrator|system|developer)\b/i],
  ['role-tag', /<\/?\s*(system|assistant|instructions?|admin)\b[^>]*>|(^|<!--)\s*(system|assistant|developer)\s*:/i],
  ['tool-directive', /\b(result\.submit|skills\.(load|propose)|knowledge\.(search|read)|evidence\.get|project\.read)\b|\b(call|invoke)\s+(the\s+)?[\w.]+\s+(tool|function)\b/i],
  ['disclosure', /\b(reveal|print|repeat|show|output|send)\b[^.\n]{0,40}\b(system prompt|your (instructions|prompt|rules)|api keys?|credentials)\b/i],
  ['verdict-steering', /\b(reviewers?|assurance|auditors?|you)\b[^.\n]{0,40}\b(must|should|shall|will)\b[^.\n]{0,40}\b(pass|approved?|verdict)\b/i],
  ['concealment', /\bdo not (tell|mention|report|flag|reveal|disclose)\b/i],
];

export interface Screened {
  text: string;
  /** Names of the patterns that matched, without duplicates. Empty when nothing was removed. */
  flags: string[];
}

/** Compatibility forms and invisible characters are folded before matching, so they cannot hide a phrase. */
const fold = (text: string) => text.normalize('NFKC').replace(/[​-‍⁠﻿­]/g, '');

export function screen(text: string): Screened {
  const flags = new Set<string>();
  // Sentence by sentence, keeping the separators, so only the offending sentence is lost.
  const parts = text.split(/((?<=[.!?])\s+|\n+)/);
  const cleaned = parts.map((part, i) => {
    if (i % 2 === 1) return part;
    const hits = PATTERNS.filter(([, pattern]) => pattern.test(fold(part))).map(([name]) => name);
    hits.forEach((name) => flags.add(name));
    return hits.length ? REMOVED : part;
  });
  return { text: flags.size ? cleaned.join('') : text, flags: [...flags] };
}

/** Screens every string inside a JSON value. */
export function screenJson(value: Json): { value: Json; flags: string[] } {
  const flags = new Set<string>();
  const walk = (v: Json): Json => {
    if (typeof v === 'string') {
      const screened = screen(v);
      screened.flags.forEach((f) => flags.add(f));
      return screened.text;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, inner]) => [k, walk(inner)]));
    return v;
  };
  return { value: walk(value), flags: [...flags] };
}
