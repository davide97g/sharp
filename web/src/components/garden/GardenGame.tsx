// The Garden world: one fixed, private, single-player scene.
//
// Everything here is derived from a constant seed. Nothing is fetched, nothing is
// sent, and nobody else is in it — so this file has no peers, no rooms, no
// network layer and no store writes. React owns the chrome (timer, controls);
// Phaser owns high-frequency world rendering, exactly as before.
//
// Per-user decoration is a later feature. When it lands it becomes a diff painted
// on top of this generated default, never a snapshot of it.

import { useEffect, useRef, useState } from 'react'
import type { GardenFacing } from '../../lib/types'
import {
  blocksMovement,
  generateTerrain,
  TERRAIN,
  tileAt,
  waterMask,
  WATER_TILE_OFFSETS,
  type TerrainGrid,
} from '../../lib/garden/terrain'
import { sound } from '../../lib/sound'
import { useStore } from '../../store'
import { AVATAR_IDS, avatarSheetUrl, avatarTextureKey, resolveAvatarId } from './gardenAvatars'
import { GARDEN_PROPS, propDef, propSheetKey, propTextureKey } from './gardenProps'

const TILE = 16
const SPEED = 7
const ASSET_ROOT = '/assets/garden/ninja-adventure'
const SHRINE_ASSET_ROOT = '/assets/garden/feudal-japan'
// Grass-shore water family in tileset_water.png, in pixels.
const WATER_BLOCK_X = 0
const WATER_BLOCK_Y = 96
/** Ground-strip index of the first water case; TERRAIN ids 0..3 precede it. */
const WATER_TILE_BASE = 4

/**
 * The garden. A constant rather than server state or a per-user value: everyone
 * walks the same shaped garden, and it has to be the same one on every visit and
 * every device. Change it to reshape the world for everybody.
 */
const GARDEN_SEED = 0x5a17c0de
const WORLD_W = 80
const WORLD_H = 72
const PLAZA = { x: 40, y: 36 }
const SHRINE = { x: 40, y: 58 }

const DIRECTION_COLUMN: Record<GardenFacing, number> = {
  down: 0,
  up: 1,
  left: 2,
  right: 3,
}

type Props = {
  /**
   * Freeze the player. Set while an overlay owns attention (the timer picker, the
   * character picker), so a key press cannot mean two things at once.
   */
  frozen: boolean
}

type Point = { x: number; y: number }

/** Stable per-tile pseudo-random in 0..1. Same shape as terrain's own hash. */
function tileNoise(x: number, y: number, salt: number): number {
  let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263) + GARDEN_SEED + salt) | 0
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296
}

export function GardenGame({ frozen }: Props) {
  const hostRef = useRef<HTMLDivElement>(null)
  const frozenRef = useRef(frozen)
  frozenRef.current = frozen
  const [themeRevision, setThemeRevision] = useState(0)

  useEffect(() => {
    const observer = new MutationObserver(() => {
      setThemeRevision((revision) => revision + 1)
    })
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme', 'data-scheme'],
    })
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    let disposed = false
    let game: import('phaser').Game | null = null
    let unsubscribe: (() => void) | null = null
    let resizeObserver: ResizeObserver | null = null
    const renderScale = Math.min(window.devicePixelRatio || 1, 2)

    void (async () => {
      const Phaser = await import('phaser')
      if (disposed || !hostRef.current) return

      const styles = getComputedStyle(document.documentElement)
      const css = (token: string) => styles.getPropertyValue(token).trim()
      const inkCss = css('--color-ink')

      type AtlasCrop = { x: number; y: number; width: number; height: number }

      /** The one character in the world. */
      type Walker = {
        node: import('phaser').GameObjects.Container
        sprite: import('phaser').GameObjects.Sprite
        shadow: import('phaser').GameObjects.Image
        /** Resolved roster id currently rendered, so a change can be detected. */
        avatarId: string
        facing: GardenFacing
        moving: boolean
        jumpHeight: number
        jumping: boolean
      }

      class GardenScene extends Phaser.Scene {
        private player!: Walker
        private cursors!: import('phaser').Types.Input.Keyboard.CursorKeys
        private wasd!: Record<'W' | 'A' | 'S' | 'D', import('phaser').Input.Keyboard.Key>
        private jumpKey!: import('phaser').Input.Keyboard.Key
        private blockers!: import('phaser').Physics.Arcade.StaticGroup
        private target: Point | null = null
        private terrain: TerrainGrid | null = null
        private worldWidth = WORLD_W * TILE
        private worldHeight = WORLD_H * TILE
        private lastStep = 0
        private lastBump = 0
        private reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches

        constructor() {
          super('garden')
        }

        preload() {
          this.load.image('garden-floor-source', `${ASSET_ROOT}/tileset_floor.png`)
          this.load.image('garden-water-source', `${ASSET_ROOT}/tileset_water.png`)
          this.load.image('garden-village', `${ASSET_ROOT}/tileset_village.png`)
          this.load.image('garden-nature', `${ASSET_ROOT}/tileset_nature.png`)
          this.load.image('garden-shadow', `${ASSET_ROOT}/avatar_shadow.png`)
          this.load.image('garden-shrine-gate', `${SHRINE_ASSET_ROOT}/wooden_gate.png`)
          this.load.image('garden-shrine-steps', `${SHRINE_ASSET_ROOT}/stone_steps.png`)
          this.load.image('garden-shrine-pillar', `${SHRINE_ASSET_ROOT}/temple_pillar.png`)
          this.load.image('garden-shrine-wall', `${SHRINE_ASSET_ROOT}/shrine_wall.png`)
          this.load.spritesheet('garden-flower', `${ASSET_ROOT}/flower_dance.png`, {
            frameWidth: 16,
            frameHeight: 16,
          })
          // Every roster sheet is the same 4x7 grid of 16px frames, so the whole
          // set loads from one list (gardenAvatars.ts). Adding a character never
          // touches this file.
          for (const id of AVATAR_IDS) {
            this.load.spritesheet(avatarTextureKey(id), avatarSheetUrl(id), {
              frameWidth: 16,
              frameHeight: 16,
            })
          }
        }

        create() {
          this.makeCuratedTiles()
          this.createAnimations()
          this.blockers = this.physics.add.staticGroup()
          this.drawWorld()

          const store = useStore.getState()
          this.player = this.makeWalker(
            PLAZA.x * TILE,
            (PLAZA.y + 2) * TILE,
            resolveAvatarId(store.garden.avatar, store.me?.id ?? ''),
          )
          this.physics.add.existing(this.player.node)
          const body = this.player.node.body as import('phaser').Physics.Arcade.Body
          body.setSize(11, 8)
          body.setOffset(-5.5, -2)
          body.setCollideWorldBounds(true)
          this.physics.add.collider(this.player.node, this.blockers)
          this.physics.world.setBounds(
            TILE,
            TILE,
            this.worldWidth - TILE * 2,
            this.worldHeight - TILE * 2,
          )

          this.cursors = this.input.keyboard!.createCursorKeys()
          this.wasd = this.input.keyboard!.addKeys('W,A,S,D') as typeof this.wasd
          this.jumpKey = this.input.keyboard!.addKey(Phaser.Input.Keyboard.KeyCodes.SPACE)
          this.input.on('pointerdown', (pointer: import('phaser').Input.Pointer) => {
            if (frozenRef.current) return
            this.target = { x: pointer.worldX, y: pointer.worldY }
          })

          this.cameras.main.setBounds(0, 0, this.worldWidth, this.worldHeight)
          this.cameras.main.startFollow(this.player.node, true, 0.12, 0.12)
          this.cameras.main.fadeIn(this.reducedMotion ? 120 : 520, 0, 0, 0)
          const setZoom = () => {
            const logicalWidth = this.scale.width / renderScale
            const logicalZoom = logicalWidth < 620 ? 1 : 2
            this.cameras.main.setZoom(logicalZoom * renderScale)
          }
          this.scale.on('resize', setZoom)
          setZoom()

          // Picking a new character retextures the existing sprite rather than
          // rebuilding it, so the walk in progress is not interrupted.
          const sync = (state: ReturnType<typeof useStore.getState>) => {
            const next = resolveAvatarId(state.garden.avatar, state.me?.id ?? '')
            if (this.player.avatarId === next) return
            this.player.avatarId = next
            this.player.sprite.setTexture(avatarTextureKey(next))
            this.player.sprite.setFrame(DIRECTION_COLUMN[this.player.facing])
          }
          unsubscribe = useStore.subscribe(sync)

          // A scene restart fires SHUTDOWN without unmounting the component, so
          // the subscription has to come off here too or it would outlive the
          // objects it touches.
          this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
            this.scale.off('resize', setZoom)
            unsubscribe?.()
            unsubscribe = null
          })
        }

        update(time: number) {
          if (!this.player) return
          const body = this.player.node.body as import('phaser').Physics.Arcade.Body
          if (frozenRef.current) {
            body.setVelocity(0, 0)
            this.target = null
            this.animateWalker(this.player, time)
            return
          }
          const activeElement = document.activeElement
          const typing =
            activeElement instanceof HTMLInputElement ||
            activeElement instanceof HTMLTextAreaElement ||
            activeElement?.getAttribute('contenteditable') === 'true'
          let dx = 0
          let dy = 0
          if (!typing && Phaser.Input.Keyboard.JustDown(this.jumpKey)) {
            this.startJump(this.player)
          }
          if (!typing) {
            if (this.cursors.left.isDown || this.wasd.A.isDown) dx -= 1
            if (this.cursors.right.isDown || this.wasd.D.isDown) dx += 1
            if (this.cursors.up.isDown || this.wasd.W.isDown) dy -= 1
            if (this.cursors.down.isDown || this.wasd.S.isDown) dy += 1
          }
          if (dx || dy) this.target = null
          if (!dx && !dy && this.target) {
            const tx = this.target.x - this.player.node.x
            const ty = this.target.y - this.player.node.y
            if (Math.hypot(tx, ty) < 5) this.target = null
            else {
              dx = tx
              dy = ty
            }
          }

          const moving = dx !== 0 || dy !== 0
          if (moving) {
            const length = Math.hypot(dx, dy)
            dx /= length
            dy /= length
            body.setVelocity(dx * SPEED * TILE, dy * SPEED * TILE)
            this.faceWalker(
              this.player,
              Math.abs(dx) > Math.abs(dy)
                ? dx < 0
                  ? 'left'
                  : 'right'
                : dy < 0
                  ? 'up'
                  : 'down',
            )
          } else {
            body.setVelocity(0, 0)
          }

          const colliding = moving && (!body.blocked.none || !body.touching.none)
          if (colliding && time - this.lastBump > 320) {
            this.lastBump = time
            sound.garden.bump()
          } else if (moving && time - this.lastStep > 215) {
            this.lastStep = time
            sound.garden.step()
          }
          if (this.target && (!body.blocked.none || (!body.touching.none && moving))) {
            this.target = null
          }

          this.player.moving = moving
          this.animateWalker(this.player, time)
          this.player.node.setDepth(this.player.node.y + 100)
        }

        // --- The character ------------------------------------------------

        private makeWalker(x: number, y: number, avatarId: string): Walker {
          const shadow = this.add.image(0, 1, 'garden-shadow').setAlpha(0.7)
          const sprite = this.add.sprite(0, -8, avatarTextureKey(avatarId), DIRECTION_COLUMN.down)
          // No name label, no presence dot, no identity ring: there is nobody to
          // read them, and the point of this room is that nothing is watching.
          const node = this.add.container(x, y, [shadow, sprite])
          node.setDepth(y + 100)
          return {
            node,
            sprite,
            shadow,
            avatarId,
            facing: 'down',
            moving: false,
            jumpHeight: 0,
            jumping: false,
          }
        }

        private faceWalker(walker: Walker, facing: GardenFacing) {
          walker.facing = facing
          if (!walker.moving) walker.sprite.setFrame(DIRECTION_COLUMN[facing])
        }

        private animateWalker(walker: Walker, time: number) {
          const column = DIRECTION_COLUMN[walker.facing]
          const lift = walker.jumpHeight
          walker.shadow
            .setScale(Math.max(0.2, 1 - lift / 110))
            .setAlpha(Math.max(0.08, 0.7 - lift / 150))
          if (walker.moving) {
            const row = this.reducedMotion ? 1 : Math.floor(time / 135) % 4
            walker.sprite.setFrame(row * 4 + column)
            walker.sprite.y = -8 - lift
            return
          }
          walker.sprite.setFrame(column)
          walker.sprite.y = this.reducedMotion
            ? -8 - lift
            : -8 - lift + Math.round(Math.sin(time / 650))
        }

        private startJump(walker: Walker) {
          if (walker.jumping) return
          walker.jumping = true
          sound.garden.jump()
          if (this.reducedMotion) {
            walker.jumpHeight = 4
            this.time.delayedCall(90, () => {
              walker.jumpHeight = 0
              walker.jumping = false
              sound.garden.land()
            })
            return
          }
          this.tweens.add({
            targets: walker,
            jumpHeight: 19,
            duration: 220,
            ease: 'Sine.out',
            yoyo: true,
            onComplete: () => {
              walker.jumpHeight = 0
              walker.jumping = false
              walker.sprite.setScale(1)
              sound.garden.land()
              this.addLandingDust(walker.node.x, walker.node.y)
            },
          })
          this.tweens.add({
            targets: walker.sprite,
            scaleX: { from: 1.08, to: 0.92 },
            scaleY: { from: 0.9, to: 1.08 },
            duration: 220,
            ease: 'Sine.inOut',
            yoyo: true,
          })
        }

        private addLandingDust(x: number, y: number) {
          if (this.reducedMotion) return
          for (const direction of [-1, 1]) {
            const dust = this.add
              .circle(x + direction * 5, y - 1, 2, 0xe5d28b, 0.75)
              .setDepth(y + 99)
            this.tweens.add({
              targets: dust,
              x: x + direction * 15,
              y: y - 5,
              alpha: 0,
              scale: 0.25,
              duration: 260,
              ease: 'Quad.out',
              onComplete: () => dust.destroy(),
            })
          }
        }

        // --- The world -----------------------------------------------------

        private drawWorld() {
          const terrain = generateTerrain({
            seed: GARDEN_SEED,
            width: WORLD_W,
            height: WORLD_H,
            shrine: SHRINE,
            plaza: PLAZA,
          })
          this.terrain = terrain

          // Terrain ids map straight onto strip indices, except water, which
          // picks its shore case from the neighbourhood.
          const data = Array.from({ length: WORLD_H }, (_, y) =>
            Array.from({ length: WORLD_W }, (_, x) => {
              const id = tileAt(terrain, x, y)
              if (id !== TERRAIN.WATER) return id
              return WATER_TILE_BASE + waterMask(terrain, x, y)
            }),
          )
          this.addTileLayer(data, 'garden-ground')
          this.addTerrainBlockers(terrain)
          this.drawShrine()
          this.scatterScenery()
        }

        /**
         * Static bodies for impassable terrain, merged into horizontal runs so a
         * pond costs a handful of bodies rather than one per tile.
         */
        private addTerrainBlockers(terrain: TerrainGrid) {
          for (let y = 0; y < terrain.height; y += 1) {
            let runStart = -1
            for (let x = 0; x <= terrain.width; x += 1) {
              const solid = x < terrain.width && blocksMovement(tileAt(terrain, x, y))
              if (solid && runStart === -1) runStart = x
              if (!solid && runStart !== -1) {
                const runWidth = x - runStart
                this.addBlocker(
                  (runStart + runWidth / 2) * TILE,
                  (y + 0.5) * TILE,
                  runWidth * TILE,
                  TILE,
                )
                runStart = -1
              }
            }
          }
        }

        /**
         * The one landmark: a shrine at the end of the path. It is scenery, not a
         * control — nothing happens when you reach it, which is the point. Timers
         * live in the chrome, where they can be reached without walking.
         */
        private drawShrine() {
          const x = SHRINE.x * TILE
          const gateY = SHRINE.y * TILE

          this.add
            .image(x, gateY + 2 * TILE, 'garden-shrine-steps')
            .setOrigin(0.5)
            .setDepth(gateY + 31)
          this.add
            .image(x, gateY, 'garden-shrine-gate')
            .setOrigin(0.5, 1)
            .setDepth(gateY + 8)
          this.addBlocker(x - 12, gateY - 8, 8, 24)
          this.addBlocker(x + 12, gateY - 8, 8, 24)

          for (const side of [-1, 1]) {
            this.add
              .image(x + side * 45, gateY + 28, 'garden-shrine-pillar')
              .setOrigin(0.5, 1)
              .setDepth(gateY + 28)
            this.add
              .image(x + side * 42, gateY + 51, 'garden-shrine-wall')
              .setOrigin(0.5)
              .setDepth(gateY + 50)
            this.addBlocker(x + side * 44, gateY + 14, 22, 36)
            this.addFlower(x + side * 62, gateY + 38, side)
          }
        }

        /**
         * Deterministic scenery. A pure function of the tile coordinates, so it
         * needs no storage and lands identically on every device, and it asks the
         * terrain before every placement — ponds and paths move with the seed, so
         * nothing may assume dry open ground.
         */
        private scatterScenery() {
          const solidProps = GARDEN_PROPS.filter((prop) => prop.solid)
          const softProps = GARDEN_PROPS.filter((prop) => !prop.solid)
          for (let y = 3; y < WORLD_H - 3; y += 1) {
            for (let x = 3; x < WORLD_W - 3; x += 1) {
              if (!this.isPlantable(x, y)) continue
              const roll = tileNoise(x, y, 7)
              // Trees mass along the outer margin so the garden reads as enclosed
              // without a fence, and thin out toward the middle.
              const edge = Math.min(x, y, WORLD_W - 1 - x, WORLD_H - 1 - y)
              const treeChance = edge < 6 ? 0.3 : edge < 12 ? 0.06 : 0.012
              if (roll < treeChance) {
                this.addTree(x * TILE, y * TILE, tileNoise(x, y, 11))
                continue
              }
              if (roll < treeChance + 0.02) {
                const prop = solidProps[Math.floor(tileNoise(x, y, 13) * solidProps.length)]
                this.addProp(prop.id, x, y)
                continue
              }
              if (roll < treeChance + 0.07) {
                const prop = softProps[Math.floor(tileNoise(x, y, 17) * softProps.length)]
                this.addProp(prop.id, x, y)
                continue
              }
              if (roll < treeChance + 0.085) {
                this.addFlower(x * TILE, y * TILE, tileNoise(x, y, 19) * 1000)
              }
            }
          }
        }

        /**
         * Whether scenery may stand here. Water, paths and the stone clearing are
         * all refused: a pond cannot hold a tree, and a path that a bush grows in
         * the middle of stops being a path.
         */
        private isPlantable(tileX: number, tileY: number): boolean {
          if (!this.terrain) return false
          const id = tileAt(this.terrain, Math.round(tileX), Math.round(tileY))
          if (id === TERRAIN.WATER || id === TERRAIN.DIRT || id === TERRAIN.STONE) return false
          // Keep the shrine's own clearing readable.
          if (Math.abs(tileX - SHRINE.x) <= 6 && Math.abs(tileY - SHRINE.y) <= 5) return false
          return true
        }

        private addProp(id: string, tileX: number, tileY: number) {
          const def = propDef(id)
          if (!def) return
          const x = tileX * TILE
          const y = tileY * TILE
          this.add.image(x, y, propTextureKey(id)).setOrigin(0.5, 1).setDepth(y)
          if (def.solid) {
            this.addBlocker(
              x,
              y - def.crop.height / 2 + 4,
              def.crop.width * 0.7,
              Math.max(8, def.crop.height * 0.4),
            )
          }
        }

        private addTree(x: number, y: number, roll: number) {
          const wide = roll < 0.5
          const tree = this.add
            .image(x, y, wide ? 'garden-tree-wide' : 'garden-tree-tall')
            .setOrigin(0.5, 1)
            .setDepth(y)
          if (roll > 0.75) tree.setFlipX(true)
          this.addBlocker(x, y - 12, wide ? 48 : 30, 22)
          if (!this.reducedMotion) {
            this.tweens.add({
              targets: tree,
              angle: { from: -0.5, to: 0.5 },
              duration: 1800 + Math.floor(roll * 1000),
              yoyo: true,
              repeat: -1,
              ease: 'Sine.inOut',
            })
          }
          return tree
        }

        private addFlower(x: number, y: number, seed: number) {
          const flower = this.add
            .sprite(x, y, 'garden-flower', Math.abs(Math.round(seed)) % 4)
            .setOrigin(0.5, 1)
            .setDepth(y)
          if (!this.reducedMotion) {
            flower.playAfterDelay('garden-flower-dance', Math.abs(Math.round(seed)) % 900)
            this.tweens.add({
              targets: flower,
              angle: { from: -2, to: 2 },
              duration: 900 + (Math.abs(Math.round(seed)) % 5) * 90,
              yoyo: true,
              repeat: -1,
              ease: 'Sine.inOut',
            })
          }
          return flower
        }

        private addBlocker(x: number, y: number, width: number, height: number) {
          const blocker = this.add.rectangle(x, y, width, height, 0x000000, 0)
          this.blockers.add(blocker)
          return blocker
        }

        private addTileLayer(data: number[][], textureKey: string) {
          const tilemap = this.make.tilemap({ data, tileWidth: TILE, tileHeight: TILE })
          const tiles = tilemap.addTilesetImage(textureKey, textureKey, TILE, TILE)
          if (!tiles) return
          tilemap.createLayer(0, tiles, 0, 0).setDepth(0)
        }

        // --- Texture plumbing ---------------------------------------------

        private makeCuratedTiles() {
          // Ground strip: TERRAIN ids 0..3 from the floor sheet, then the 16
          // water shore cases at index WATER_TILE_BASE + mask. Order here IS the
          // tile index, so it must match lib/garden/terrain.ts.
          this.copyTiles('garden-ground', [
            // 0 grass, 1 tufted grass, 2 dirt path, 3 sand clearing.
            //
            // The path is the *brown* variant of the same patch tile (x + 176 on
            // this sheet), not the salmon one the old village used: a pink road
            // through a green garden read as a mistake.
            ['garden-floor-source', 0, 192],
            ['garden-floor-source', 16, 192],
            ['garden-floor-source', 192, 128],
            ['garden-floor-source', 16, 16],
            // Water, one entry per shore mask, from the grass-shore family whose
            // ring tiles already contain grass pixels — which is why water needs
            // no second layer and no generated masks.
            ...WATER_TILE_OFFSETS.map(
              ([tx, ty]) =>
                [
                  'garden-water-source',
                  WATER_BLOCK_X + tx * TILE,
                  WATER_BLOCK_Y + ty * TILE,
                ] as [string, number, number],
            ),
          ])
          this.copyCrop('garden-tree-wide', 'garden-village', {
            x: 0,
            y: 96,
            width: 64,
            height: 96,
          })
          this.copyCrop('garden-tree-tall', 'garden-village', {
            x: 64,
            y: 96,
            width: 32,
            height: 80,
          })
          // One texture per catalogue entry, so scenery draws from the same crops
          // a decoration palette will later offer.
          for (const prop of GARDEN_PROPS) {
            this.copyCrop(propTextureKey(prop.id), propSheetKey(prop.sheet), prop.crop)
          }
        }

        /**
         * Stitch hand-picked 16px tiles into one horizontal strip usable as a
         * tileset. Each entry carries its own source sheet, so the strip mixes
         * the grass/road family with the water shore family.
         */
        private copyTiles(key: string, sourceTiles: Array<[string, number, number]>) {
          if (this.textures.exists(key)) return
          const texture = this.textures.createCanvas(key, sourceTiles.length * TILE, TILE)
          if (!texture) return
          const context = texture.context
          context.imageSmoothingEnabled = false
          context.clearRect(0, 0, sourceTiles.length * TILE, TILE)
          sourceTiles.forEach(([sourceKey, sourceX, sourceY], index) => {
            const source = this.textures.get(sourceKey).getSourceImage() as CanvasImageSource
            context.drawImage(source, sourceX, sourceY, TILE, TILE, index * TILE, 0, TILE, TILE)
          })
          texture.refresh()
        }

        private copyCrop(key: string, sourceKey: string, crop: AtlasCrop) {
          if (this.textures.exists(key)) return
          const texture = this.textures.createCanvas(key, crop.width, crop.height)
          if (!texture) return
          const context = texture.context
          const source = this.textures.get(sourceKey).getSourceImage() as CanvasImageSource
          context.imageSmoothingEnabled = false
          context.clearRect(0, 0, crop.width, crop.height)
          context.drawImage(
            source,
            crop.x,
            crop.y,
            crop.width,
            crop.height,
            0,
            0,
            crop.width,
            crop.height,
          )
          texture.refresh()
        }

        private createAnimations() {
          if (this.anims.exists('garden-flower-dance')) return
          this.anims.create({
            key: 'garden-flower-dance',
            frames: this.anims.generateFrameNumbers('garden-flower', { start: 0, end: 3 }),
            frameRate: 3.5,
            repeat: -1,
            yoyo: true,
          })
        }
      }

      game = new Phaser.Game({
        type: Phaser.AUTO,
        parent: host,
        canvasStyle:
          'display:block;width:100%;height:100%;image-rendering:pixelated;image-rendering:crisp-edges',
        backgroundColor: inkCss,
        antialias: false,
        pixelArt: true,
        roundPixels: true,
        scene: GardenScene,
        physics: {
          default: 'arcade',
          arcade: { gravity: { x: 0, y: 0 }, debug: false },
        },
        scale: {
          mode: Phaser.Scale.NONE,
          width: Math.max(1, Math.round(host.clientWidth * renderScale)),
          height: Math.max(1, Math.round(host.clientHeight * renderScale)),
        },
        render: { antialias: false, pixelArt: true, roundPixels: true },
      })
      resizeObserver = new ResizeObserver(() => {
        if (!game) return
        const width = Math.max(1, Math.round(host.clientWidth * renderScale))
        const height = Math.max(1, Math.round(host.clientHeight * renderScale))
        if (game.scale.width === width && game.scale.height === height) return
        game.scale.resize(width, height)
      })
      resizeObserver.observe(host)
    })()

    return () => {
      disposed = true
      resizeObserver?.disconnect()
      unsubscribe?.()
      game?.destroy(true)
      host.replaceChildren()
    }
  }, [themeRevision])

  return (
    <div
      ref={hostRef}
      className="h-full w-full bg-ink [&>canvas]:block"
      role="application"
      aria-label="Your garden. Use arrow keys or WASD to walk, Space to jump, tap to choose a spot, T for the focus timer, Escape to leave."
    />
  )
}
