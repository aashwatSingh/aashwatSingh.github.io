// Unit layouts and the checklist for each kind of room. Items are the high-dispute zones from the
// roadmap: baseboards, carpet corners, stove drip pans, bathroom caulk, blinds. Pure data plus two
// small helpers, so it can be unit tested in Node.

// `rates` lists the rate-sheet entries that usually apply when the item is damaged.
// `scene` tells the demo photo generator what to draw.
export const ROOM_ITEMS = {
  living: [
    { id: 'walls', label: 'Walls and paint', hint: 'Stand back and fit the longest wall in frame.', rates: ['paint-touchup', 'drywall-small'], scene: 'wall' },
    { id: 'floor', label: 'Carpet and floor', hint: 'Aim down at the busiest stretch of floor.', rates: ['carpet-clean', 'carpet-patch'], scene: 'floor' },
    { id: 'baseboards', label: 'Baseboards and corners', hint: 'Crouch and frame one corner where two walls meet.', rates: ['paint-touchup'], scene: 'corner' },
    { id: 'window', label: 'Window and blinds', hint: 'Close the blinds so every slat shows.', rates: ['blind-replace'], scene: 'blinds' },
    { id: 'door', label: 'Entry door and lock', hint: 'Frame the whole door, inside face.', rates: ['door-repair'], scene: 'door' },
    { id: 'smoke', label: 'Smoke detector', hint: 'Aim straight up at the detector.', rates: ['smoke-detector'], scene: 'ceiling' },
  ],
  kitchen: [
    { id: 'stove', label: 'Stove top and drip pans', hint: 'Shoot from above so all burners show.', rates: ['appliance-clean', 'drip-pans'], scene: 'stove' },
    { id: 'counters', label: 'Countertops', hint: 'Frame the longest run of counter.', rates: ['counter-repair'], scene: 'counter' },
    { id: 'sink', label: 'Sink and faucet', hint: 'Fill the frame with the sink basin.', rates: ['appliance-clean'], scene: 'sink' },
    { id: 'fridge', label: 'Refrigerator inside', hint: 'Open the door and shoot the shelves.', rates: ['appliance-clean'], scene: 'fridge' },
    { id: 'kwalls', label: 'Kitchen walls', hint: 'Frame the wall behind the stove.', rates: ['paint-touchup', 'drywall-small'], scene: 'wall' },
  ],
  bath: [
    { id: 'caulk', label: 'Tub caulk and grout', hint: 'Frame where the tub meets the tile.', rates: ['recaulk'], scene: 'tile' },
    { id: 'toilet', label: 'Toilet', hint: 'Lid up, whole bowl in frame.', rates: ['appliance-clean'], scene: 'toilet' },
    { id: 'vanity', label: 'Sink and vanity', hint: 'Frame the sink and cabinet doors.', rates: ['counter-repair'], scene: 'sink' },
    { id: 'mirror', label: 'Mirror', hint: 'Shoot at an angle so you are not in it.', rates: ['mirror-replace'], scene: 'mirror' },
    { id: 'bfloor', label: 'Bathroom floor', hint: 'Aim down at the floor by the tub.', rates: ['recaulk'], scene: 'tile' },
  ],
  bedroom: [
    { id: 'bwalls', label: 'Walls and paint', hint: 'Fit the wall behind the bed in frame.', rates: ['paint-touchup', 'drywall-small', 'drywall-large'], scene: 'wall' },
    { id: 'carpet', label: 'Carpet and corners', hint: 'Aim at the corner nearest the door.', rates: ['carpet-clean', 'carpet-patch'], scene: 'floor' },
    { id: 'blinds', label: 'Window and blinds', hint: 'Close the blinds so every slat shows.', rates: ['blind-replace'], scene: 'blinds' },
    { id: 'closet', label: 'Closet and doors', hint: 'Open the closet and frame the doors.', rates: ['door-repair'], scene: 'door' },
    { id: 'furniture', label: 'Desk and furniture', hint: 'Frame the desk top and chair.', rates: ['furniture-repair'], scene: 'desk' },
  ],
};

export const ROOM_LABELS = { living: 'Living room', kitchen: 'Kitchen', bath: 'Bathroom', bedroom: 'Bedroom' };

// Areas are either shared (everyone on the lease is responsible) or a private bedroom.
const BEDROOM_LETTERS = ['A', 'B', 'C', 'D'];

function layout(bedrooms, baths) {
  const areas = [
    { id: 'living', kind: 'living', label: 'Living room', shared: true },
    { id: 'kitchen', kind: 'kitchen', label: 'Kitchen', shared: true },
  ];
  for (let i = 0; i < baths; i++) {
    areas.push({ id: `bath${i + 1}`, kind: 'bath', label: baths > 1 ? `Bathroom ${i + 1}` : 'Bathroom', shared: true });
  }
  for (let i = 0; i < bedrooms; i++) {
    const letter = BEDROOM_LETTERS[i];
    areas.push({ id: `bed${letter}`, kind: 'bedroom', label: bedrooms > 1 ? `Bedroom ${letter}` : 'Bedroom', shared: false, bedroom: letter });
  }
  return areas;
}

export const TEMPLATES = {
  studio: { id: 'studio', label: 'Studio', areas: [
    { id: 'living', kind: 'living', label: 'Main room', shared: true },
    { id: 'kitchen', kind: 'kitchen', label: 'Kitchen', shared: true },
    { id: 'bath1', kind: 'bath', label: 'Bathroom', shared: true },
  ] },
  '1x1': { id: '1x1', label: '1 bed, 1 bath', areas: layout(1, 1) },
  '2x2': { id: '2x2', label: '2 bed, 2 bath', areas: layout(2, 2) },
  '4x2': { id: '4x2', label: '4 bed, 2 bath student suite', areas: layout(4, 2) },
};

/** The bedroom letters a template offers residents, e.g. ['A', 'B']. Studios have none. */
export function bedroomsOf(templateId) {
  const t = TEMPLATES[templateId];
  return t ? t.areas.filter((a) => a.bedroom).map((a) => a.bedroom) : [];
}

/**
 * Every checklist item in a unit, in walking order: [{ key, area, item }].
 * `key` is `${areaId}.${itemId}` and is how entries, photos and decisions refer to an item.
 */
export function checklist(templateId) {
  const t = TEMPLATES[templateId];
  if (!t) return [];
  return t.areas.flatMap((area) => ROOM_ITEMS[area.kind].map((item) => ({ key: `${area.id}.${item.id}`, area, item })));
}

/** The items one resident walks: shared areas plus their own bedroom (all areas if no bedroom). */
export function checklistFor(templateId, bedroom) {
  return checklist(templateId).filter(({ area }) => area.shared || !bedroom || area.bedroom === bedroom);
}

/** Look up one item by key, or null. */
export function itemByKey(templateId, key) {
  return checklist(templateId).find((c) => c.key === key) || null;
}
