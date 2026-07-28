// Placeable Garden scenery.
//
// One catalogue, four consumers: the Phaser texture builder, the creator-mode
// palette, the renderer, and — by hand — `GARDEN_PROP_IDS` in
// `server/src/routes/garden.rs`, which validates an id before it is ever stored
// or echoed to another client. Keep the two lists in lockstep.
//
// Crops were read off the sheets by connected-component bounding boxes rather
// than by eye, so each one is exactly the sprite with no neighbouring pixels and
// no clipped edges.
//
// Ids are persisted in `garden_objects.kind`, so never rename one — placed
// scenery would stop resolving.

export type GardenPropDef = {
  id: string
  label: string
  /** Which loaded sheet the crop comes from. */
  sheet: 'nature' | 'village'
  crop: { x: number; y: number; width: number; height: number }
  /**
   * Whether the local player collides with it. Trees and boulders read as solid;
   * ground cover does not, so a flowerbed never becomes a maze.
   */
  solid: boolean
}

export const GARDEN_PROPS: GardenPropDef[] = [
  // --- Trees. The same three crops the generated tree line uses. -----------
  {
    id: 'tree_wide',
    label: 'Broad tree',
    sheet: 'village',
    crop: { x: 0, y: 96, width: 64, height: 96 },
    solid: true,
  },
  {
    id: 'tree_tall',
    label: 'Tall tree',
    sheet: 'village',
    crop: { x: 64, y: 96, width: 32, height: 80 },
    solid: true,
  },
  // --- Rock. --------------------------------------------------------------
  {
    id: 'boulder',
    label: 'Boulder',
    sheet: 'nature',
    crop: { x: 193, y: 83, width: 61, height: 44 },
    solid: true,
  },
  {
    id: 'rock_brown',
    label: 'Brown rock',
    sheet: 'nature',
    crop: { x: 210, y: 132, width: 29, height: 27 },
    solid: true,
  },
  {
    id: 'rock_grey',
    label: 'Grey rock',
    sheet: 'nature',
    crop: { x: 258, y: 132, width: 29, height: 27 },
    solid: true,
  },
  {
    id: 'pebble',
    label: 'Pebble',
    sheet: 'nature',
    crop: { x: 240, y: 144, width: 16, height: 16 },
    solid: false,
  },
  // --- Wood. --------------------------------------------------------------
  {
    id: 'stump',
    label: 'Stump',
    sheet: 'nature',
    crop: { x: 1, y: 134, width: 30, height: 23 },
    solid: true,
  },
  {
    id: 'log',
    label: 'Cut log',
    sheet: 'nature',
    crop: { x: 33, y: 134, width: 30, height: 23 },
    solid: true,
  },
  {
    id: 'post',
    label: 'Post',
    sheet: 'nature',
    crop: { x: 227, y: 272, width: 10, height: 14 },
    solid: true,
  },
  // --- Ground cover. ------------------------------------------------------
  {
    id: 'bush',
    label: 'Bush',
    sheet: 'nature',
    crop: { x: 97, y: 163, width: 14, height: 11 },
    solid: false,
  },
  {
    id: 'tuft',
    label: 'Grass tuft',
    sheet: 'nature',
    crop: { x: 112, y: 161, width: 16, height: 14 },
    solid: false,
  },
  {
    id: 'flower_yellow',
    label: 'Yellow flower',
    sheet: 'nature',
    crop: { x: 17, y: 176, width: 15, height: 16 },
    solid: false,
  },
  {
    id: 'flower_red',
    label: 'Red flower',
    sheet: 'nature',
    crop: { x: 49, y: 177, width: 14, height: 14 },
    solid: false,
  },
  {
    id: 'berry_bush',
    label: 'Berry bush',
    sheet: 'nature',
    crop: { x: 114, y: 227, width: 28, height: 25 },
    solid: false,
  },
  {
    id: 'berry_bush_blue',
    label: 'Blue berry bush',
    sheet: 'nature',
    crop: { x: 114, y: 259, width: 28, height: 25 },
    solid: false,
  },
]

export const PROP_IDS: string[] = GARDEN_PROPS.map((prop) => prop.id)

const BY_ID = new Map(GARDEN_PROPS.map((prop) => [prop.id, prop]))

export function propDef(id: string): GardenPropDef | undefined {
  return BY_ID.get(id)
}

/** Phaser texture key for a catalogue entry. */
export function propTextureKey(id: string): string {
  return `garden-prop-${id}`
}

/** Sheet texture key a crop is cut from. */
export function propSheetKey(sheet: GardenPropDef['sheet']): string {
  return sheet === 'nature' ? 'garden-nature' : 'garden-village'
}
