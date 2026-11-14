/**
 * @author Myoram Langwang
 * @description Unit tests for AABB overlap detection and Widget.moveTo snap-back.
 * @traces SE-FR-24, SE-NFR-07, UC-17
 */
import { describe, expect, it } from 'vitest';
import { Widget, targetCell } from './model';

const a = { id: 'a', grid_x: 0, grid_y: 0, width: 8, height: 3 };
const b = { id: 'b', grid_x: 8, grid_y: 0, width: 4, height: 3 };
const hidden = { id: 'h', grid_x: 0, grid_y: 6, width: 4, height: 2, is_hidden: true };

describe('UC-17 / SE-NFR-07 widget layout', () => {
  it('detects overlap and allows touching edges', () => {
    expect(Widget.overlaps(a, b)).toBe(false);
    expect(Widget.overlaps(a, { ...b, grid_x: 7 })).toBe(true);
  });
  it('snaps back on overlap', () => {
    const result = Widget.moveTo(b, 6, 1, [a, b]);
    expect(result.moved).toBe(false);
    expect(result.reason).toBe('overlap');
    expect([result.widget.grid_x, result.widget.grid_y]).toEqual([8, 0]);
  });
  it('moves to a free cell, ignoring hidden widgets', () => {
    const result = Widget.moveTo(b, 0, 6, [a, b, hidden]);
    expect(result.moved).toBe(true);
    expect([result.widget.grid_x, result.widget.grid_y]).toEqual([0, 6]);
  });
  it('refuses to leave the 12-column grid', () => {
    expect(Widget.moveTo(b, 10, 5, [a, b]).reason).toBe('out_of_bounds');
  });
  it('converts a pixel drag into grid cells', () => {
    expect(targetCell(b, -250, 200, 80, 84, 16)).toEqual({ x: 5, y: 2 });
  });
});
