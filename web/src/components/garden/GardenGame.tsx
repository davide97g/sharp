import { useEffect, useRef, useState } from 'react'
import type { GardenMap, GardenPeer, GardenRoom } from '../../lib/types'
import { useStore } from '../../store'

const UNIT = 18
const SPEED = 7
const SEND_EVERY_MS = 100
const EMOJI_FONT = '"Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif'
const UI_FONT = 'Inter, ui-sans-serif, system-ui, sans-serif'
const PEOPLE = ['🧑‍💻', '👩‍💻', '🧑‍🎨', '👨‍🚀', '🧑‍🔬', '👩‍🚀', '🧑‍🚀']

type Props = {
  map: GardenMap
  space: 'hub' | 'room'
  channelId: string | null
  onNearbyRoom: (room: GardenRoom | null) => void
}

type Point = { x: number; y: number }

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

function personFor(name: string) {
  return PEOPLE[hashName(name) % PEOPLE.length]
}

function roomEmoji(variant: GardenRoom['room_variant']) {
  if (variant === 'greenhouse') return '🏡'
  if (variant === 'orchard') return '🏠'
  if (variant === 'pond') return '🛖'
  return '🏘️'
}

export function GardenGame({ map, space, channelId, onNearbyRoom }: Props) {
  const hostRef = useRef<HTMLDivElement>(null)
  const nearbyRef = useRef(onNearbyRoom)
  const [themeRevision, setThemeRevision] = useState(0)
  nearbyRef.current = onNearbyRoom

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
        panel2: numeric('--color-panel-2'),
        border: numeric('--color-border'),
        borderSoft: numeric('--color-border-soft'),
        accent: numeric('--color-accent'),
        accentHover: numeric('--color-accent-hover'),
        accentSoft: numeric('--color-accent-soft'),
        text: numeric('--color-text'),
        textDim: numeric('--color-text-dim'),
        textFaint: numeric('--color-text-faint'),
        success: numeric('--color-presence-online'),
      }
      const inkCss = css('--color-ink')
      const panelCss = css('--color-panel')
      const textCss = css('--color-text')
      const textDimCss = css('--color-text-dim')
      const accentCss = css('--color-accent')

      type Avatar = {
        node: import('phaser').GameObjects.Container
        person: import('phaser').GameObjects.Text
        targetX: number
        targetY: number
        moving: boolean
      }

      class GardenScene extends Phaser.Scene {
        private player!: Avatar
        private remotes = new Map<string, Avatar>()
        private cursors!: import('phaser').Types.Input.Keyboard.CursorKeys
        private wasd!: Record<'W' | 'A' | 'S' | 'D', import('phaser').Input.Keyboard.Key>
        private target: Point | null = null
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
          const startX = (self?.x ?? map.spawn.x) * UNIT
          const startY = (self?.y ?? map.spawn.y) * UNIT
          this.player = this.makeAvatar(
            startX,
            startY,
            useStore.getState().me?.display_name ?? 'You',
            true,
          )

          this.cursors = this.input.keyboard!.createCursorKeys()
          this.wasd = this.input.keyboard!.addKeys('W,A,S,D') as typeof this.wasd
          this.input.on('pointerdown', (pointer: import('phaser').Input.Pointer) => {
            this.target = { x: pointer.worldX, y: pointer.worldY }
          })
          const walkToRoom = (event: Event) => {
            const room = (event as CustomEvent<GardenRoom>).detail
            this.target = { x: room.door_x * UNIT, y: room.door_y * UNIT }
          }
          window.addEventListener('sharp:garden-walk-to', walkToRoom)
          this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
            window.removeEventListener('sharp:garden-walk-to', walkToRoom)
          })

          if (space === 'hub') {
            this.cameras.main.setBounds(0, 0, this.worldWidth, this.worldHeight)
            this.cameras.main.startFollow(this.player.node, true, 0.1, 0.1)
          }
          const setZoom = () => {
            const logicalWidth = this.scale.width / renderScale
            if (space === 'room') {
              const fit = Math.min(
                this.scale.width / this.worldWidth,
                this.scale.height / this.worldHeight,
              )
              this.cameras.main.setZoom(fit * 0.92)
              this.cameras.main.centerOn(this.worldWidth / 2, this.worldHeight / 2)
              return
            }
            const zoom = logicalWidth < 620 ? 1 : logicalWidth < 1000 ? 0.9 : 0.78
            this.cameras.main.setZoom(zoom * renderScale)
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
                  peer.x * UNIT,
                  peer.y * UNIT,
                  peer.display_name,
                  false,
                )
                this.remotes.set(connId, avatar)
              }
              avatar.targetX = peer.x * UNIT
              avatar.targetY = peer.y * UNIT
              avatar.moving = peer.moving
              this.faceAvatar(avatar, peer.facing)
            }
            for (const [connId, avatar] of this.remotes) {
              if (present.has(connId)) continue
              avatar.node.destroy(true)
              this.remotes.delete(connId)
            }
            const authoritative = state.garden.self
            if (authoritative && this.player) {
              const dx = authoritative.x * UNIT - this.player.node.x
              const dy = authoritative.y * UNIT - this.player.node.y
              if (Math.hypot(dx, dy) > UNIT * 2.25) {
                this.player.node.setPosition(authoritative.x * UNIT, authoritative.y * UNIT)
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

          let facing: GardenPeer['facing'] =
            useStore.getState().garden.self?.facing ?? 'down'
          const moving = dx !== 0 || dy !== 0
          if (moving) {
            const length = Math.hypot(dx, dy)
            dx /= length
            dy /= length
            const distance = SPEED * UNIT * (delta / 1000)
            const minX = 2 * UNIT
            const maxX = (space === 'hub' ? 102 : 30) * UNIT
            const minY = 2 * UNIT
            const maxY = (space === 'hub' ? this.worldHeight / UNIT - 2 : 22) * UNIT
            this.player.node.x = Phaser.Math.Clamp(this.player.node.x + dx * distance, minX, maxX)
            this.player.node.y = Phaser.Math.Clamp(this.player.node.y + dy * distance, minY, maxY)
            facing = Math.abs(dx) > Math.abs(dy) ? (dx < 0 ? 'left' : 'right') : dy < 0 ? 'up' : 'down'
            this.faceAvatar(this.player, facing)
          }
          this.player.moving = moving
          this.animateAvatar(this.player, time)
          this.player.node.setDepth(this.player.node.y + 100)

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
                this.player.node.x / UNIT,
                this.player.node.y / UNIT,
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
          const x = this.player.node.x / UNIT
          const y = this.player.node.y / UNIT
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
          const shadow = this.add.ellipse(0, 4, 34, 13, palette.ink, 0.32)
          const halo = this.add
            .ellipse(0, 2, 43, 28, palette.accent, self ? 0.18 : 0)
            .setStrokeStyle(self ? 2 : 0, palette.accent, self ? 0.72 : 0)
          const person = this.add
            .text(0, -13, self ? '🧑‍💻' : personFor(name), {
              fontFamily: EMOJI_FONT,
              fontSize: self ? '31px' : '29px',
              resolution: renderScale,
            })
            .setOrigin(0.5, 0.65)
          const presence = this.add.circle(13, -2, 4, palette.success).setStrokeStyle(2, palette.panel)
          const label = this.add
            .text(0, -43, self ? 'You' : labelFor(name), {
              fontFamily: UI_FONT,
              fontSize: '11px',
              fontStyle: '600',
              color: textCss,
              backgroundColor: panelCss,
              padding: { x: 7, y: 4 },
              resolution: renderScale,
            })
            .setOrigin(0.5)
          const node = this.add.container(x, y, [shadow, halo, person, presence, label])
          node.setDepth(y + 100)
          return { node, person, targetX: x, targetY: y, moving: false }
        }

        private faceAvatar(avatar: Avatar, facing: GardenPeer['facing']) {
          avatar.person.setScale(facing === 'left' ? -1 : 1, 1)
          avatar.person.setAlpha(facing === 'up' ? 0.82 : 1)
        }

        private animateAvatar(avatar: Avatar, time: number) {
          if (this.reducedMotion || !avatar.moving) {
            avatar.person.y = -13
            return
          }
          avatar.person.y = -13 - Math.abs(Math.sin(time / 115)) * 2
        }

        private drawWorld() {
          if (space === 'room') this.drawInterior()
          else this.drawHub()
        }

        private drawHub() {
          const maxDoorY = Math.max(78, ...map.rooms.map((room) => room.door_y))
          this.worldWidth = 104 * UNIT
          this.worldHeight = Math.max(96, maxDoorY + 16) * UNIT
          const ground = this.add.graphics()
          ground.fillStyle(palette.ink).fillRect(0, 0, this.worldWidth, this.worldHeight)
          ground.fillStyle(palette.panel, 0.7).fillRoundedRect(
            2 * UNIT,
            2 * UNIT,
            this.worldWidth - 4 * UNIT,
            this.worldHeight - 4 * UNIT,
            34,
          )
          ground.lineStyle(1, palette.borderSoft, 0.7)
          ground.strokeRoundedRect(
            2 * UNIT,
            2 * UNIT,
            this.worldWidth - 4 * UNIT,
            this.worldHeight - 4 * UNIT,
            34,
          )
          for (let y = 5; y < this.worldHeight / UNIT; y += 6) {
            for (let x = 4 + ((y / 6) % 2) * 3; x < 103; x += 6) {
              ground.fillStyle(palette.borderSoft, 0.34)
              ground.fillCircle(x * UNIT, y * UNIT, 1.5)
            }
          }

          const plaza = { x: 52 * UNIT, y: 64 * UNIT }
          for (const room of map.rooms) {
            const door = { x: room.door_x * UNIT, y: room.door_y * UNIT }
            this.drawPath([
              door,
              { x: door.x, y: plaza.y },
              plaza,
            ])
          }
          this.drawCourtyard(plaza.x, plaza.y)
          map.rooms.forEach((room) => this.drawPavilion(room))
          this.drawOutdoorAssets()
        }

        private drawPath(points: Point[]) {
          const path = this.add.graphics().setDepth(8)
          const drawLine = (width: number, color: number, alpha: number) => {
            path.lineStyle(width, color, alpha)
            path.beginPath()
            path.moveTo(points[0].x, points[0].y)
            for (const point of points.slice(1)) path.lineTo(point.x, point.y)
            path.strokePath()
            for (const point of points) {
              path.fillStyle(color, alpha).fillCircle(point.x, point.y, width / 2)
            }
          }
          drawLine(58, palette.border, 0.82)
          drawLine(52, palette.accentSoft, 0.72)
          path.lineStyle(1, palette.accent, 0.22)
          path.beginPath()
          path.moveTo(points[0].x, points[0].y)
          for (const point of points.slice(1)) path.lineTo(point.x, point.y)
          path.strokePath()
        }

        private drawCourtyard(x: number, y: number) {
          const plaza = this.add.graphics().setDepth(12)
          plaza.fillStyle(palette.panel2, 0.98).fillCircle(x, y, 104)
          plaza.lineStyle(3, palette.border, 1).strokeCircle(x, y, 104)
          plaza.lineStyle(1, palette.accent, 0.5).strokeCircle(x, y, 90)
          this.addEmoji(x, y - 10, '🌱', 40, y + 10)
          this.add
            .text(x, y + 38, 'Open courtyard', {
              fontFamily: UI_FONT,
              fontSize: '14px',
              fontStyle: '600',
              color: textCss,
              resolution: renderScale,
            })
            .setOrigin(0.5)
            .setDepth(y + 12)
          this.add
            .text(x, y + 59, 'Walk over to a room', {
              fontFamily: UI_FONT,
              fontSize: '11px',
              color: textDimCss,
              resolution: renderScale,
            })
            .setOrigin(0.5)
            .setDepth(y + 12)
        }

        private drawPavilion(room: GardenRoom) {
          const x = room.door_x * UNIT
          const y = room.door_y * UNIT
          const width = 12 * UNIT
          const height = 8.5 * UNIT
          const left = x - width / 2
          const top = y - height
          const card = this.add.graphics().setDepth(y - 14)
          card.fillStyle(palette.ink, 0.26).fillRoundedRect(left + 7, top + 9, width, height, 24)
          card.fillStyle(palette.panel, 0.98).fillRoundedRect(left, top, width, height, 24)
          card.lineStyle(2, palette.border, 1).strokeRoundedRect(left, top, width, height, 24)
          card.fillStyle(palette.accentSoft, 0.9).fillRoundedRect(
            left + 10,
            top + 10,
            width - 20,
            10,
            5,
          )
          card.fillStyle(palette.panel2, 1).fillRoundedRect(x - 28, y - 34, 56, 34, 15)
          card.lineStyle(2, palette.accent, 0.74).strokeRoundedRect(x - 28, y - 34, 56, 34, 15)

          this.addEmoji(x, top + 69, roomEmoji(room.room_variant), 48, y - 10)
          this.add
            .text(x, top + 114, labelFor(room.name), {
              fontFamily: UI_FONT,
              fontSize: '13px',
              fontStyle: '600',
              color: textCss,
              resolution: renderScale,
            })
            .setOrigin(0.5)
            .setDepth(y)
          this.add
            .text(
              x,
              top + 134,
              room.kind === 'private'
                ? 'Private room'
                : room.occupancy > 0
                  ? `${room.occupancy} here now`
                  : 'Open room',
              {
                fontFamily: UI_FONT,
                fontSize: '10px',
                fontStyle: '500',
                color: room.occupancy > 0 ? accentCss : textDimCss,
                resolution: renderScale,
              },
            )
            .setOrigin(0.5)
            .setDepth(y)

          if (room.occupancy > 0) {
            const badge = this.add.graphics().setDepth(y + 2)
            badge.fillStyle(palette.accent, 1).fillCircle(left + width - 18, top + 18, 13)
            this.add
              .text(left + width - 18, top + 18, String(room.occupancy), {
                fontFamily: UI_FONT,
                fontSize: '10px',
                fontStyle: '700',
                color: inkCss,
                resolution: renderScale,
              })
              .setOrigin(0.5)
              .setDepth(y + 3)
          }

          this.addEmoji(left - 18, y - 20, '🌳', 43, y - 2)
          this.addEmoji(left + width + 20, y - 9, room.plot_index % 2 ? '🌿' : '🌷', 24, y - 1)
        }

        private drawOutdoorAssets() {
          const maxY = this.worldHeight / UNIT
          for (let y = 10; y < maxY; y += 17) {
            this.addEmoji(4.4 * UNIT, y * UNIT, y % 2 ? '🌳' : '🌲', 52, y * UNIT)
            this.addEmoji(99.5 * UNIT, (y + 6) * UNIT, y % 2 ? '🌲' : '🌳', 46, (y + 6) * UNIT)
          }
          const assets: Array<[number, number, string, number]> = [
            [7, 59, '🌼', 18],
            [10, 62, '🌷', 24],
            [94, 47, '🪻', 20],
            [88, 70, '🪴', 31],
            [43, 69, '🪑', 29],
            [61, 70, '🪑', 26],
            [40, 61, '🧺', 24],
            [65, 60, '🌻', 28],
          ]
          for (const [x, y, emoji, size] of assets) {
            this.addEmoji(x * UNIT, y * UNIT, emoji, size, y * UNIT)
          }
        }

        private drawInterior() {
          this.worldWidth = 32 * UNIT
          this.worldHeight = 24 * UNIT
          const room = map.rooms.find((candidate) => candidate.channel_id === channelId)
          const roomName = room?.name ?? 'Garden room'
          const backdrop = this.add.graphics()
          backdrop.fillStyle(palette.ink).fillRect(0, 0, this.worldWidth, this.worldHeight)
          backdrop.fillStyle(palette.panel, 1).fillRoundedRect(
            UNIT,
            UNIT,
            30 * UNIT,
            22 * UNIT,
            32,
          )
          backdrop.lineStyle(2, palette.border, 1).strokeRoundedRect(
            UNIT,
            UNIT,
            30 * UNIT,
            22 * UNIT,
            32,
          )
          backdrop.fillStyle(palette.panel2, 1).fillRoundedRect(
            3 * UNIT,
            3 * UNIT,
            26 * UNIT,
            4 * UNIT,
            22,
          )
          backdrop.lineStyle(1, palette.border, 1).strokeRoundedRect(
            3 * UNIT,
            3 * UNIT,
            26 * UNIT,
            4 * UNIT,
            22,
          )
          backdrop.fillStyle(palette.panel2, 1).fillEllipse(16 * UNIT, 12.5 * UNIT, 12 * UNIT, 5 * UNIT)
          backdrop.lineStyle(2, palette.border, 1).strokeEllipse(16 * UNIT, 12.5 * UNIT, 12 * UNIT, 5 * UNIT)
          backdrop.fillStyle(palette.accentSoft, 0.9).fillRoundedRect(
            13 * UNIT,
            20.5 * UNIT,
            6 * UNIT,
            2.5 * UNIT,
            20,
          )
          backdrop.lineStyle(2, palette.accent, 0.64).strokeRoundedRect(
            13 * UNIT,
            20.5 * UNIT,
            6 * UNIT,
            2.5 * UNIT,
            20,
          )

          this.addEmoji(5.2 * UNIT, 5 * UNIT, roomEmoji(room?.room_variant ?? 'meadow'), 46, 6 * UNIT)
          this.add
            .text(8.2 * UNIT, 4.4 * UNIT, labelFor(roomName), {
              fontFamily: UI_FONT,
              fontSize: '18px',
              fontStyle: '600',
              color: textCss,
              resolution: renderScale,
            })
            .setOrigin(0, 0.5)
          this.add
            .text(8.2 * UNIT, 5.65 * UNIT, 'Room audio follows where people sit', {
              fontFamily: UI_FONT,
              fontSize: '11px',
              color: textDimCss,
              resolution: renderScale,
            })
            .setOrigin(0, 0.5)

          const furniture: Array<[number, number, string, number]> = [
            [9.5, 10.5, '🪑', 27],
            [16, 9.3, '🪑', 30],
            [22.5, 10.5, '🪑', 27],
            [10.5, 15, '🪑', 25],
            [21.5, 15, '🪑', 25],
            [4.2, 18.8, '🪴', 38],
            [27.8, 18.5, '🌿', 34],
            [5.2, 9.2, '🛋️', 42],
            [27, 8.8, '🗄️', 36],
          ]
          for (const [x, y, emoji, size] of furniture) {
            this.addEmoji(x * UNIT, y * UNIT, emoji, size, y * UNIT)
          }
          this.add
            .text(16 * UNIT, 12.5 * UNIT, 'shared table', {
              fontFamily: UI_FONT,
              fontSize: '11px',
              fontStyle: '600',
              color: textDimCss,
              resolution: renderScale,
            })
            .setOrigin(0.5)
            .setDepth(13 * UNIT)
        }

        private addEmoji(x: number, y: number, emoji: string, size: number, depth: number) {
          return this.add
            .text(x, y, emoji, {
              fontFamily: EMOJI_FONT,
              fontSize: `${size}px`,
              resolution: renderScale,
            })
            .setOrigin(0.5)
            .setDepth(depth)
        }
      }

      game = new Phaser.Game({
        type: Phaser.AUTO,
        parent: host,
        canvasStyle: 'display:block;width:100%;height:100%',
        backgroundColor: inkCss,
        antialias: true,
        pixelArt: false,
        roundPixels: false,
        scene: GardenScene,
        scale: {
          mode: Phaser.Scale.NONE,
          width: Math.max(1, Math.round(host.clientWidth * renderScale)),
          height: Math.max(1, Math.round(host.clientHeight * renderScale)),
        },
        render: { antialias: true, pixelArt: false, roundPixels: false },
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
  }, [channelId, map, space, themeRevision])

  return (
    <div
      ref={hostRef}
      className="h-full w-full bg-ink [&>canvas]:block"
      role="application"
      aria-label="Garden spatial map. Use arrow keys or WASD to move, tap a destination, Enter to enter a nearby room, and Escape to exit."
    />
  )
}
