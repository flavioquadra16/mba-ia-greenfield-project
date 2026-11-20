import { createPublicId, isPublicId, PUBLIC_ID_LENGTH } from './public-id.util';

describe('createPublicId', () => {
  it('returns 11 characters from the base62 alphabet', () => {
    const id = createPublicId();
    expect(id).toHaveLength(PUBLIC_ID_LENGTH);
    expect(isPublicId(id)).toBe(true);
  });

  it('rejects ids of the wrong shape', () => {
    expect(isPublicId('short')).toBe(false);
    expect(isPublicId('has-dash-11')).toBe(false);
    expect(isPublicId(`${'a'.repeat(11)}b`)).toBe(false);
  });
});
