import { useEffect, useRef } from 'react'
import type { GardenMap, GardenPeer, GardenRoom } from '../../lib/types'
import { useStore } from '../../store'

const TILE = 16
const SPEED = 7
const SEND_EVERY_MS = 100

type Props = {
  map: GardenMap
  space: 'hub' | 'room'
  channelId: string | null
  onNearbyRoom: (room: GardenRoom | null) => void
}

function labelFor(name: string) {
  return name.length > 18 ? `${name.slice(0, 17)}…` : name
}

export function GardenGame({ map, space, channelId, onNearbyRoom }: Props) {
  const hostRef = useRef<HTMLDivElement>(null)
  const nearbyRef = useRef(onNearbyRoom)
  nearbyRef.current = onNearbyRoom

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    let disposed = false
    let game: import('phaser').Game | null = null
    let unsubscribe: (() => void) | null = null

    void (async () => {
      const Phaser = await import('phaser')
      if (disposed || !hostRef.current) return
      const styles = getComputedStyle(document.documentElement)
      const css = (token: string) => styles.getPropertyValue(token).trim()
      const numeric = (token: string) => Number.parseInt(css(token).replace('#', ''), 16)
      const palette = {
        grass: numeric('--color-garden-grass'),
        grassLight: numeric('--color-garden-grass-light'),
        grassDark: numeric('--color-garden-grass-dark'),
        path: numeric('--color-garden-path'),
        pathEdge: numeric('--color-garden-path-edge'),
        water: numeric('--color-garden-water'),
        waterLight: numeric('--color-garden-water-light'),
        ink: numeric('--color-garden-ink'),
        cream: numeric('--color-garden-cream'),
        roof: numeric('--color-garden-roof'),
        roofDark: numeric('--color-garden-roof-dark'),
        timber: numeric('--color-garden-timber'),
        timberDark: numeric('--color-garden-timber-dark'),
        leaf: numeric('--color-garden-leaf'),
        leafLight: numeric('--color-garden-leaf-light'),
        flower: numeric('--color-garden-flower'),
        avatar: numeric('--color-garden-avatar'),
        avatarAlt: numeric('--color-garden-avatar-alt'),
        shadow: numeric('--color-garden-shadow'),
      }
      const creamCss = css('--color-garden-cream')
      const inkCss = css('--color-garden-ink')

      type Avatar = {
        node: import('phaser').GameObjects.Container
        body: import('phaser').GameObjects.Rectangle
        targetX: number
        targetY: number
      }

      class GardenScene extends Phaser.Scene {
        private player!: Avatar
        private remotes = new Map<string, Avatar>()
        private cursors!: import('phaser').Types.Input.Keyboard.CursorKeys
        private wasd!: Record<'W' | 'A' | 'S' | 'D', import('phaser').Input.Keyboard.Key>
        private target: { x: number; y: number } | null = null
        private seq = useStore.getState().garden.self?.seq ?? 0
        private lastSent = 0
        private wasMoving = false
        private lastFacing: GardenPeer['facing'] = 'down'
        private nearbyId: string | null = null
        private worldWidth = 0
        private worldHeight = 0
        private reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches

        constructor() {
          super('garden')
        }

        create() {
          this.drawWorld()
          const self = useStore.getState().garden.self
          const startX = (self?.x ?? map.spawn.x) * TILE
          const startY = (self?.y ?? map.spawn.y) * TILE
          this.player = this.makeAvatar(
            startX,
            startY,
            useStore.getState().me?.display_name ?? 'You',
            true,
          )

          this.cursors = this.input.keyboard!.createCursorKeys()
          this.wasd = this.input.keyboard!.addKeys('W,A,S,D') as typeof this.wasd
          this.input.on('pointerdown', (pointer: import('phaser').Input.Pointer) => {
            this.target = {
              x: pointer.worldX,
              y: pointer.worldY,
            }
          })
          const walkToRoom = (event: Event) => {
            const room = (event as CustomEvent<GardenRoom>).detail
            this.target = { x: room.door_x * TILE, y: room.door_y * TILE }
          }
          window.addEventListener('sharp:garden-walk-to', walkToRoom)
          this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
            window.removeEventListener('sharp:garden-walk-to', walkToRoom)
          })

          this.cameras.main.setBounds(0, 0, this.worldWidth, this.worldHeight)
          this.cameras.main.startFollow(this.player.node, true, 0.12, 0.12)
          const setZoom = () => {
            const width = this.scale.width
            this.cameras.main.setZoom(width < 620 ? 1.55 : width < 1000 ? 1.8 : 2)
          }
          this.scale.on('resize', setZoom)
          setZoom()

          let lastPeers: ReturnType<typeof useStore.getState>['garden']['peers'] | null = null
          let lastSelf: GardenPeer | null = null
          const sync = (state: ReturnType<typeof useStore.getState>) => {
            if (!state.garden.active) return
            if (state.garden.peers === lastPeers && state.garden.self === lastSelf) return
            lastPeers = state.garden.peers
            lastSelf = state.garden.self
            const present = new Set(Object.keys(state.garden.peers))
            for (const [connId, peer] of Object.entries(state.garden.peers)) {
              let avatar = this.remotes.get(connId)
              if (!avatar) {
                avatar = this.makeAvatar(
                  peer.x * TILE,
                  peer.y * TILE,
                  peer.display_name,
                  false,
                )
                this.remotes.set(connId, avatar)
              }
              avatar.targetX = peer.x * TILE
              avatar.targetY = peer.y * TILE
            }
            for (const [connId, avatar] of this.remotes) {
              if (present.has(connId)) continue
              avatar.node.destroy(true)
              this.remotes.delete(connId)
            }
            const authoritative = state.garden.self
            if (authoritative && this.player) {
              const dx = authoritative.x * TILE - this.player.node.x
              const dy = authoritative.y * TILE - this.player.node.y
              if (Math.hypot(dx, dy) > TILE * 2.25) {
                this.player.node.setPosition(authoritative.x * TILE, authoritative.y * TILE)
                this.target = null
              }
              this.seq = Math.max(this.seq, authoritative.seq)
            }
          }
          sync(useStore.getState())
          unsubscribe = useStore.subscribe(sync)
        }

        update(_time: number, delta: number) {
          if (!this.player) return
          const activeElement = document.activeElement
          const typing =
            activeElement instanceof HTMLInputElement ||
            activeElement instanceof HTMLTextAreaElement ||
            activeElement?.getAttribute('contenteditable') === 'true'
          let dx = 0
          let dy = 0
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
            if (Math.hypot(tx, ty) < 4) this.target = null
            else {
              dx = tx
              dy = ty
            }
          }

          let facing: GardenPeer['facing'] =
            useStore.getState().garden.self?.facing ?? 'down'
          const moving = dx !== 0 || dy !== 0
          if (moving) {
            const length = Math.hypot(dx, dy)
            dx /= length
            dy /= length
            const distance = SPEED * TILE * (delta / 1000)
            const minX = 2 * TILE
            const maxX = (space === 'hub' ? 102 : 30) * TILE
            const minY = 2 * TILE
            const maxY = (space === 'hub' ? this.worldHeight / TILE - 2 : 22) * TILE
            this.player.node.x = Phaser.Math.Clamp(this.player.node.x + dx * distance, minX, maxX)
            this.player.node.y = Phaser.Math.Clamp(this.player.node.y + dy * distance, minY, maxY)
            facing = Math.abs(dx) > Math.abs(dy) ? (dx < 0 ? 'left' : 'right') : dy < 0 ? 'up' : 'down'
            this.player.body.setFillStyle(facing === 'up' ? palette.avatarAlt : palette.avatar)
          }
          this.player.node.setDepth(this.player.node.y)

          const now = performance.now()
          if (
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
            avatar.node.setDepth(avatar.node.y)
          }
          this.updateNearby()
        }

        private updateNearby() {
          if (space !== 'hub') {
            if (this.nearbyId !== null) {
              this.nearbyId = null
              nearbyRef.current(null)
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
          if (nextId === this.nearbyId) return
          this.nearbyId = nextId
          nearbyRef.current(nearest)
        }

        private makeAvatar(x: number, y: number, name: string, self: boolean): Avatar {
          const shadow = this.add.ellipse(0, 5, 11, 5, palette.shadow, 0.36)
          const legs = this.add.rectangle(0, 1, 7, 7, self ? palette.avatar : palette.avatarAlt)
          const body = this.add.rectangle(0, -5, 9, 9, self ? palette.avatar : palette.avatarAlt)
          const face = this.add.rectangle(0, -11, 7, 6, palette.cream)
          const hair = this.add.rectangle(0, -14, 9, 3, palette.ink)
          const label = this.add
            .text(0, -23, self ? 'YOU' : labelFor(name), {
              fontFamily: 'ui-sans-serif, system-ui, sans-serif',
              fontSize: self ? '6px' : '7px',
              fontStyle: '700',
              color: creamCss,
              backgroundColor: `${inkCss}dd`,
              padding: { x: 3, y: 1 },
            })
            .setOrigin(0.5)
          const node = this.add.container(x, y, [shadow, legs, body, face, hair, label])
          node.setDepth(y)
          return { node, body, targetX: x, targetY: y }
        }

        private drawWorld() {
          if (space === 'room') this.drawInterior()
          else this.drawHub()
        }

        private drawHub() {
          const maxDoorY = Math.max(78, ...map.rooms.map((room) => room.door_y))
          this.worldWidth = 104 * TILE
          this.worldHeight = Math.max(96, maxDoorY + 16) * TILE
          const ground = this.add.graphics()
          ground.fillStyle(palette.grass).fillRect(0, 0, this.worldWidth, this.worldHeight)
          for (let y = 1; y < this.worldHeight / TILE; y += 3) {
            for (let x = (y * 7) % 5; x < 104; x += 7) {
              ground.fillStyle((x + y) % 2 ? palette.grassLight : palette.grassDark, 0.32)
              ground.fillRect(x * TILE + 3, y * TILE + 5, 3, 3)
            }
          }

          const paths = this.add.graphics()
          const plazaX = 52 * TILE
          const plazaY = 64 * TILE
          paths.fillStyle(palette.pathEdge).fillRoundedRect(plazaX - 8 * TILE, plazaY - 5 * TILE, 16 * TILE, 10 * TILE, 10)
          paths.fillStyle(palette.path).fillRoundedRect(plazaX - 7.5 * TILE, plazaY - 4.5 * TILE, 15 * TILE, 9 * TILE, 8)
          for (const room of map.rooms) {
            const x = room.door_x * TILE
            const y = room.door_y * TILE
            paths.lineStyle(5 * TILE, palette.pathEdge, 1)
            paths.beginPath().moveTo(x, y).lineTo(x, plazaY).lineTo(plazaX, plazaY).strokePath()
            paths.lineStyle(4 * TILE, palette.path, 1)
            paths.beginPath().moveTo(x, y).lineTo(x, plazaY).lineTo(plazaX, plazaY).strokePath()
          }
          this.drawPond(5 * TILE, 67 * TILE)
          this.drawPond(89 * TILE, 50 * TILE)
          map.rooms.forEach((room) => this.drawHouse(room))
          for (let y = 7; y < this.worldHeight / TILE; y += 16) {
            this.drawTree(5 * TILE, y * TILE)
            this.drawTree(99 * TILE, (y + 6) * TILE)
          }
          this.add
            .text(plazaX, plazaY - 10, 'SHARP GARDEN', {
              fontFamily: 'ui-monospace, monospace',
              fontSize: '8px',
              fontStyle: '700',
              color: inkCss,
            })
            .setOrigin(0.5)
            .setDepth(plazaY)
        }

        private drawHouse(room: GardenRoom) {
          const x = room.door_x * TILE
          const y = room.door_y * TILE
          const g = this.add.graphics().setDepth(y - TILE)
          const roof =
            room.room_variant === 'greenhouse'
              ? palette.water
              : room.room_variant === 'orchard'
                ? palette.leaf
                : room.room_variant === 'pond'
                  ? palette.water
                  : palette.roof
          g.fillStyle(palette.shadow, 0.28).fillRect(x - 6 * TILE + 4, y - 8 * TILE + 7, 12 * TILE, 8 * TILE)
          g.fillStyle(palette.timber).fillRect(x - 5 * TILE, y - 6 * TILE, 10 * TILE, 6 * TILE)
          g.fillStyle(palette.timberDark).fillRect(x - TILE, y - 3 * TILE, 2 * TILE, 3 * TILE)
          g.fillStyle(palette.cream).fillRect(x - 3.5 * TILE, y - 4.5 * TILE, 2 * TILE, 1.5 * TILE)
          g.fillStyle(palette.cream).fillRect(x + 1.5 * TILE, y - 4.5 * TILE, 2 * TILE, 1.5 * TILE)
          g.fillStyle(roof).fillTriangle(x - 6 * TILE, y - 6 * TILE, x, y - 10 * TILE, x + 6 * TILE, y - 6 * TILE)
          g.fillStyle(palette.roofDark).fillRect(x - 6 * TILE, y - 6 * TILE, 12 * TILE, TILE)
          if (room.kind === 'private') {
            g.fillStyle(palette.ink).fillRect(x + 3.8 * TILE, y - 8.4 * TILE, 9, 8)
            g.fillStyle(palette.cream).fillRect(x + 4 * TILE, y - 8.15 * TILE, 5, 4)
          }
          this.add
            .text(x, y - 10.8 * TILE, labelFor(room.name), {
              fontFamily: 'ui-sans-serif, system-ui, sans-serif',
              fontSize: '8px',
              fontStyle: '700',
              color: inkCss,
              backgroundColor: `${creamCss}ee`,
              padding: { x: 4, y: 2 },
            })
            .setOrigin(0.5)
            .setDepth(y)
          if (room.occupancy > 0) {
            this.add
              .text(x + 5.2 * TILE, y - 6.3 * TILE, String(room.occupancy), {
                fontFamily: 'ui-monospace, monospace',
                fontSize: '7px',
                fontStyle: '700',
                color: creamCss,
                backgroundColor: inkCss,
                padding: { x: 3, y: 2 },
              })
              .setOrigin(0.5)
              .setDepth(y)
          }
        }

        private drawInterior() {
          this.worldWidth = 32 * TILE
          this.worldHeight = 24 * TILE
          const room = map.rooms.find((candidate) => candidate.channel_id === channelId)
          const g = this.add.graphics()
          g.fillStyle(palette.ink).fillRect(0, 0, this.worldWidth, this.worldHeight)
          g.fillStyle(palette.timberDark).fillRect(TILE, TILE, 30 * TILE, 22 * TILE)
          for (let y = 2; y < 22; y += 2) {
            g.fillStyle(y % 4 ? palette.timber : palette.pathEdge)
            g.fillRect(2 * TILE, y * TILE, 28 * TILE, 2 * TILE)
          }
          g.fillStyle(palette.pathEdge).fillRect(13 * TILE, 18 * TILE, 6 * TILE, 4 * TILE)
          g.fillStyle(palette.ink).fillRect(15 * TILE, 21 * TILE, 2 * TILE, 2 * TILE)
          g.fillStyle(palette.cream).fillRect(5 * TILE, 5 * TILE, 7 * TILE, 4 * TILE)
          g.fillStyle(palette.cream).fillRect(20 * TILE, 5 * TILE, 7 * TILE, 4 * TILE)
          this.drawTree(4 * TILE, 19 * TILE)
          this.drawTree(28 * TILE, 19 * TILE)
          this.add
            .text(16 * TILE, 2.2 * TILE, room?.name ?? 'Garden room', {
              fontFamily: 'ui-sans-serif, system-ui, sans-serif',
              fontSize: '11px',
              fontStyle: '700',
              color: inkCss,
              backgroundColor: creamCss,
              padding: { x: 7, y: 4 },
            })
            .setOrigin(0.5)
        }

        private drawTree(x: number, y: number) {
          const g = this.add.graphics().setDepth(y)
          g.fillStyle(palette.timberDark).fillRect(x - 3, y - 11, 6, 13)
          g.fillStyle(palette.leaf).fillRect(x - 11, y - 25, 22, 17)
          g.fillStyle(palette.leafLight).fillRect(x - 7, y - 29, 14, 7)
          g.fillStyle(palette.flower).fillRect(x + 7, y - 20, 3, 3)
        }

        private drawPond(x: number, y: number) {
          const g = this.add.graphics()
          g.fillStyle(palette.pathEdge).fillEllipse(x, y, 12 * TILE, 8 * TILE)
          g.fillStyle(palette.water).fillEllipse(x, y, 11 * TILE, 7 * TILE)
          g.fillStyle(palette.waterLight, 0.75).fillRect(x - 3 * TILE, y - TILE, 3 * TILE, 3)
        }
      }

      game = new Phaser.Game({
        type: Phaser.AUTO,
        parent: host,
        backgroundColor: inkCss,
        pixelArt: true,
        roundPixels: true,
        antialias: false,
        scene: GardenScene,
        scale: {
          mode: Phaser.Scale.RESIZE,
          width: '100%',
          height: '100%',
        },
        render: { antialias: false, pixelArt: true, roundPixels: true },
      })
    })()

    return () => {
      disposed = true
      unsubscribe?.()
      game?.destroy(true)
      host.replaceChildren()
    }
  }, [channelId, map, space])

  return (
    <div
      ref={hostRef}
      className="h-full w-full bg-[var(--color-ink)] [&>canvas]:block"
      role="application"
      aria-label="Garden map. Use arrow keys or WASD to walk, or tap a destination."
    />
  )
}
