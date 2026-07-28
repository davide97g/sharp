# Ninja Adventure Garden assets

The PNG files in this folder are selected from Pixel-Boy and AAA's **Ninja Adventure
Asset Pack**.

- Source: <https://pixel-boy.itch.io/ninja-adventure-asset-pack>
- Source repository: <https://github.com/pixel-boy/NinjaAdventure>
- Pack revision: the itch.io **Ninja Adventure - Asset Pack.zip** download, whose bundled
  `LICENSE.txt` is CC0 1.0 Universal and whose `README.md` credits
  [Pixel-boy](https://pixel-boy.itch.io/) and
  [AAA](https://www.instagram.com/challenger.aaa/?hl=fr).
- License: [Creative Commons Zero v1.0 Universal](https://creativecommons.org/publicdomain/zero/1.0/)

The creators state that all assets in the package may be used in free or commercial
games and that attribution is not required. Attribution is retained here as a thank
you and to preserve provenance.

Sharp uses only original Ninja Adventure artwork. No Pokémon or Nintendo artwork,
maps, names, code, or extracted game data is included.

> The upstream **GitHub repository is the demo game**, not the asset pack: revision
> `6ac78232d5aedcc85ce5f27d060ea92366f7c24a` contains only three humanoid character
> sheets. The roster below therefore comes from the itch.io pack download. Do not expect
> to re-fetch these from a git revision.

## Character sheets

Every sheet is **64x112** — 4 columns (facing: down, up, left, right) x 7 rows of 16px
frames. `DIRECTION_COLUMN` and the `row * 4 + column` frame math in
`web/src/components/garden/GardenGame.tsx` depend on that geometry, so a sheet of any
other size renders wrong.

Portraits in `faceset/` are the pack's matching `Faceset.png`, **38x38**, used by the
avatar picker (no Phaser involved).

| Local file | Pack source (`Actor/Character/…`) |
| --- | --- |
| `avatar_samurai.png` | `SamuraiBlue/SpriteSheet.png` |
| `avatar_scout.png` | `CamouflageGreen/SpriteSheet.png` |
| `avatar_ninja.png` | `NinjaBlue/SpriteSheet.png` |
| `avatar_monk.png` | `Monk/SpriteSheet.png` |
| `avatar_knight.png` | `Knight/SpriteSheet.png` |
| `avatar_hunter.png` | `Hunter/SpriteSheet.png` |
| `avatar_royal.png` | `Princess/SpriteSheet.png` |
| `avatar_noble.png` | `Noble/SpriteSheet.png` |
| `avatar_explorer.png` | `Eskimo/SpriteSheet.png` |
| `avatar_villager.png` | `Villager3/SpriteSheet.png` |
| `avatar_florist.png` | `Woman/SpriteSheet.png` |
| `avatar_mage.png` | `SorcererBlack/SpriteSheet.png` |

Local names are **stable slugs**, deliberately decoupled from the upstream folder names:
they are persisted in `user_prefs.garden_avatar`, so renaming one would silently break an
existing user's stored choice. They are also neutral by design — the upstream folder name
is recorded here for provenance and is never shown in the UI.

The roster list lives in `web/src/components/garden/gardenAvatars.ts` and is mirrored by
`GARDEN_AVATARS` in `server/src/ws/garden.rs`. Adding a character means adding the two
image files, the two list entries, and a row above.

`avatar_samurai.png` and `avatar_ninja.png` are the files previously committed as
`avatar_blue.png` and `avatar_ninja.png`; `avatar_scout.png` is the former
`avatar_green.png`. Bytes are unchanged — only the names are.

## Tilesets

| Local file | Pack source (`Backgrounds/Tilesets/…`) | Used for |
| --- | --- | --- |
| `tileset_floor.png` | `TilesetFloor.png` | ground terrain; 8 autotile blocks on an 11x7 tile pitch |
| `tileset_water.png` | `TilesetWater.png` | water with **grass / sand / snow / stone shore** transitions, plus wooden docks |
| `tileset_nature.png` | `TilesetNature.png` | trees (4 seasons), bushes, stumps, logs, flowers, mushrooms, boulders, signposts |
| `tileset_house.png` | `TilesetHouse.png` | buildings (huts, dojo, torii, pagoda, cave, igloo, stump house), stalls, fences, lanterns |
| `tileset_village.png` | `TilesetVillageAbandoned.png` | the original house and tree crops |
| `tileset_interior_floor.png` | `Interior/TilesetInteriorFloor.png` | room interiors |
| `tileset_floor_detail.png` | `TilesetFloorDetail.png` | ground detail overlays |
| `tileset_field.png` | `TilesetField.png` | crops and farm rows |

`tileset_water.png` matters for terrain: it carries water edges baked against several
different shore materials, so grass-to-water transitions come from hand-drawn art rather
than from generated masks.

## Hand-cropped derivatives

These were cut from larger pack sheets and are not byte-identical to any single upstream
file, so they have no direct source row:

`avatar_shadow.png` (12x8), `crate.png` (14x15), `pot.png` (14x16), and
`flower_dance.png` (64x64, a 4-frame 16px animation strip).
