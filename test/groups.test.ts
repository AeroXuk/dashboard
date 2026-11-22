import { describe, expect, it } from 'vitest';
import { changedFromDefault } from '../web/groups';

const groups = [
  { name: 'media', collapsed: false },
  { name: 'admin', collapsed: true },
];

describe('changedFromDefault', () => {
  it('is false when nothing has been changed', () => {
    expect(changedFromDefault(groups, {})).toBe(false);
  });

  it('is false when saved choices match the defaults', () => {
    expect(changedFromDefault(groups, { media: false, admin: true })).toBe(false);
  });

  it('is true when a group is collapsed or expanded differently from its default', () => {
    expect(changedFromDefault(groups, { media: true })).toBe(true);
    expect(changedFromDefault(groups, { admin: false })).toBe(true);
  });

  it('ignores saved choices for groups no longer in the config', () => {
    expect(changedFromDefault(groups, { removed: true })).toBe(false);
  });

  it('is false when there are no groups', () => {
    expect(changedFromDefault([], { media: true })).toBe(false);
  });
});
