import { PermanentError } from '../lib/errors';

/**
 * Minimal, deliberate template renderer.
 *
 * Handlebars/Eta would work, but a cold-email template needs exactly one
 * feature — {{variable}} substitution with a conditional block — and shipping a
 * full expression evaluator that can reach into arbitrary objects is a needless
 * injection surface for text that goes to external recipients.
 *
 * Supported syntax:
 *   {{name}}                      — substitution, HTML NOT escaped (plain text)
 *   {{#if name}}...{{/if}}        — render block when the value is truthy
 */

export type TemplateVars = Record<string, string | number | null | undefined>;

const IF_BLOCK = /\{\{#if\s+([a-zA-Z0-9_]+)\s*\}\}([\s\S]*?)\{\{\/if\}\}/g;
const VARIABLE = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;

export function renderTemplate(template: string, vars: TemplateVars): string {
  // Conditionals first, so variables inside a dropped block are never evaluated.
  const withBlocks = template.replace(IF_BLOCK, (_m, key: string, body: string) => {
    const value = vars[key];
    const truthy = value !== null && value !== undefined && value !== '' && value !== 0;
    return truthy ? body : '';
  });

  const rendered = withBlocks.replace(VARIABLE, (_m, key: string) => {
    const value = vars[key];
    return value === null || value === undefined ? '' : String(value);
  });

  // Collapse the blank-line pileup left behind by dropped conditional blocks.
  return rendered.replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Fails loudly rather than sending "Hi {{firstName}}," to a prospect.
 * Called after rendering, immediately before the send.
 */
export function assertFullyRendered(text: string, context: string): void {
  const unresolved = text.match(/\{\{[^}]*\}\}/g);
  if (unresolved) {
    throw new PermanentError(
      `${context}: unresolved template tokens ${[...new Set(unresolved)].join(', ')}`,
      'TEMPLATE_UNRESOLVED',
    );
  }
}

/** Extracts the variable names a template depends on, for admin validation. */
export function extractVariables(template: string): string[] {
  const found = new Set<string>();
  for (const m of template.matchAll(VARIABLE)) if (m[1]) found.add(m[1]);
  for (const m of template.matchAll(/\{\{#if\s+([a-zA-Z0-9_]+)\s*\}\}/g)) {
    if (m[1]) found.add(m[1]);
  }
  return [...found];
}
