// Deterministic Garden terrain.
//
// Pure function of (seed, size, shrine, plaza): nothing about the world is stored
// or sent, so the garden costs one constant instead of ten thousand tiles. The
// seed is fixed, so the same person walks back into the same garden every time.
//
// Roads are painted last and always win, so a pond can never strand the shrine
// behind water.

export const TERRAIN = {
  GRASS: 0,
  /** Tufted grass — scattered for texture, walkable. */
  GRASS_ALT: 1,
  /** Dirt road. */
  DIRT: 2,
  /** Stone plaza slab. */
  STONE: 3,
  /** Open water. Renders through the autotile family and blocks movement. */
  WATER: 4,
} as const

export type TerrainId = (typeof TERRAIN)[keyof typeof TERRAIN]

export type TerrainGrid = {
  width: number
  height: number
  /** Row-major, one TERRAIN id per tile. */
  tiles: Uint8Array
}

export type TerrainInput = {
  seed: number
  width: number
  height: number
  /** The shrine at the end of the path; its apron and axis stay clear. */
  shrine: { x: number; y: number }
  /** The stone clearing you spawn on. */
  plaza: { x: number; y: number }
}

/** Small deterministic PRNG. No dependency, and stable across engines. */
function mulberry32(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Hash-based value noise, bilinear filtered. Cheap and seed-stable. */
function valueNoise(seed: number) {
  const hash = (x: number, y: number) => {
    let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263) + seed) | 0
    h = Math.imul(h ^ (h >>> 13), 1274126177)
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296
  }
  return (x: number, y: number) => {
    const xi = Math.floor(x)
    const yi = Math.floor(y)
    const xf = x - xi
    const yf = y - yi
    // Smoothstep so clusters have soft edges instead of visible grid seams.
    const sx = xf * xf * (3 - 2 * xf)
    const sy = yf * yf * (3 - 2 * yf)
    const a = hash(xi, yi)
    const b = hash(xi + 1, yi)
    const c = hash(xi, yi + 1)
    const d = hash(xi + 1, yi + 1)
    return (a + (b - a) * sx) * (1 - sy) + (c + (d - c) * sx) * sy
  }
}

const index = (grid: TerrainGrid, x: number, y: number) => y * grid.width + x

export function tileAt(grid: TerrainGrid, x: number, y: number): number {
  if (x < 0 || y < 0 || x >= grid.width || y >= grid.height) return TERRAIN.GRASS
  return grid.tiles[index(grid, x, y)]
}

function fillRect(
  grid: TerrainGrid,
  x0: number,
  y0: number,
  w: number,
  h: number,
  id: number,
) {
  for (let y = Math.max(0, y0); y < Math.min(grid.height, y0 + h); y += 1) {
    for (let x = Math.max(0, x0); x < Math.min(grid.width, x0 + w); x += 1) {
      grid.tiles[index(grid, x, y)] = id
    }
  }
}

function fillEllipse(
  grid: TerrainGrid,
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  id: number,
) {
  for (let y = Math.max(0, cy - ry); y <= Math.min(grid.height - 1, cy + ry); y += 1) {
    for (let x = Math.max(0, cx - rx); x <= Math.min(grid.width - 1, cx + rx); x += 1) {
      const dx = (x - cx) / rx
      const dy = (y - cy) / ry
      if (dx * dx + dy * dy <= 1) grid.tiles[index(grid, x, y)] = id
    }
  }
}

/**
 * Cells that must stay walkable: the plaza you spawn on and the shrine axis.
 * Ponds and scenery are refused here, which is what keeps a generated garden
 * from ever fencing you in or drowning the path.
 */
function isReserved(input: TerrainInput, x: number, y: number): boolean {
  const { plaza, shrine } = input
  if (Math.abs(x - plaza.x) <= 10 && Math.abs(y - plaza.y) <= 8) return true
  if (Math.abs(x - shrine.x) <= 6) return true
  return false
}

export function generateTerrain(input: TerrainInput): TerrainGrid {
  const { width, height, seed } = input
  const grid: TerrainGrid = { width, height, tiles: new Uint8Array(width * height) }
  const noise = valueNoise(seed)
  const random = mulberry32(seed ^ 0x9e3779b9)

  // 1. Grass, with soft tufted clusters instead of the old modulo checkerboard.
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const n = noise(x / 9, y / 9)
      grid.tiles[index(grid, x, y)] = n > 0.62 ? TERRAIN.GRASS_ALT : TERRAIN.GRASS
    }
  }

  // 2. Ponds in the open margins. Ellipses rather than noise blobs so each one
  //    reads as a deliberate pond, and each is re-checked cell by cell against
  //    the reserved set.
  const pondCount = 5 + Math.floor(random() * 4)
  for (let attempt = 0, placed = 0; attempt < pondCount * 12 && placed < pondCount; attempt += 1) {
    const cx = Math.floor(random() * width)
    const cy = Math.floor(random() * height)
    const rx = 3 + Math.floor(random() * 4)
    const ry = 2 + Math.floor(random() * 3)
    let blocked = false
    for (let y = cy - ry - 1; y <= cy + ry + 1 && !blocked; y += 1) {
      for (let x = cx - rx - 1; x <= cx + rx + 1 && !blocked; x += 1) {
        if (isReserved(input, x, y)) blocked = true
      }
    }
    if (blocked) continue
    for (let y = cy - ry; y <= cy + ry; y += 1) {
      for (let x = cx - rx; x <= cx + rx; x += 1) {
        const dx = (x - cx) / rx
        const dy = (y - cy) / ry
        if (dx * dx + dy * dy > 1) continue
        if (x < 1 || y < 1 || x >= width - 1 || y >= height - 1) continue
        grid.tiles[index(grid, x, y)] = TERRAIN.WATER
      }
    }
    placed += 1
  }

  // 3. The clearing and the shrine apron. The clearing is an ellipse, not a
  //    rectangle: a hard-edged slab in the middle of a garden reads as an
  //    unfinished tilemap rather than as a place to stand.
  const { plaza, shrine } = input
  fillEllipse(grid, plaza.x, plaza.y, 7, 5, TERRAIN.STONE)
  fillRect(grid, Math.round(shrine.x) - 3, Math.round(shrine.y) - 2, 7, 6, TERRAIN.STONE)

  // 4. Paths last, so they always win over water and always reach the shrine.
  //
  // Two tiles wide: four times the player's collision width, and narrow enough
  // that the garden still reads as grass rather than as a dirt cross. A ring lane
  // loops the garden so wandering always finds its way back to the plaza.
  const ROAD = 2
  const top = Math.min(Math.round(shrine.y), plaza.y)
  fillRect(
    grid,
    Math.round(shrine.x) - 1,
    top,
    ROAD,
    Math.abs(Math.round(shrine.y) - plaza.y) + 2,
    TERRAIN.DIRT,
  )
  const margin = 8
  fillRect(grid, margin, margin, width - margin * 2, ROAD, TERRAIN.DIRT)
  fillRect(grid, margin, height - margin - ROAD, width - margin * 2, ROAD, TERRAIN.DIRT)
  fillRect(grid, margin, margin, ROAD, height - margin * 2, TERRAIN.DIRT)
  fillRect(grid, width - margin - ROAD, margin, ROAD, height - margin * 2, TERRAIN.DIRT)
  // The spur that connects the plaza to the ring, so the loop is walkable from
  // where you spawn without cutting across a pond.
  fillRect(grid, plaza.x - 1, margin, ROAD, plaza.y - margin, TERRAIN.DIRT)

  return grid
}

// --- Water autotiling ------------------------------------------------------
//
// Bit set = that orthogonal neighbour is NOT water, i.e. this side is a shore.
// The art's ring tiles already contain grass pixels, so water composites onto
// grass in a single tilemap layer — no overlay, no generated alpha masks.

export const EDGE_N = 1
export const EDGE_E = 2
export const EDGE_S = 4
export const EDGE_W = 8

/** Shore mask for a water cell. Out-of-bounds counts as shore. */
export function waterMask(grid: TerrainGrid, x: number, y: number): number {
  let mask = 0
  if (tileAt(grid, x, y - 1) !== TERRAIN.WATER) mask |= EDGE_N
  if (tileAt(grid, x + 1, y) !== TERRAIN.WATER) mask |= EDGE_E
  if (tileAt(grid, x, y + 1) !== TERRAIN.WATER) mask |= EDGE_S
  if (tileAt(grid, x - 1, y) !== TERRAIN.WATER) mask |= EDGE_W
  return mask
}

/**
 * Source tile for each of the 16 shore masks, as an offset in tiles inside the
 * water family block. Read off the artwork in
 * `tileset_water.png` (grass-shore block at tile 0,6):
 *
 *   (1,1) fill        (0..2, 0..2) 3x3 shore ring
 *   (3, 0..2) one-tile-wide vertical channel, top / middle / bottom
 *   (0..2, 3) one-tile-tall horizontal channel, west / middle / east
 *   (3,3) isolated single tile
 */
export const WATER_TILE_OFFSETS: Array<[number, number]> = (() => {
  const offsets: Array<[number, number]> = new Array(16)
  offsets[0] = [1, 1]
  offsets[EDGE_N] = [1, 0]
  offsets[EDGE_S] = [1, 2]
  offsets[EDGE_W] = [0, 1]
  offsets[EDGE_E] = [2, 1]
  offsets[EDGE_N | EDGE_W] = [0, 0]
  offsets[EDGE_N | EDGE_E] = [2, 0]
  offsets[EDGE_S | EDGE_W] = [0, 2]
  offsets[EDGE_S | EDGE_E] = [2, 2]
  // A one-tile-tall strip: shores above and below.
  offsets[EDGE_N | EDGE_S] = [1, 3]
  // A one-tile-wide strip: shores left and right.
  offsets[EDGE_W | EDGE_E] = [3, 1]
  offsets[EDGE_N | EDGE_W | EDGE_E] = [3, 0]
  offsets[EDGE_S | EDGE_W | EDGE_E] = [3, 2]
  offsets[EDGE_N | EDGE_S | EDGE_W] = [0, 3]
  offsets[EDGE_N | EDGE_S | EDGE_E] = [2, 3]
  offsets[EDGE_N | EDGE_E | EDGE_S | EDGE_W] = [3, 3]
  return offsets
})()

/** Whether a terrain id stops the local player. */
export function blocksMovement(id: number): boolean {
  return id === TERRAIN.WATER
}
