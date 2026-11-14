/**
 * @author Aashwat Singh
 * @description Unit tests: the Markdown renderer's parser keeps formatting and mentions and never produces
 *   javascript:/data: links.
 * @traces SE-FR-28, SE-FR-29, UC-21
 */
import { describe, expect, it } from 'vitest';
import { extractMentions, parseInline, parseMarkdown, safeHref } from './markdown';

describe('UC-21 safe markdown', () => {
  it('parses bold, italic, code and mentions', () => {
    const nodes = parseInline('**bold** *it* `x<y` @staff');
    expect(nodes.map((n) => n.type)).toEqual(['strong', 'text', 'em', 'text', 'code', 'text', 'mention']);
  });
  it('drops dangerous link targets but keeps the label as text', () => {
    expect(parseInline('[click](javascript:alert(1))')).toEqual([{ type: 'text', text: 'click' }, { type: 'text', text: ')' }]);
    expect(safeHref('data:text/html,x')).toBeNull();
    expect(safeHref('JAVA\tSCRIPT:alert(1)')).toBeNull();
    expect(safeHref('https://example.com/a')).toBe('https://example.com/a');
  });
  it('builds lists, quotes and code blocks', () => {
    const blocks = parseMarkdown('- one\n- two\n\n> quoted\n\n```\ncode\n```');
    expect(blocks.map((b) => b.type)).toEqual(['ul', 'quote', 'code']);
  });
  it('extracts mentions but not emails', () => {
    expect(extractMentions('hi @tyler and a@b.com @staff @tyler')).toEqual(['tyler', 'staff']);
  });
});
