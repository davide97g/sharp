import { useEffect, useRef, useState } from 'react'
import type { GardenMap, GardenPeer, GardenRoom } from '../../lib/types'
import { sound } from '../../lib/sound'
import { useStore } from '../../store'
import {
  AVATAR_IDS,
  avatarSheetUrl,
  avatarTextureKey,
  resolveAvatarId,
} from './gardenAvatars'

const TILE = 16
const SPEED = 7
const SEND_EVERY_MS = 100
const UI_FONT = 'Inter, ui-sans-serif, system-ui, sans-serif'
const ASSET_ROOT = '/assets/garden/ninja-adventure'
const TEMPLE_ASSET_ROOT = '/assets/garden/feudal-japan'
const DIRECTION_COLUMN: Record<GardenPeer['facing'], number> = {
  down: 0,
  up: 1,
  left: 2,
  right: 3,
}

type Props = {
  map: GardenMap
  space: 'hub' | 'room'
  channelId: string | null
  zenMode: boolean
  onNearbyRoom: (room: GardenRoom | null) => void
  onNearbyTemple: (nearby: boolean) => void
}

type Point = { x: number; y: number }

/** What an avatar needs to know about who it represents. */
type AvatarIdentity = {
  userId: string
  name: string
  /** The roster id this person chose, or null if they never picked one. */
  avatarId: string | null
}

let pendingTeleportRoomId: string | null = null

function labelFor(name: string) {
  return name.length > 20 ? `${name.slice(0, 19)}…` : name
}

function hashName(name: string) {
  let value = 0
  for (let index = 0; index < name.length; index += 1) {
    value = (value * 31 + name.charCodeAt(index)) >>> 0
  }
  return value
}

export function GardenGame({
  map,
  space,
  channelId,
  zenMode,
  onNearbyRoom,
  onNearbyTemple,
}: Props) {
  const hostRef = useRef<HTMLDivElement>(null)
  const nearbyRef = useRef(onNearbyRoom)
  const nearbyTempleRef = useRef(onNearbyTemple)
  const [themeRevision, setThemeRevision] = useState(0)
  nearbyRef.current = onNearbyRoom
  nearbyTempleRef.current = onNearbyTemple

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
      const numeric = (token: string) => Number.parseInt(css(token).replace('#', ''), 16)
      const palette = {
        ink: numeric('--color-ink'),
        panel: numeric('--color-panel'),
        border: numeric('--color-border'),
        accent: numeric('--color-accent'),
        accentSoft: numeric('--color-accent-soft'),
        text: numeric('--color-text'),
        success: numeric('--color-presence-online'),
      }
      const inkCss = css('--color-ink')
      const panelCss = css('--color-panel')
      const textCss = css('--color-text')
      const textDimCss = css('--color-text-dim')

      type Avatar = {
        node: import('phaser').GameObjects.Container
        sprite: import('phaser').GameObjects.Sprite
        shadow: import('phaser').GameObjects.Image
        halo: import('phaser').GameObjects.Ellipse
        presence: import('phaser').GameObjects.Arc
        label: import('phaser').GameObjects.Text
        name: string
        targetX: number
        targetY: number
        moving: boolean
        facing: GardenPeer['facing']
        idlePhase: number
        jumpHeight: number
        airOffset: number
        jumping: boolean
        teleporting: boolean
        zen: boolean
      }

      type AtlasCrop = {
        x: number
        y: number
        width: number
        height: number
      }

      class GardenScene extends Phaser.Scene {
        private player!: Avatar
        private remotes = new Map<string, Avatar>()
        private cursors!: import('phaser').Types.Input.Keyboard.CursorKeys
        private wasd!: Record<'W' | 'A' | 'S' | 'D', import('phaser').Input.Keyboard.Key>
        private jumpKey!: import('phaser').Input.Keyboard.Key
        private blockers!: import('phaser').Physics.Arcade.StaticGroup
        private target: Point | null = null
        private waypoints: Point[] = []
        private seq = useStore.getState().garden.self?.seq ?? 0
        private lastSent = 0
        private wasMoving = false
        private lastFacing: GardenPeer['facing'] = 'down'
        private nearbyId: string | null = null
        private templeNearby = false
        private worldWidth = 0
        private worldHeight = 0
        private lastStep = 0
        private lastBump = 0
        private reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches

        constructor() {
          super('garden')
        }

        preload() {
          this.load.image('garden-floor-source', `${ASSET_ROOT}/tileset_floor.png`)
          this.load.image(
            'garden-interior-source',
            `${ASSET_ROOT}/tileset_interior_floor.png`,
          )
          this.load.image('garden-village', `${ASSET_ROOT}/tileset_village.png`)
          this.load.image('garden-shadow', `${ASSET_ROOT}/avatar_shadow.png`)
          this.load.image('garden-crate', `${ASSET_ROOT}/crate.png`)
          this.load.image('garden-pot', `${ASSET_ROOT}/pot.png`)
          this.load.image('garden-temple-gate', `${TEMPLE_ASSET_ROOT}/wooden_gate.png`)
          this.load.image('garden-temple-steps', `${TEMPLE_ASSET_ROOT}/stone_steps.png`)
          this.load.image('garden-temple-pillar', `${TEMPLE_ASSET_ROOT}/temple_pillar.png`)
          this.load.image('garden-shrine-wall', `${TEMPLE_ASSET_ROOT}/shrine_wall.png`)
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

          const self = useStore.getState().garden.self
          const startX = zenMode ? 16 * TILE : (self?.x ?? map.spawn.x) * TILE
          const startY = zenMode ? 19 * TILE : (self?.y ?? map.spawn.y) * TILE
          const me = useStore.getState().me
          this.player = this.makeAvatar(
            startX,
            startY,
            {
              userId: me?.id ?? '',
              name: me?.display_name ?? 'You',
              avatarId: self?.avatar ?? null,
            },
            true,
            zenMode,
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
          this.jumpKey = this.input.keyboard!.addKey(
            Phaser.Input.Keyboard.KeyCodes.SPACE,
          )
          this.input.on('pointerdown', (pointer: import('phaser').Input.Pointer) => {
            this.waypoints = []
            this.target = { x: pointer.worldX, y: pointer.worldY }
          })
          const routeToPlaza = () => {
            const plaza = { x: 52 * TILE, y: 64 * TILE }
            const playerY = this.player.node.y / TILE
            if (Math.hypot(this.player.node.x / TILE - 52, playerY - 64) < 3) {
              return [plaza]
            }
            if (playerY > 66) return [plaza]
            const roomRows = [...new Set(map.rooms.map((room) => room.door_y))]
            if (roomRows.length === 0) return [plaza]
            const nearestRow = roomRows.reduce((nearest, candidate) =>
              Math.abs(candidate - playerY) < Math.abs(nearest - playerY)
                ? candidate
                : nearest,
            )
            // Houses occupy the area north of each doorway. First step into
            // the clear band south of the row, then cross to the central path.
            const safeY = (nearestRow + 4) * TILE
            return [
              { x: this.player.node.x, y: safeY },
              { x: plaza.x, y: safeY },
              plaza,
            ]
          }
          const walkToRoom = (event: Event) => {
            if (zenMode || space !== 'hub') return
            const room = (event as CustomEvent<GardenRoom>).detail
            const safeY = (room.door_y + 4) * TILE
            const central = { x: 52 * TILE, y: safeY }
            const elbow = { x: room.door_x * TILE, y: safeY }
            const door = { x: room.door_x * TILE, y: room.door_y * TILE }
            this.waypoints = [...routeToPlaza(), central, elbow, door].filter(
              (point, index, points) =>
                index === 0 ||
                point.x !== points[index - 1].x ||
                point.y !== points[index - 1].y,
            )
            this.target = this.waypoints.shift() ?? null
          }
          const teleportToRoom = (event: Event) => {
            const room = (event as CustomEvent<GardenRoom>).detail
            this.startTeleport(room)
          }
          const teleportToTemple = () => this.startTempleTeleport()
          window.addEventListener('sharp:garden-walk-to', walkToRoom)
          window.addEventListener('sharp:garden-teleport', teleportToRoom)
          window.addEventListener('sharp:garden-teleport-temple', teleportToTemple)
          this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
            window.removeEventListener('sharp:garden-walk-to', walkToRoom)
            window.removeEventListener('sharp:garden-teleport', teleportToRoom)
            window.removeEventListener('sharp:garden-teleport-temple', teleportToTemple)
          })

          this.cameras.main.setBounds(0, 0, this.worldWidth, this.worldHeight)
          this.cameras.main.startFollow(this.player.node, true, 0.12, 0.12)
          const setZoom = () => {
            const logicalWidth = this.scale.width / renderScale
            const logicalZoom = logicalWidth < 620 ? 1 : 2
            this.cameras.main.setZoom(logicalZoom * renderScale)
          }
          this.scale.on('resize', setZoom)
          setZoom()
          if (
            pendingTeleportRoomId &&
            space === 'room' &&
            channelId === pendingTeleportRoomId
          ) {
            pendingTeleportRoomId = null
            this.playTeleportArrival()
          }

          let lastPeers: ReturnType<typeof useStore.getState>['garden']['peers'] | null = null
          const sync = (state: ReturnType<typeof useStore.getState>) => {
            if (state.garden.peers !== lastPeers) {
              lastPeers = state.garden.peers
              const present = new Set<string>()
              for (const [connId, peer] of Object.entries(state.garden.peers)) {
                if (
                  peer.space !== space ||
                  (space === 'room' && peer.channel_id !== channelId)
                ) {
                  continue
                }
                present.add(connId)
                let avatar = this.remotes.get(connId)
                if (!avatar) {
                  avatar = this.makeAvatar(
                    peer.x * TILE,
                    peer.y * TILE,
                    {
                      userId: peer.user_id,
                      name: peer.display_name,
                      avatarId: peer.avatar ?? null,
                    },
                    false,
                    peer.zen_mode,
                  )
                  this.remotes.set(connId, avatar)
                }
                avatar.targetX = peer.x * TILE
                avatar.targetY = peer.y * TILE
                avatar.moving = peer.moving
                this.faceAvatar(avatar, peer.facing)
                this.setAvatarZen(avatar, peer.zen_mode)
              }
              for (const [connId, avatar] of this.remotes) {
                if (present.has(connId)) continue
                avatar.node.destroy(true)
                this.remotes.delete(connId)
              }
            }

            const authoritative = state.garden.self
            if (authoritative && this.player && !zenMode) {
              const dx = authoritative.x * TILE - this.player.node.x
              const dy = authoritative.y * TILE - this.player.node.y
              if (Math.hypot(dx, dy) > TILE * 2.25) {
                this.player.node.setPosition(
                  authoritative.x * TILE,
                  authoritative.y * TILE,
                )
                const playerBody = this.player.node.body as import(
                  'phaser'
                ).Physics.Arcade.Body
                playerBody.reset(authoritative.x * TILE, authoritative.y * TILE)
                this.target = null
              }
              this.seq = Math.max(this.seq, authoritative.seq)
            }
          }
          sync(useStore.getState())
          unsubscribe = useStore.subscribe(sync)
        }

        update(time: number, delta: number) {
          if (!this.player) return
          const activeElement = document.activeElement
          const typing =
            activeElement instanceof HTMLInputElement ||
            activeElement instanceof HTMLTextAreaElement ||
            activeElement?.getAttribute('contenteditable') === 'true'
          let dx = 0
          let dy = 0
          if (
            !typing &&
            !this.player.teleporting &&
            Phaser.Input.Keyboard.JustDown(this.jumpKey)
          ) {
            this.startJump(this.player)
          }
          if (!typing && !this.player.teleporting) {
            if (this.cursors.left.isDown || this.wasd.A.isDown) dx -= 1
            if (this.cursors.right.isDown || this.wasd.D.isDown) dx += 1
            if (this.cursors.up.isDown || this.wasd.W.isDown) dy -= 1
            if (this.cursors.down.isDown || this.wasd.S.isDown) dy += 1
          }
          if (dx || dy) {
            this.target = null
            this.waypoints = []
          }
          if (!dx && !dy && this.target) {
            const tx = this.target.x - this.player.node.x
            const ty = this.target.y - this.player.node.y
            if (Math.hypot(tx, ty) < 5) {
              this.target = this.waypoints.shift() ?? null
            }
            else {
              dx = tx
              dy = ty
            }
          }

          let facing = this.player.facing
          const moving = dx !== 0 || dy !== 0
          const body = this.player.node.body as import('phaser').Physics.Arcade.Body
          if (moving && !this.player.teleporting) {
            const length = Math.hypot(dx, dy)
            dx /= length
            dy /= length
            body.setVelocity(dx * SPEED * TILE, dy * SPEED * TILE)
            facing =
              Math.abs(dx) > Math.abs(dy)
                ? dx < 0
                  ? 'left'
                  : 'right'
                : dy < 0
                  ? 'up'
                  : 'down'
            this.faceAvatar(this.player, facing)
          } else {
            body.setVelocity(0, 0)
          }
          const colliding =
            moving && (!body.blocked.none || !body.touching.none)
          if (colliding && time - this.lastBump > 320) {
            this.lastBump = time
            sound.garden.bump()
          } else if (moving && time - this.lastStep > 215) {
            this.lastStep = time
            sound.garden.step()
          }
          if (
            this.target &&
            (!body.blocked.none || (!body.touching.none && moving))
          ) {
            this.target = null
            this.waypoints = []
          }

          this.player.moving = moving && !this.player.teleporting
          this.animateAvatar(this.player, time)
          this.player.node.setDepth(this.player.node.y + 100)

          const now = performance.now()
          if (
            !zenMode &&
            now - this.lastSent >= SEND_EVERY_MS &&
            (moving || this.wasMoving || facing !== this.lastFacing)
          ) {
            this.lastSent = now
            this.seq += 1
            useStore
              .getState()
              .moveGarden(
                this.seq,
                this.player.node.x / TILE,
                this.player.node.y / TILE,
                facing,
              )
          }
          this.wasMoving = moving
          this.lastFacing = facing

          for (const avatar of this.remotes.values()) {
            const factor = this.reducedMotion ? 1 : Math.min(1, delta / 95)
            avatar.node.x = Phaser.Math.Linear(avatar.node.x, avatar.targetX, factor)
            avatar.node.y = Phaser.Math.Linear(avatar.node.y, avatar.targetY, factor)
            this.animateAvatar(avatar, time)
            avatar.node.setDepth(avatar.node.y + 100)
          }
          this.updateNearby()
        }

        private startJump(avatar: Avatar) {
          if (avatar.jumping || avatar.teleporting) return
          avatar.jumping = true
          sound.garden.jump()
          if (this.reducedMotion) {
            avatar.jumpHeight = 4
            this.time.delayedCall(90, () => {
              avatar.jumpHeight = 0
              avatar.jumping = false
              sound.garden.land()
            })
            return
          }
          this.tweens.add({
            targets: avatar,
            jumpHeight: 19,
            duration: 220,
            ease: 'Sine.out',
            yoyo: true,
            onComplete: () => {
              avatar.jumpHeight = 0
              avatar.jumping = false
              avatar.sprite.setScale(1)
              sound.garden.land()
              this.addLandingDust(avatar.node.x, avatar.node.y)
            },
          })
          this.tweens.add({
            targets: avatar.sprite,
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

        private startTeleport(room: GardenRoom) {
          if (this.player.teleporting) return
          this.player.teleporting = true
          this.target = null
          this.waypoints = []
          const body = this.player.node.body as import('phaser').Physics.Arcade.Body
          body.setVelocity(0, 0)
          sound.garden.teleport()

          const commit = () => {
            pendingTeleportRoomId = room.channel_id
            void useStore
              .getState()
              .teleportGardenRoom(room.channel_id)
              .catch(() => {
                pendingTeleportRoomId = null
                this.player.teleporting = false
                this.player.airOffset = 0
                this.player.sprite.setAngle(0)
                this.cameras.main.fadeIn(180, 0, 0, 0)
              })
          }
          if (this.reducedMotion) {
            this.cameras.main.fadeOut(120, 0, 0, 0)
            window.setTimeout(commit, 120)
            return
          }
          this.tweens.add({
            targets: this.player,
            airOffset: 84,
            duration: 520,
            ease: 'Cubic.in',
          })
          this.tweens.add({
            targets: this.player.sprite,
            angle: 720,
            duration: 520,
            ease: 'Cubic.in',
          })
          this.tweens.add({
            targets: this.player.shadow,
            alpha: 0,
            scale: 0.08,
            duration: 500,
            ease: 'Cubic.in',
          })
          window.setTimeout(() => {
            if (this.scene.isActive()) this.cameras.main.fadeOut(280, 0, 0, 0)
          }, 260)
          window.setTimeout(commit, 545)
        }

        private startTempleTeleport() {
          if (space !== 'hub' || zenMode || this.player.teleporting) return
          this.player.teleporting = true
          this.target = null
          this.waypoints = []
          const body = this.player.node.body as import('phaser').Physics.Arcade.Body
          body.setVelocity(0, 0)
          sound.garden.teleport()

          const commit = () => {
            let completed = false
            const finish = () => {
              if (completed) return
              completed = true
              unsubscribe()
              const self = useStore.getState().garden.self
              if (self) {
                this.player.node.setPosition(self.x * TILE, self.y * TILE)
                body.reset(self.x * TILE, self.y * TILE)
              }
              this.playTeleportArrival()
            }
            const unsubscribe = useStore.subscribe((state) => {
              const self = state.garden.self
              if (
                self &&
                Math.hypot(self.x - map.temple.x, self.y - map.temple.y) <= 4.5
              ) {
                finish()
              }
            })
            useStore.getState().teleportGardenTemple()
            window.setTimeout(() => {
              if (completed) return
              unsubscribe()
              this.player.teleporting = false
              this.player.airOffset = 0
              this.player.sprite.setAngle(0)
              this.cameras.main.fadeIn(180, 0, 0, 0)
            }, 1800)
          }

          if (this.reducedMotion) {
            this.cameras.main.fadeOut(120, 0, 0, 0)
            window.setTimeout(commit, 120)
            return
          }
          this.tweens.add({
            targets: this.player,
            airOffset: 84,
            duration: 520,
            ease: 'Cubic.in',
          })
          this.tweens.add({
            targets: this.player.sprite,
            angle: 720,
            duration: 520,
            ease: 'Cubic.in',
          })
          this.tweens.add({
            targets: this.player.shadow,
            alpha: 0,
            scale: 0.08,
            duration: 500,
            ease: 'Cubic.in',
          })
          window.setTimeout(() => {
            if (this.scene.isActive()) this.cameras.main.fadeOut(280, 0, 0, 0)
          }, 260)
          window.setTimeout(commit, 545)
        }

        private playTeleportArrival() {
          this.player.teleporting = true
          this.cameras.main.fadeIn(this.reducedMotion ? 120 : 420, 0, 0, 0)
          sound.garden.teleport()
          if (this.reducedMotion) {
            this.player.teleporting = false
            return
          }
          this.player.airOffset = 84
          this.player.sprite.setAngle(-720)
          this.player.shadow.setAlpha(0).setScale(0.08)
          this.tweens.add({
            targets: this.player,
            airOffset: 0,
            duration: 640,
            ease: 'Cubic.out',
            onComplete: () => {
              this.player.teleporting = false
              this.player.sprite.setAngle(0)
              sound.garden.land()
              this.addLandingDust(this.player.node.x, this.player.node.y)
            },
          })
          this.tweens.add({
            targets: this.player.sprite,
            angle: 0,
            duration: 640,
            ease: 'Cubic.out',
          })
          this.tweens.add({
            targets: this.player.shadow,
            alpha: 0.7,
            scale: 1,
            duration: 600,
            ease: 'Cubic.out',
          })
        }

        private makeCuratedTiles() {
          this.copyTiles('garden-ground', 'garden-floor-source', [
            [0, 192],
            [16, 192],
            [16, 128],
            [80, 128],
          ])
          this.copyTiles('garden-interior-ground', 'garden-interior-source', [
            [32, 32],
            [48, 32],
            [64, 32],
            [80, 32],
          ])
          this.copyCrop('garden-house-small', 'garden-village', {
            x: 256,
            y: 96,
            width: 64,
            height: 64,
          })
          this.copyCrop('garden-house-large', 'garden-village', {
            x: 176,
            y: 96,
            width: 80,
            height: 80,
          })
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
          this.copyCrop('garden-tree-round', 'garden-village', {
            x: 272,
            y: 0,
            width: 48,
            height: 48,
          })
        }

        private copyTiles(
          key: string,
          sourceKey: string,
          sourceTiles: Array<[number, number]>,
        ) {
          if (this.textures.exists(key)) return
          const texture = this.textures.createCanvas(key, sourceTiles.length * TILE, TILE)
          if (!texture) return
          const context = texture.context
          const source = this.textures.get(sourceKey).getSourceImage() as CanvasImageSource
          context.imageSmoothingEnabled = false
          context.clearRect(0, 0, sourceTiles.length * TILE, TILE)
          sourceTiles.forEach(([sourceX, sourceY], index) => {
            context.drawImage(
              source,
              sourceX,
              sourceY,
              TILE,
              TILE,
              index * TILE,
              0,
              TILE,
              TILE,
            )
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
          if (!this.anims.exists('garden-flower-dance')) {
            this.anims.create({
              key: 'garden-flower-dance',
              frames: this.anims.generateFrameNumbers('garden-flower', {
                start: 0,
                end: 3,
              }),
              frameRate: 3.5,
              repeat: -1,
              yoyo: true,
            })
          }
        }

        private updateNearby() {
          if (space !== 'hub' || zenMode) {
            if (this.nearbyId !== null) {
              this.nearbyId = null
              nearbyRef.current(null)
            }
            if (this.templeNearby) {
              this.templeNearby = false
              nearbyTempleRef.current(false)
            }
            return
          }
          let nearest: GardenRoom | null = null
          let distance = Number.POSITIVE_INFINITY
          const x = this.player.node.x / TILE
          const y = this.player.node.y / TILE
          for (const room of map.rooms) {
            const current = Math.hypot(x - room.door_x, y - room.door_y)
            if (current < distance && current <= 4.5) {
              distance = current
              nearest = room
            }
          }
          const nextId = nearest?.channel_id ?? null
          if (nextId !== this.nearbyId) {
            this.nearbyId = nextId
            nearbyRef.current(nearest)
          }

          const atTemple =
            Math.hypot(x - map.temple.x, y - map.temple.y) <= 4.5
          if (atTemple !== this.templeNearby) {
            this.templeNearby = atTemple
            nearbyTempleRef.current(atTemple)
          }
        }

        private makeAvatar(
          x: number,
          y: number,
          identity: AvatarIdentity,
          self: boolean,
          zen = false,
        ): Avatar {
          const { name, userId } = identity
          // Honour the peer's chosen character, else fall back deterministically
          // from the immutable user id. Previously this hashed the *display
          // name* and forced the local player to one sheet, so a rename changed
          // your character and same-named users looked identical.
          const texture = avatarTextureKey(resolveAvatarId(identity.avatarId, userId))
          const shadow = this.add.image(0, 1, 'garden-shadow').setAlpha(0.7)
          const halo = this.add
            .ellipse(0, -1, 28, 17, palette.accent, self ? 0.15 : 0)
            .setStrokeStyle(self ? 1 : 0, palette.accent, self ? 0.8 : 0)
          const sprite = this.add.sprite(0, -8, texture, DIRECTION_COLUMN.down)
          const presence = this.add
            .circle(11, -6, 3, palette.success)
            .setStrokeStyle(1, palette.panel)
          const label = this.add
            .text(0, -35, self ? 'You' : labelFor(name), {
              fontFamily: UI_FONT,
              fontSize: '8px',
              fontStyle: '600',
              color: textCss,
              backgroundColor: panelCss,
              padding: { x: 5, y: 3 },
              resolution: renderScale,
            })
            .setOrigin(0.5)
          const node = this.add.container(x, y, [halo, shadow, sprite, presence, label])
          node.setDepth(y + 100)
          const avatar: Avatar = {
            node,
            sprite,
            shadow,
            halo,
            presence,
            label,
            name: self ? 'You' : labelFor(name),
            targetX: x,
            targetY: y,
            moving: false,
            facing: 'down',
            // Desync the idle bob per person, keyed on the stable id so a rename
            // does not visibly re-sync everyone.
            idlePhase: hashName(userId) % 1000,
            jumpHeight: 0,
            airOffset: 0,
            jumping: false,
            teleporting: false,
            zen,
          }
          this.setAvatarZen(avatar, zen)
          return avatar
        }

        private setAvatarZen(avatar: Avatar, zen: boolean) {
          if (avatar.zen === zen && avatar.label.text.startsWith('ZEN') === zen) return
          avatar.zen = zen
          avatar.label.setText(zen ? `ZEN · ${avatar.name}` : avatar.name)
          avatar.halo
            .setFillStyle(zen ? 0x9fca78 : palette.accent, zen ? 0.22 : 0.15)
            .setStrokeStyle(1, zen ? 0xd7efb5 : palette.accent, 0.85)
        }

        private faceAvatar(avatar: Avatar, facing: GardenPeer['facing']) {
          avatar.facing = facing
          if (!avatar.moving) avatar.sprite.setFrame(DIRECTION_COLUMN[facing])
        }

        private animateAvatar(avatar: Avatar, time: number) {
          const column = DIRECTION_COLUMN[avatar.facing]
          const lift = avatar.jumpHeight + avatar.airOffset
          avatar.shadow
            .setScale(Math.max(0.2, 1 - lift / 110))
            .setAlpha(Math.max(0.08, 0.7 - lift / 150))
          avatar.label.y = -35 - lift
          avatar.presence.y = -6 - lift
          avatar.halo.y = -1
          if (avatar.moving) {
            const row = this.reducedMotion ? 1 : Math.floor(time / 135) % 4
            avatar.sprite.setFrame(row * 4 + column)
            avatar.sprite.y = -8 - lift
            return
          }
          avatar.sprite.setFrame(column)
          avatar.sprite.y = this.reducedMotion
            ? -8 - lift
            : -8 - lift + Math.round(Math.sin((time + avatar.idlePhase) / 650))
        }

        private drawWorld() {
          if (zenMode) this.drawZenInterior()
          else if (space === 'room') this.drawInterior()
          else this.drawHub()
        }

        private drawHub() {
          const maxDoorY = Math.max(
            map.temple.y + 12,
            78,
            ...map.rooms.map((room) => room.door_y),
          )
          const widthInTiles = 104
          const heightInTiles = Math.max(96, Math.ceil(maxDoorY + 16))
          this.worldWidth = widthInTiles * TILE
          this.worldHeight = heightInTiles * TILE

          const data = Array.from({ length: heightInTiles }, (_, y) =>
            Array.from({ length: widthInTiles }, (_, x) =>
              (x * 13 + y * 7) % 17 === 0 ? 1 : 0,
            ),
          )
          const plaza = { x: 52, y: 64 }
          this.paintRect(data, plaza.x - 6, plaza.y - 4, 13, 9, 3)
          this.paintRect(
            data,
            Math.round(map.temple.x) - 1,
            plaza.y,
            3,
            Math.round(map.temple.y) - plaza.y + 9,
            2,
          )
          for (const room of map.rooms) {
            const doorX = Math.round(room.door_x)
            const doorY = Math.round(room.door_y)
            this.paintRect(
              data,
              doorX - 1,
              Math.min(doorY, plaza.y),
              3,
              Math.abs(plaza.y - doorY) + 1,
              2,
            )
            this.paintRect(
              data,
              Math.min(doorX, plaza.x),
              plaza.y - 1,
              Math.abs(plaza.x - doorX) + 1,
              3,
              2,
            )
          }
          this.addTileLayer(data, 'garden-ground')

          map.rooms.forEach((room) => this.drawHouse(room))
          this.drawTemple()
          // Keep the central path clear: the sign sits inside the plaza, above the
          // horizontal guide lane, so both manual and guided walks can pass it.
          this.drawCourtyard((plaza.x - 3) * TILE, (plaza.y - 3) * TILE)
          this.drawGardenEdges(heightInTiles)
          this.drawFlowerBeds()
        }

        private drawTemple() {
          const x = map.temple.x * TILE
          const gateY = map.temple.y * TILE
          const houseY = gateY + 8 * TILE

          this.add
            .image(x, houseY, 'garden-house-large')
            .setOrigin(0.5, 1)
            .setTint(0xc3d99a)
            .setDepth(houseY - 5)
          this.addBlocker(x, houseY - 36, 61, 48)

          this.add
            .image(x, gateY + 2 * TILE, 'garden-temple-steps')
            .setOrigin(0.5)
            .setDepth(gateY + 31)
          this.add
            .image(x, gateY, 'garden-temple-gate')
            .setOrigin(0.5, 1)
            .setDepth(gateY + 8)
          this.addBlocker(x - 12, gateY - 8, 8, 24)
          this.addBlocker(x + 12, gateY - 8, 8, 24)

          for (const side of [-1, 1]) {
            this.add
              .image(x + side * 45, gateY + 28, 'garden-temple-pillar')
              .setOrigin(0.5, 1)
              .setDepth(gateY + 28)
            this.add
              .image(x + side * 42, gateY + 51, 'garden-shrine-wall')
              .setOrigin(0.5)
              .setDepth(gateY + 50)
            this.addBlocker(x + side * 44, gateY + 14, 22, 36)
          }

          this.add
            .text(x, gateY - 47, 'ZEN TEMPLE', {
              fontFamily: UI_FONT,
              fontSize: '8px',
              fontStyle: '700',
              color: '#f3f5ec',
              backgroundColor: '#171914',
              padding: { x: 7, y: 4 },
              resolution: renderScale,
            })
            .setOrigin(0.5)
            .setDepth(gateY + 60)
          this.addFlower(x - 62, gateY + 38, 818)
          this.addFlower(x + 62, gateY + 38, 919)
        }

        private paintRect(
          data: number[][],
          left: number,
          top: number,
          width: number,
          height: number,
          tile: number,
        ) {
          for (let y = Math.max(0, top); y < Math.min(data.length, top + height); y += 1) {
            for (
              let x = Math.max(0, left);
              x < Math.min(data[y].length, left + width);
              x += 1
            ) {
              data[y][x] = tile
            }
          }
        }

        private addTileLayer(data: number[][], textureKey: string) {
          const tilemap = this.make.tilemap({
            data,
            tileWidth: TILE,
            tileHeight: TILE,
          })
          const tiles = tilemap.addTilesetImage(textureKey, textureKey, TILE, TILE)
          if (!tiles) return
          tilemap.createLayer(0, tiles, 0, 0).setDepth(0)
        }

        private drawCourtyard(x: number, y: number) {
          const sign = this.add.graphics().setDepth(y + 3)
          sign.fillStyle(0x6a3b2b).fillRect(x - 19, y - 19, 38, 22)
          sign.fillStyle(0xd7a65a).fillRect(x - 17, y - 17, 34, 16)
          sign.fillStyle(0x4c281f).fillRect(x - 2, y + 3, 4, 18)
          sign.fillStyle(0x291b18).fillRect(x - 16, y - 16, 32, 2)
          this.add
            .text(x, y - 9, 'GARDEN', {
              fontFamily: 'monospace',
              fontSize: '7px',
              fontStyle: '700',
              color: '#3b241a',
              resolution: renderScale,
            })
            .setOrigin(0.5)
            .setDepth(y + 4)
          this.addBlocker(x, y - 5, 34, 20)
        }

        private drawHouse(room: GardenRoom) {
          const x = room.door_x * TILE
          const y = room.door_y * TILE
          const crops: Record<GardenRoom['room_variant'], AtlasCrop> = {
            meadow: { x: 256, y: 96, width: 64, height: 64 },
            pond: { x: 176, y: 96, width: 80, height: 80 },
            orchard: { x: 256, y: 96, width: 64, height: 64 },
            greenhouse: { x: 176, y: 96, width: 80, height: 80 },
          }
          const crop = crops[room.room_variant]
          const texture =
            crop.width === 80 ? 'garden-house-large' : 'garden-house-small'
          const house = this.add
            .image(x, y, texture)
            .setOrigin(0.5, 1)
            .setDepth(y - 4)
          if (room.room_variant === 'orchard') house.setFlipX(true)
          if (room.room_variant === 'greenhouse') house.setTint(0xcaf1a4)

          const visualWidth = crop.width
          const visualHeight = crop.height
          this.addBlocker(
            x,
            y - visualHeight / 2 + 4,
            visualWidth * 0.76,
            visualHeight - 32,
          )

          const label = this.add
            .text(x, y - visualHeight - 13, labelFor(room.name), {
              fontFamily: UI_FONT,
              fontSize: '8px',
              fontStyle: '700',
              color: textCss,
              backgroundColor: panelCss,
              padding: { x: 7, y: 4 },
              resolution: renderScale,
            })
            .setOrigin(0.5)
            .setDepth(y + 6)
          if (room.kind === 'private') label.setText(`◆ ${labelFor(room.name)}`)

          if (room.occupancy > 0) {
            this.add
              .circle(x + visualWidth * 0.38, y - visualHeight + 4, 8, palette.accent)
              .setDepth(y + 7)
            this.add
              .text(
                x + visualWidth * 0.38,
                y - visualHeight + 4,
                String(room.occupancy),
                {
                  fontFamily: UI_FONT,
                  fontSize: '8px',
                  fontStyle: '700',
                  color: inkCss,
                  resolution: renderScale,
                },
              )
              .setOrigin(0.5)
              .setDepth(y + 8)
          }

          const side = room.plot_index % 2 === 0 ? -1 : 1
          this.addTree(x + side * (visualWidth / 2 + 31), y + 14, room.plot_index)
          this.addFlower(x - side * 47, y + 18, room.plot_index * 97)
          this.addFlower(x - side * 64, y + 12, room.plot_index * 131)
        }

        private drawGardenEdges(heightInTiles: number) {
          for (let y = 8; y < heightInTiles - 4; y += 10) {
            this.addTree(4 * TILE, y * TILE, y)
            this.addTree(100 * TILE, (y + 4) * TILE, y + 1)
          }
          for (let x = 11; x < 98; x += 13) {
            this.addTree(x * TILE, 4 * TILE, x)
            this.addTree((x + 5) * TILE, (heightInTiles - 3) * TILE, x + 1)
          }
        }

        private drawFlowerBeds() {
          const positions: Array<[number, number]> = [
            [44, 59],
            [47, 58],
            [57, 58],
            [60, 59],
            [45, 69],
            [48, 70],
            [56, 70],
            [59, 69],
            [8, 58],
            [95, 48],
            [91, 72],
          ]
          positions.forEach(([x, y], index) => {
            this.addFlower(x * TILE, y * TILE, index * 173)
          })
        }

        private addTree(x: number, y: number, seed: number) {
          const crops: AtlasCrop[] = [
            { x: 0, y: 96, width: 64, height: 96 },
            { x: 64, y: 96, width: 32, height: 80 },
            { x: 272, y: 0, width: 48, height: 48 },
          ]
          const cropIndex = Math.abs(seed) % crops.length
          const crop = crops[cropIndex]
          const textures = ['garden-tree-wide', 'garden-tree-tall', 'garden-tree-round']
          const tree = this.add
            .image(x, y, textures[cropIndex])
            .setOrigin(0.5, 1)
            .setDepth(y)
          this.addBlocker(x, y - 12, Math.min(crop.width * 1.2, 48), 22)
          if (!this.reducedMotion) {
            this.tweens.add({
              targets: tree,
              angle: { from: -0.5, to: 0.5 },
              duration: 1800 + (Math.abs(seed) % 4) * 260,
              yoyo: true,
              repeat: -1,
              ease: 'Sine.inOut',
            })
          }
          return tree
        }

        private addFlower(x: number, y: number, seed: number) {
          const flower = this.add
            .sprite(x, y, 'garden-flower', Math.abs(seed) % 4)
            .setOrigin(0.5, 1)
            .setDepth(y)
          if (!this.reducedMotion) {
            flower.playAfterDelay('garden-flower-dance', Math.abs(seed) % 900)
            this.tweens.add({
              targets: flower,
              angle: { from: -2, to: 2 },
              duration: 900 + (Math.abs(seed) % 5) * 90,
              yoyo: true,
              repeat: -1,
              ease: 'Sine.inOut',
            })
          }
          return flower
        }

        private drawZenInterior() {
          const widthInTiles = 32
          const heightInTiles = 24
          this.worldWidth = widthInTiles * TILE
          this.worldHeight = heightInTiles * TILE
          const data = Array.from({ length: heightInTiles }, (_, y) =>
            Array.from({ length: widthInTiles }, (_, x) =>
              x <= 1 ||
              y <= 1 ||
              x >= widthInTiles - 2 ||
              y >= heightInTiles - 2
                ? 1
                : (x * 5 + y * 3) % 19 === 0
                  ? 1
                  : 0,
            ),
          )
          this.addTileLayer(data, 'garden-ground')

          const veil = this.add
            .rectangle(
              this.worldWidth / 2,
              this.worldHeight / 2,
              this.worldWidth,
              this.worldHeight,
              0x213b2b,
              0.22,
            )
            .setDepth(2)
          veil.setBlendMode(Phaser.BlendModes.MULTIPLY)

          const border = this.add.graphics().setDepth(5)
          border.lineStyle(6, 0x283f2d, 1).strokeRect(
            TILE,
            TILE,
            this.worldWidth - TILE * 2,
            this.worldHeight - TILE * 2,
          )
          border.lineStyle(2, 0xa4c683, 0.9).strokeRect(
            TILE + 6,
            TILE + 6,
            this.worldWidth - TILE * 2 - 12,
            this.worldHeight - TILE * 2 - 12,
          )

          this.addBlocker(this.worldWidth / 2, TILE + 3, this.worldWidth - TILE * 2, 8)
          this.addBlocker(
            this.worldWidth / 2,
            this.worldHeight - TILE - 3,
            this.worldWidth - TILE * 2,
            8,
          )
          this.addBlocker(TILE + 3, this.worldHeight / 2, 8, this.worldHeight - TILE * 2)
          this.addBlocker(
            this.worldWidth - TILE - 3,
            this.worldHeight / 2,
            8,
            this.worldHeight - TILE * 2,
          )

          const altarX = this.worldWidth / 2
          const altarY = 7 * TILE
          this.add
            .image(altarX, altarY, 'garden-temple-gate')
            .setScale(1.5)
            .setOrigin(0.5, 1)
            .setDepth(altarY)
          this.add
            .image(altarX, altarY + 20, 'garden-temple-steps')
            .setOrigin(0.5)
            .setDepth(altarY + 20)
          this.addBlocker(altarX, altarY - 10, 54, 30)

          for (const side of [-1, 1]) {
            this.add
              .image(altarX + side * 74, altarY + 22, 'garden-temple-pillar')
              .setOrigin(0.5, 1)
              .setDepth(altarY + 22)
            this.addFlower(altarX + side * 55, altarY + 34, 1200 + side * 37)
            this.addBlocker(altarX + side * 74, altarY + 7, 22, 28)
          }

          const pool = this.add.graphics().setDepth(6)
          pool.fillStyle(0x355c58, 0.92).fillEllipse(altarX, 13 * TILE, 112, 55)
          pool.lineStyle(3, 0x9fc3a4, 0.75).strokeEllipse(altarX, 13 * TILE, 112, 55)
          pool.lineStyle(1, 0xd3e7c1, 0.55).strokeEllipse(altarX, 13 * TILE, 64, 25)
          this.addBlocker(altarX, 13 * TILE, 106, 48)

          this.add
            .text(3 * TILE, 2.5 * TILE, 'ZEN MODE', {
              fontFamily: UI_FONT,
              fontSize: '15px',
              fontStyle: '700',
              color: '#f4f6ef',
              backgroundColor: '#171914',
              padding: { x: 8, y: 5 },
              resolution: renderScale,
            })
            .setDepth(70)
          this.add
            .text(3 * TILE, 4.7 * TILE, 'Notifications are paused while you are here', {
              fontFamily: UI_FONT,
              fontSize: '8px',
              color: '#d7dfd0',
              backgroundColor: '#171914',
              padding: { x: 6, y: 3 },
              resolution: renderScale,
            })
            .setDepth(70)
        }

        private drawInterior() {
          const widthInTiles = 32
          const heightInTiles = 24
          this.worldWidth = widthInTiles * TILE
          this.worldHeight = heightInTiles * TILE
          const data = Array.from({ length: heightInTiles }, (_, y) =>
            Array.from({ length: widthInTiles }, (_, x) =>
              x === 0 || y === 0 || x === widthInTiles - 1 || y === heightInTiles - 1
                ? 2
                : (x + y) % 9 === 0
                  ? 1
                  : 0,
            ),
          )
          this.addTileLayer(data, 'garden-interior-ground')

          const border = this.add.graphics().setDepth(4)
          border.lineStyle(6, 0x486c4d, 1).strokeRect(
            TILE,
            TILE,
            this.worldWidth - TILE * 2,
            this.worldHeight - TILE * 2,
          )
          border.lineStyle(2, 0x243d2a, 1).strokeRect(
            TILE + 5,
            TILE + 5,
            this.worldWidth - TILE * 2 - 10,
            this.worldHeight - TILE * 2 - 10,
          )

          this.addBlocker(this.worldWidth / 2, TILE + 3, this.worldWidth - TILE * 2, 8)
          this.addBlocker(
            this.worldWidth / 2,
            this.worldHeight - TILE - 3,
            this.worldWidth - TILE * 2,
            8,
          )
          this.addBlocker(TILE + 3, this.worldHeight / 2, 8, this.worldHeight - TILE * 2)
          this.addBlocker(
            this.worldWidth - TILE - 3,
            this.worldHeight / 2,
            8,
            this.worldHeight - TILE * 2,
          )

          const room = map.rooms.find((candidate) => candidate.channel_id === channelId)
          const roomName = room?.name ?? 'Garden room'
          this.add
            .text(3 * TILE, 2.25 * TILE, labelFor(roomName), {
              fontFamily: UI_FONT,
              fontSize: '15px',
              fontStyle: '700',
              color: textCss,
              backgroundColor: panelCss,
              padding: { x: 8, y: 5 },
              resolution: renderScale,
            })
            .setDepth(60)
          this.add
            .text(3 * TILE, 4.5 * TILE, 'Room audio follows where people gather', {
              fontFamily: UI_FONT,
              fontSize: '9px',
              color: textDimCss,
              backgroundColor: panelCss,
              padding: { x: 6, y: 3 },
              resolution: renderScale,
            })
            .setDepth(60)

          this.drawMeetingTable(16 * TILE, 13 * TILE)
          const crates: Array<[number, number]> = [
            [5, 8],
            [6, 8],
            [26, 7],
            [27, 7],
          ]
          crates.forEach(([x, y]) => {
            this.add.image(x * TILE, y * TILE, 'garden-crate').setDepth(y * TILE)
            this.addBlocker(x * TILE, y * TILE, 24, 20)
          })
          const pots: Array<[number, number]> = [
            [4, 20],
            [28, 20],
          ]
          pots.forEach(([x, y], index) => {
            this.add.image(x * TILE, y * TILE, 'garden-pot').setDepth(y * TILE)
            this.addFlower(x * TILE, y * TILE - 12, 500 + index * 311)
            this.addBlocker(x * TILE, y * TILE, 18, 15)
          })
        }

        private drawMeetingTable(x: number, y: number) {
          const table = this.add.graphics().setDepth(y)
          table.fillStyle(0x4b2b22).fillRect(x - 74, y - 29, 148, 58)
          table.fillStyle(0xa8653f).fillRect(x - 70, y - 25, 140, 50)
          table.fillStyle(0xd28a4d).fillRect(x - 65, y - 20, 130, 5)
          table.fillStyle(0x34201c).fillRect(x - 56, y + 25, 10, 16)
          table.fillStyle(0x34201c).fillRect(x + 46, y + 25, 10, 16)
          this.addBlocker(x, y, 148, 58)

          const chairs: Array<[number, number]> = [
            [-54, -49],
            [0, -49],
            [54, -49],
            [-54, 49],
            [0, 49],
            [54, 49],
          ]
          chairs.forEach(([offsetX, offsetY]) => {
            const chair = this.add.graphics().setDepth(y + offsetY)
            chair.fillStyle(0x3b251f).fillRect(x + offsetX - 9, y + offsetY - 8, 18, 16)
            chair.fillStyle(0x7b4932).fillRect(x + offsetX - 7, y + offsetY - 6, 14, 12)
            this.addBlocker(x + offsetX, y + offsetY, 18, 16)
          })
        }

        private addBlocker(x: number, y: number, width: number, height: number) {
          const blocker = this.add.rectangle(x, y, width, height, 0x000000, 0)
          this.blockers.add(blocker)
          return blocker
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
          arcade: {
            gravity: { x: 0, y: 0 },
            debug: false,
          },
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
      nearbyRef.current(null)
      nearbyTempleRef.current(false)
      resizeObserver?.disconnect()
      unsubscribe?.()
      game?.destroy(true)
      host.replaceChildren()
    }
  }, [channelId, map, space, themeRevision, zenMode])

  return (
    <div
      ref={hostRef}
      className="h-full w-full bg-ink [&>canvas]:block"
      role="application"
      aria-label="Garden spatial map. Use arrow keys or WASD to move, Space to jump, tap a destination, Enter to interact, R to create a room, and Escape to exit."
    />
  )
}
