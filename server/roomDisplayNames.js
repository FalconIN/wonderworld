// Maps the DB's party_rooms.name to the customer-facing colour-based name.
// Mirrors ROOM_DISPLAY_NAMES in admin.js (kept separate since browser JS can't require() this).
const ROOM_DISPLAY_NAMES = {
  'The Big Room':       'Big Room',
  'Sunshine Room':      'Yellow Room',
  'Dream Room':         'Purple Room',
  'Wonder Forest Room': 'Green Room',
};

function roomDisplayName(name) {
  return ROOM_DISPLAY_NAMES[name] || name || '—';
}

module.exports = { ROOM_DISPLAY_NAMES, roomDisplayName };
